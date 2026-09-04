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
  if (ev.tipo === "pdf") { await deps.responderImpl(ev.chatId, "PDF de extrato/fatura é do próximo incremento — por ora, mande foto de comprovante.", env); return; }
  if (ev.tipo === "texto") { await deps.responderImpl(ev.chatId, "Lançamento por texto vem logo. Por enquanto, mande a foto do comprovante.", env); return; }
  if (ev.tipo !== "imagem") return;

  const { bytes, mime } = await deps.baixar(ev.fileId);

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
  const ext = mime === "image/png" ? "png" : "jpg";
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

  if (url.pathname === "/api/transacoes" && request.method === "GET") {
    const p = url.searchParams;
    return j(await db.listarTransacoes({ de: p.get("de"), ate: p.get("ate"), categoria_id: p.get("categoria_id"), natureza: p.get("natureza"), esfera: p.get("esfera") }));
  }
  if (url.pathname === "/api/catalogo") return j(await db.catalogo());
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
