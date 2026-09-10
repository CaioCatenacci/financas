import { neon } from "@neondatabase/serverless";
import { criarDb } from "./db.js";
import { parseUpdate, downloadArquivo, responder, enviarConfirmacao } from "./telegram.js";
import { extrair, callGeminiHTTP, callClaudeHTTP } from "./extrair.js";
import { subirDropbox } from "./dropbox.js";
import { caminhoDropbox, nomeArquivo } from "./dropbox_nome.js";
import { centsToBR } from "./money.js";
import { tokenValido, segredoTelegramValido, chatPermitido } from "./auth.js";
import { normalizarChave, normalizarNome, derivarChave } from "./contraparte.js";
import { parseAprender } from "./teach.js";
import { resolverCategoria, catalogoParaLista, nomesDeCategoria } from "./categorias.js";
import { parseLancamentoTexto } from "./texto.js";
import { montarPreviewExtrato, montarPreviewFatura, aplicar } from "./importar.js";
import { parseExtrato } from "./extrato.js";
import { parseFatura } from "./fatura.js";
import { alvoEfetivo, mediaSugestao, statusMeta, primeiroDiaDoMes, mesAnterior } from "./metas.js";

async function sha256hex(bytes) {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Fluxo puro de orquestração; tudo que toca rede/banco entra por `deps`.
export async function tratarUpdate(update, env, deps) {
  const ev = parseUpdate(update);

  if (ev.tipo === "callback" && ev.data?.startsWith("del:")) {
    await deps.db.apagarTransacao(ev.data.slice(4));
    await deps.responderImpl(ev.chatId, "🗑 Apagado.", env);
    return;
  }
  if (ev.tipo === "texto") {
    const p = parseLancamentoTexto(ev.texto);
    if (!p.ok) {
      await deps.responderImpl(ev.chatId, `Não entendi. ex.: padaria 57,50 29/03/2026 pessoa=Caio categoria=Casa`, env);
      return;
    }
    const d = p.dados;
    const catalogo = await deps.db.catalogo();
    // resolve categoria/sub por nome (case-insensitive) contra o catálogo; fallback Outros
    const avisos = [];
    let macroNome = null, subNome = null;
    if (d.categoria) {
      const c = catalogo.categorias.find((x) => x.nome.toLowerCase() === d.categoria.toLowerCase());
      if (c) { macroNome = c.nome; if (d.subcategoria) {
        const s = catalogo.subcategorias.find((x) => x.categoria_id === c.id && x.nome.toLowerCase() === d.subcategoria.toLowerCase());
        if (s) subNome = s.nome; else avisos.push(`subcategoria "${d.subcategoria}" não existe`);
      } }
      else avisos.push(`categoria "${d.categoria}" não existe — usei Outros`);
    }
    const { categoria_id, subcategoria_id } = resolverCategoria(macroNome, subNome, catalogo);
    // resolve pessoa por nome
    let pessoa_id = null;
    if (d.pessoa) { const pe = await deps.db.pessoaPorNome(d.pessoa); if (pe) pessoa_id = pe.id; else avisos.push(`pessoa "${d.pessoa}" não existe — deixei sem pessoa`); }

    const tx = await deps.db.inserirTransacao({
      dataISO: d.dataISO, natureza: d.natureza, esfera: "pessoal",
      valorCents: d.valorCents, reembolsoCents: 0, categoria_id, subcategoria_id,
      descricao: d.descricao, pessoa_id, fonte: "manual", origem_categoria: "manual",
      extraido_por: null, confianca: null, documento_id: null,
      contraparte_nome: null, contraparte_chave: null,
    });
    const nm = nomesDeCategoria(catalogo, categoria_id, subcategoria_id);
    const cat = nm.subcategoria ? `${nm.categoria} › ${nm.subcategoria}` : nm.categoria;
    const [aa, mm, dd] = d.dataISO.split("-");
    const selo = avisos.length ? `\n⚠ ${avisos.join("; ")}` : "";
    await deps.confirmar(ev.chatId, `✅ R$ ${centsToBR(d.valorCents)} · ${dd}/${mm} · ${cat} · "${d.descricao}"${selo}`, tx.id);
    return;
  }
  if (ev.tipo !== "imagem" && ev.tipo !== "pdf") return;

  const { bytes } = await deps.baixar(ev.fileId);
  const mime = ev.mime;   // fonte autoritativa (parseUpdate); downloadArquivo derivava mime errado p/ pdf

  // catálogo por id (Fase B): alimenta o extrator (nomes genéricos) e resolve nome→id.
  const catalogo = await deps.db.catalogo();

  // modo ensino: foto com legenda "/aprender ..." → só aprende, não cria transação (ignora dedup)
  const ap = parseAprender(ev.caption);
  if (ap) {
    const existeCat = catalogo.categorias.some((c) => c.nome === ap.macro);
    if (!existeCat) { await deps.responderImpl(ev.chatId, `Categoria "${ap.macro}" não existe. Categorias: ${catalogo.categorias.map((c) => c.nome).join(", ")}`, env); return; }
    const ex = await deps.extrairImpl(bytes, mime, catalogoParaLista(catalogo));
    if (!ex.ok) { await deps.responderImpl(ev.chatId, "Não consegui ler a contraparte desse comprovante.", env); return; }
    const n = ex.normalizado;
    const d = derivarChave({ contraparte_nome: n.contraparte_nome, contraparte_chave: n.contraparte_chave });
    if (!d) { await deps.responderImpl(ev.chatId, "Comprovante sem contraparte reconhecível — não dá pra aprender.", env); return; }
    const { categoria_id, subcategoria_id } = resolverCategoria(ap.macro, ap.sub, catalogo);
    await deps.db.upsertAssociacao({ chave: d.chave, tipo: d.tipo, categoria_id, subcategoria_id });
    const cat = ap.sub ? `${ap.macro} › ${ap.sub}` : ap.macro;
    await deps.responderImpl(ev.chatId, `✓ aprendido: ${n.contraparte_nome ?? d.chave} → ${cat}`, env);
    return;
  }

  const hash = await deps.hashBytes(bytes);
  const jaTem = await deps.db.documentoPorHash(hash);
  if (jaTem) { await deps.responderImpl(ev.chatId, "Esse comprovante eu já registrei antes.", env); return; }

  const ex = await deps.extrairImpl(bytes, mime, catalogoParaLista(catalogo));
  if (!ex.ok) { console.error("extração falhou:", (ex.erros || []).join(" | ")); await deps.responderImpl(ev.chatId, "Não consegui ler esse comprovante. Pode reenviar mais nítido?", env); return; }

  const n = ex.normalizado;
  // resolve o que o modelo devolveu (nomes) p/ ids; fallback Outros embutido em resolverCategoria
  let { categoria_id, subcategoria_id } = resolverCategoria(n.macro, n.sub, catalogo);
  // regra aprendida pela contraparte sobrepõe (pix/cpf primeiro, nome depois), agora por id
  let origemCat = "modelo";
  const ck = normalizarChave(n.contraparte_chave);
  if (ck) { const r = await deps.db.buscarAssociacao(ck, "pix_cpf"); if (r) { categoria_id = r.categoria_id; subcategoria_id = r.subcategoria_id; origemCat = "regra"; } }
  if (origemCat === "modelo") { const nm = normalizarNome(n.contraparte_nome); if (nm) { const r = await deps.db.buscarAssociacao(nm, "nome"); if (r) { categoria_id = r.categoria_id; subcategoria_id = r.subcategoria_id; origemCat = "regra"; } } }
  const ext = ev.tipo === "pdf" ? "pdf" : (mime === "image/png" ? "png" : "jpg");
  const caminho = `${caminhoDropbox(n.dataISO)}/${nomeArquivo({ ...n, ext })}`;
  const dropboxPath = await deps.subir(env, caminho, bytes);

  const doc = await deps.db.inserirDocumento({
    dropbox_path: dropboxPath, nome_arquivo: nomeArquivo({ ...n, ext }),
    tipo_arquivo: mime, hash, telegram_file_id: ev.fileId,
  });
  const tx = await deps.db.inserirTransacao({
    dataISO: n.dataISO, natureza: n.natureza, esfera: "pessoal",
    valorCents: n.valorCents, reembolsoCents: 0, categoria_id, subcategoria_id,
    descricao: n.descricao, pessoa_id: null, fonte: "imagem", origem_categoria: origemCat,
    extraido_por: ex.extraido_por, confianca: ex.confianca, documento_id: doc.id,
    contraparte_nome: n.contraparte_nome, contraparte_chave: n.contraparte_chave,
  });

  // nomes p/ a confirmação vêm dos ids resolvidos (podem ter mudado pela regra)
  const nm2 = nomesDeCategoria(catalogo, categoria_id, subcategoria_id);
  const cat = nm2.subcategoria ? `${nm2.categoria} › ${nm2.subcategoria}` : nm2.categoria;
  const selo = origemCat === "regra" ? " ✓ aprendido" : "";
  const [a, m, d] = n.dataISO.split("-");
  await deps.confirmar(ev.chatId, `✅ R$ ${centsToBR(n.valorCents)} · ${d}/${m} · ${cat}${selo} · "${n.descricao ?? ""}"\najuste a categoria no app`, tx.id);
}

async function handleTelegram(request, env) {
  if (!segredoTelegramValido(request, env.TELEGRAM_SECRET)) return new Response("no", { status: 401 });
  const update = await request.json();
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  if (!chatPermitido(chatId, env.ALLOWLIST)) return new Response("ok"); // falha fechada, silencioso

  const sql = neon(env.DATABASE_URL);
  const db = criarDb(sql);
  const deps = {
    db,
    baixar: (fileId) => downloadArquivo(env.TELEGRAM_TOKEN, fileId),
    hashBytes: sha256hex,
    extrairImpl: (bytes, mime, categorias) => extrair(bytes, mime, categorias, {
      limiar: 0.6,
      callGemini: (b, mm, c) => callGeminiHTTP(b, mm, c, env.GEMINI_KEY),
      callClaude: (b, mm, c) => callClaudeHTTP(b, mm, c, env.CLAUDE_KEY),
    }),
    subir: (e, caminho, bytes) => subirDropbox(e, caminho, bytes),
    confirmar: (chat, texto, id) => enviarConfirmacao(env.TELEGRAM_TOKEN, chat, texto, id),
    responderImpl: (chat, texto) => responder(env.TELEGRAM_TOKEN, chat, texto),
  };
  await tratarUpdate(update, env, deps);
  return new Response("ok");
}

export async function handleApi(request, env, url, dbOpt = null) {
  if (!tokenValido(request, env.APP_TOKEN)) return new Response("no", { status: 401 });
  const sql = dbOpt ? null : neon(env.DATABASE_URL);
  const db = dbOpt || criarDb(sql);
  const j = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

  const id = () => url.pathname.split("/").pop();
  const body = () => request.json();
  // desloca uma data ISO (YYYY-MM-DD) por n dias em UTC — usado p/ a janela de reconciliação.
  const deslocaDias = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const erroJson = (msg, status) => new Response(JSON.stringify({ erro: msg }), { status, headers: { "content-type": "application/json" } });

  if (url.pathname === "/api/transacoes" && request.method === "GET") {
    const p = url.searchParams;
    return j(await db.listarTransacoes({ de: p.get("de"), ate: p.get("ate"), categoria_id: p.get("categoria_id"), natureza: p.get("natureza"), esfera: p.get("esfera") }));
  }
  if (url.pathname === "/api/catalogo") return j(await db.catalogo());
  // edição em massa (POST, não colide com PATCH/DELETE /api/transacoes/:id)
  if (url.pathname === "/api/transacoes/lote" && request.method === "POST") {
    const b = await body();
    return j(await db.atualizarTransacoesLote(b.ids || [], b.mudancas || {}));
  }
  if (url.pathname.startsWith("/api/transacoes/") && request.method === "PATCH") {
    await db.atualizarTransacao(id(), await body());
    return j({ ok: true });
  }
  if (url.pathname.startsWith("/api/transacoes/") && request.method === "DELETE") {
    await db.apagarTransacao(id());
    return j({ ok: true });
  }

  // ---- gestão de categorias ----
  if (url.pathname === "/api/categorias" && request.method === "POST") { const b = await body(); return j(await db.criarCategoria(b.nome, b.natureza)); }
  if (url.pathname.startsWith("/api/categorias/") && request.method === "PATCH") { const b = await body(); await db.renomearCategoria(id(), b.nome); return j({ ok: true }); }
  if (url.pathname.startsWith("/api/categorias/") && request.method === "DELETE") { await db.desativarCategoria(id()); return j({ ok: true }); }

  // ---- gestão de subcategorias (inclui merge e mover) ----
  if (url.pathname === "/api/subcategorias/merge" && request.method === "POST") { const b = await body(); await db.mergeSub(b.origem_id, b.destino_id); return j({ ok: true }); }
  if (url.pathname === "/api/subcategorias" && request.method === "POST") { const b = await body(); return j(await db.criarSub(b.categoria_id, b.nome)); }
  if (url.pathname.startsWith("/api/subcategorias/") && request.method === "PATCH") {
    const b = await body();
    if (b.categoria_id) await db.moverSub(id(), b.categoria_id);
    if (b.nome) await db.renomearSub(id(), b.nome);
    return j({ ok: true });
  }
  if (url.pathname.startsWith("/api/subcategorias/") && request.method === "DELETE") { await db.desativarSub(id()); return j({ ok: true }); }

  // ---- gestão de pessoas ----
  if (url.pathname === "/api/pessoas" && request.method === "GET") return j(await db.listarPessoas());
  if (url.pathname === "/api/pessoas" && request.method === "POST") { const b = await body(); return j(await db.criarPessoa(b.nome)); }
  if (url.pathname.startsWith("/api/pessoas/") && request.method === "PATCH") { const b = await body(); await db.renomearPessoa(id(), b.nome); return j({ ok: true }); }
  if (url.pathname.startsWith("/api/pessoas/") && request.method === "DELETE") { await db.desativarPessoa(id()); return j({ ok: true }); }

  if (url.pathname === "/api/resumo") {
    const de = url.searchParams.get("de") || "1900-01-01";
    const ate = url.searchParams.get("ate") || "2999-12-31";
    return j({
      kpis: await db.resumoKPIs(de, ate),
      porCategoria: await db.resumoPorCategoria(de, ate),
      mensal: await db.resumoMensal(de, ate),
      mesVsAnterior: await db.resumoMesVsAnterior(),
      porPessoa: await db.resumoPorPessoa(de, ate),
    });
  }

  // ---- Inc 4: planejamento (metas) ----
  const mesValido = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || "");

  if (url.pathname === "/api/metas" && request.method === "GET") {
    const mes = url.searchParams.get("mes");
    if (!mesValido(mes)) return erroJson("mes inválido (use YYYY-MM)", 400);
    const dia01 = primeiroDiaDoMes(mes);
    const de = dia01, ateExcl = primeiroDiaDoMes(mesAnterior(mes, -1)); // [mês, mês+1)
    const [catalogo, baselines, excecoes, realizado] = await Promise.all([
      db.catalogo(), db.metasBaselines(), db.metasExcecoes(), db.realizadoPorCategoriaMes(de, ateExcl),
    ]);
    const realPorCat = {};
    for (const r of realizado) realPorCat[r.categoria_id] = r.realizado_cents;
    const linhas = catalogo.categorias
      .filter((c) => c.natureza === "despesa")
      .map((c) => {
        const { valorCents, origem } = alvoEfetivo(baselines, excecoes, c.id, dia01);
        const realizado_cents = realPorCat[c.id] || 0;
        const diff_cents = valorCents == null ? null : valorCents - realizado_cents;
        return { categoria_id: c.id, categoria: c.nome, alvo_cents: valorCents, realizado_cents,
                 diff_cents, origem, status: statusMeta(realizado_cents, valorCents) };
      });
    const total = linhas.reduce((acc, l) => {
      if (l.alvo_cents != null) acc.alvo_cents += l.alvo_cents;
      acc.realizado_cents += l.realizado_cents;
      return acc;
    }, { alvo_cents: 0, realizado_cents: 0 });
    total.diff_cents = total.alvo_cents - total.realizado_cents;
    return j({ mes, linhas, total });
  }

  if (url.pathname === "/api/metas/sugestao" && request.method === "GET") {
    const mes = url.searchParams.get("mes");
    if (!mesValido(mes)) return erroJson("mes inválido (use YYYY-MM)", 400);
    const de = primeiroDiaDoMes(mesAnterior(mes, 3)), ateExcl = primeiroDiaDoMes(mes); // [mês-3, mês)
    const [catalogo, realizado] = await Promise.all([db.catalogo(), db.realizadoPorCategoriaMes(de, ateExcl)]);
    const porCat = {};
    for (const r of realizado) (porCat[r.categoria_id] ||= {})[r.mes] = r.realizado_cents;
    const linhas = catalogo.categorias
      .filter((c) => c.natureza === "despesa")
      .map((c) => ({ categoria_id: c.id, sugestao_cents: mediaSugestao(porCat[c.id] || {}, mes, 3) }));
    return j({ mes, linhas });
  }

  if (url.pathname === "/api/metas" && request.method === "PUT") {
    const b = await body();
    if (!mesValido(b.mes)) return erroJson("mes inválido (use YYYY-MM)", 400);
    if (!Number.isInteger(b.valor_cents) || b.valor_cents < 0) return erroJson("valor_cents inválido", 400);
    if (!b.categoria_id) return erroJson("categoria_id obrigatório", 400);
    const dia01 = primeiroDiaDoMes(b.mes);
    if (b.escopo === "baseline") await db.setBaseline(b.categoria_id, dia01, b.valor_cents);
    else if (b.escopo === "excecao") await db.setExcecao(b.categoria_id, dia01, b.valor_cents);
    else return erroJson("escopo inválido (baseline|excecao)", 400);
    return j({ ok: true });
  }

  if (url.pathname === "/api/metas" && request.method === "DELETE") {
    const p = url.searchParams;
    if (!mesValido(p.get("mes"))) return erroJson("mes inválido (use YYYY-MM)", 400);
    if (!p.get("categoria_id")) return erroJson("categoria_id obrigatório", 400);
    const dia01 = primeiroDiaDoMes(p.get("mes"));
    if (p.get("escopo") === "baseline") await db.apagarBaseline(p.get("categoria_id"), dia01);
    else if (p.get("escopo") === "excecao") await db.apagarExcecao(p.get("categoria_id"), dia01);
    else return erroJson("escopo inválido (baseline|excecao)", 400);
    return j({ ok: true });
  }

  if (url.pathname === "/api/metas/grade" && request.method === "GET") {
    const p = url.searchParams;
    const hoje = new Date().toISOString().slice(0, 7);
    let de = p.get("de"), ate = p.get("ate");
    if (!mesValido(de)) de = mesAnterior(hoje, 3);    // 3 meses atrás
    if (!mesValido(ate)) ate = mesAnterior(hoje, -8); // 8 à frente
    const meses = [];
    for (let m = de; ; m = mesAnterior(m, -1)) { meses.push(m); if (m === ate || meses.length >= 60) break; }
    const deDia = primeiroDiaDoMes(de), ateExcl = primeiroDiaDoMes(mesAnterior(ate, -1));
    const [catalogo, baselines, excecoes, realizado] = await Promise.all([
      db.catalogo(), db.metasBaselines(), db.metasExcecoes(), db.realizadoPorCategoriaMes(deDia, ateExcl),
    ]);
    const realMap = {};
    for (const r of realizado) realMap[`${r.categoria_id}|${r.mes}`] = r.realizado_cents;
    const categorias = catalogo.categorias
      .filter((c) => c.natureza === "despesa")
      .map((c) => ({
        categoria_id: c.id, categoria: c.nome,
        celulas: meses.map((m) => {
          const { valorCents, origem } = alvoEfetivo(baselines, excecoes, c.id, primeiroDiaDoMes(m));
          const passadoOuCorrente = m <= hoje;
          return { mes: m, alvo_cents: valorCents, origem,
                   realizado_cents: passadoOuCorrente ? (realMap[`${c.id}|${m}`] || 0) : null };
        }),
      }));
    return j({ meses, categorias });
  }

  // ---- importar extrato/fatura (Incremento 3) ----
  if (url.pathname === "/api/importar/preview" && request.method === "POST") {
   try {
    const b = await body();
    if (!b.texto || !b.texto.trim()) return erroJson("Não foi possível extrair texto do PDF (arquivo vazio ou ilegível).", 400);
    const catalogo = await db.catalogo();
    const associacoes = await db.associacoesPorNome();

    if (b.tipo === "extrato") {
      const { linhas } = parseExtrato(b.texto);
      const hoje = new Date().toISOString().slice(0, 10);
      let de = hoje, ate = hoje;
      if (linhas.length) {
        de = linhas.reduce((min, l) => (l.data < min ? l.data : min), linhas[0].data);
        ate = linhas.reduce((max, l) => (l.data > max ? l.data : max), linhas[0].data);
      }
      // Janela de reconciliação ±3 dias (igual tools/importar_extrato.py): reconciliarLinha casa
      // dentro de ±3d, então uma transação já lançada 1–3 dias antes/depois da borda do extrato é
      // candidata legítima e PRECISA entrar em `existentes` — senão a linha vira "novo" e duplica.
      const deJanela = deslocaDias(de, -3), ateJanela = deslocaDias(ate, 3);
      const existentes = await db.transacoesNaJanela(deJanela, ateJanela);
      const hashes = await db.hashesNaJanela(deJanela, ateJanela);
      return j(montarPreviewExtrato(b.texto, b.conta, { catalogo, associacoes, existentes, hashes }));
    }

    if (b.tipo === "fatura") {
      const ano = parseInt(b.ano, 10), mesNum = parseInt(b.mes, 10);
      if (!ano || ano < 2000 || ano > 2100 || !mesNum || mesNum < 1 || mesNum > 12) {
        return erroJson("Informe ano (ex.: 2025) e mês (1–12) da fatura.", 400);
      }
      const { itens } = parseFatura(b.texto, ano);
      const hoje = new Date().toISOString().slice(0, 10);
      let de = hoje, ate = hoje;
      if (itens.length) {
        de = itens.reduce((min, i) => (i.data < min ? i.data : min), itens[0].data);
        ate = itens.reduce((max, i) => (i.data > max ? i.data : max), itens[0].data);
      }
      const hashes = await db.hashesNaJanela(de, ate);
      // mês com 2 dígitos: entra na conta sintética fatura-${ano}${mes} da linha_hash. "5" e "05"
      // gerariam hashes diferentes p/ a mesma fatura (quebrando a dedup — o bloco 2 gravou "05").
      const mes = String(mesNum).padStart(2, "0");
      return j(montarPreviewFatura(b.texto, ano, mes, { catalogo, associacoes, hashes }));
    }

    return erroJson(`tipo inválido: ${b.tipo}`, 400);
   } catch (err) {
     // devolve a mensagem real (não um 500 opaco) — facilita diagnosticar do navegador.
     return erroJson(`preview falhou: ${err && err.message ? err.message : String(err)}`, 500);
   }
  }
  if (url.pathname === "/api/importar/aplicar" && request.method === "POST") {
   try {
    const b = await body();
    const r = await aplicar(db, b.decisao);
    // fatura: depois de gravar os itens, marca o pagamento correspondente no extrato como fora do
    // resumo (janela de 62 dias a partir do 1º dia do mês da fatura, igual tools/importar_fatura.py).
    if (b.fatura && b.fatura.totalCents) {
      const mes = String(b.fatura.mes).padStart(2, "0");
      const de = `${b.fatura.ano}-${mes}-01`;
      const pg = await db.marcarPagamentoFaturaNaoGasto(b.fatura.totalCents, de, deslocaDias(de, 62));
      r.pagamentoMarcado = pg.marcados;
      r.pagamentoCandidatos = pg.candidatos;
    }
    return j(r);
   } catch (err) {
     return erroJson(`aplicar falhou: ${err && err.message ? err.message : String(err)}`, 500);
   }
  }

  return new Response("not found", { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/telegram") return handleTelegram(request, env);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url, null);
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      // token na query? seta o cookie NO SERVIDOR e leva pro app.
      // Fazer server-side evita a corrida do acesso.js (dois location.replace
      // que competiam e perdiam o cookie antes do fetch do /api).
      const q = url.searchParams.get("token");
      if (q && q === env.APP_TOKEN) {
        return new Response(null, {
          status: 302,
          headers: {
            "Set-Cookie": `token=${q}; Path=/; Max-Age=31536000; SameSite=Strict`,
            "Location": "/app",
          },
        });
      }
      if (!tokenValido(request, env.APP_TOKEN)) return new Response("acesso negado", { status: 401 });
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
