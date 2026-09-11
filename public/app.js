// ---------- funções puras (testadas em node) ----------
// resumo.porPessoa vem do backend como linhas {pessoa, natureza, total} (uma por pessoa×natureza)
// dobra em uma linha por pessoa. Mesmo formato de saída que agruparPorPessoa devolve (receita/despesa/saldo).
// Ordena por despesa desc porque é um corte de gasto (quem gastou mais primeiro).
export function agruparPorPessoa(rows) {
  const mapa = new Map();
  for (const r of rows) {
    if (!mapa.has(r.pessoa)) mapa.set(r.pessoa, { pessoa: r.pessoa, receita: 0, despesa: 0, saldo: 0 });
    const o = mapa.get(r.pessoa);
    const v = parseFloat(r.total);
    if (r.natureza === "receita") o.receita += v; else o.despesa += v;
    o.saldo = o.receita - o.despesa;
  }
  return [...mapa.values()].sort((a, b) => b.despesa - a.despesa);
}

export const centavosBR = numericStr => {
  const cents = Math.round(parseFloat(numericStr) * 100);
  const reais = Math.floor(Math.abs(cents) / 100).toLocaleString("pt-BR");
  const dec = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${reais},${dec}`;
};

export const kf = n =>
  n >= 1000 ? (n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "k" : String(Math.round(n));

export function deltaPct(ant, atual) {
  ant = +ant; atual = +atual;
  if (!ant) return atual > 0 ? 100 : 0;
  return (atual - ant) / ant * 100;
}

// Inc 4.5: range meio-aberto [de, ateExcl) de um mês 'YYYY-MM'.
export function rangeDoMes(mes) {
  const [a, m] = mes.split("-").map(Number);
  const prox = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
  return { de: `${mes}-01`, ateExcl: `${prox}-01` };
}

// receita (número) + cats despesa [{nm,v}] → passos do waterfall com lo/hi cumulativos
export function construirWaterfall(receita, cats) {
  receita = +receita;
  const steps = [{ nm: "Receita", tipo: "receita", lo: 0, hi: receita }];
  let run = receita;
  for (const c of cats) { const v = +c.v; steps.push({ nm: c.nm, tipo: "despesa", lo: run - v, hi: run }); run -= v; }
  steps.push({ nm: "Saldo", tipo: "saldo", lo: Math.min(0, run), hi: Math.max(0, run) });
  return steps;
}

// catálogo ({categorias,subcategorias}, ambas por id — Fase B) + categoria_id → subs
// daquela categoria, só {id,nome} (o select de Subcategoria usa isso pra repopular
// quando a Categoria da linha muda).
export function subsDaCat(catalogo, categoria_id) {
  return (catalogo.subcategorias || [])
    .filter(s => s.categoria_id === categoria_id)
    .map(s => ({ id: s.id, nome: s.nome }));
}

// Inc 4.5: acumulado diário do gasto no mês. diario=[{dia:'YYYY-MM-DD', total_cents}] (esparso).
// hojeISO: se dado e no mês, para nesse dia (mês corrente). Devolve 1 entrada por dia até o limite.
export function acumularDiario(diario, ano, mes, hojeISO = null) {
  const porDia = {};
  for (const d of diario) porDia[d.dia] = d.total_cents;
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const out = [];
  let acum = 0;
  for (let dia = 1; dia <= ultimo; dia++) {
    const iso = `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    if (hojeISO && iso > hojeISO) break;         // mês corrente: para em hoje
    acum += (porDia[iso] || 0);
    out.push({ dia: iso, acum_cents: acum });
  }
  return out;
}

// reta de "ritmo" do orçamento: linear de 0 (dia 1) ao total (último dia).
export function paceOrcamento(totalCents, ano, mes) {
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const out = [];
  for (let dia = 1; dia <= ultimo; dia++) out.push({ dia, alvo_cents: Math.round(totalCents * dia / ultimo) });
  return out;
}

// remove acentos p/ busca acento-insensível ("sao paulo" acha "São Paulo").
const normalizarBusca = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// filtra client-side; campo vazio/undefined = não filtra naquela dimensão.
export function filtrarTransacoes(rows, filtro = {}) {
  const { categoria, pessoa, origem, texto, computa } = filtro;
  const txt = texto && texto.trim() ? normalizarBusca(texto.trim()) : "";
  return rows.filter(t => {
    if (categoria && t.categoria !== categoria) return false;
    if (pessoa === "__sem__") { if (t.pessoa_id) return false; }
    else if (pessoa && t.pessoa !== pessoa) return false;
    if (origem && t.origem_categoria !== origem) return false;
    if (computa === "gasto" && !t.computa_resumo) return false;
    if (computa === "naogasto" && t.computa_resumo) return false;
    if (txt) {
      const alvo = normalizarBusca((t.descricao ?? "") + " " + (t.contraparte_nome ?? ""));
      if (!alvo.includes(txt)) return false;
    }
    return true;
  });
}

// ---------- edição em massa (Lançamentos) ----------
// monta o objeto `mudancas` a partir dos valores da barra de ação em massa. Só inclui um campo
// quando ele NÃO está em "— não mexer —" ("__nao__"). Sentinelas: categoria "__nao__" = não mexe;
// pessoa "__nao__" = não mexe, "" = limpar (null); computa "fora"/"incluir"/"__nao__".
// Ao setar categoria, seta também a subcategoria (sub "" → null, igual à edição por linha).
export function montarMudancas(bar = {}) {
  const m = {};
  if (bar.categoria && bar.categoria !== "__nao__") {
    m.categoria_id = bar.categoria;
    m.subcategoria_id = bar.subcategoria || null;
  }
  if (bar.pessoa !== "__nao__" && bar.pessoa !== undefined) {
    m.pessoa_id = bar.pessoa || null; // "" = limpar
  }
  if (bar.computa === "fora") m.computa_resumo = false;
  else if (bar.computa === "incluir") m.computa_resumo = true;
  return m;
}

// ---------- importação (Task 9: aba Importar) ----------
// resolve nome→id igual worker/categorias.js::resolverCategoria (reimplementado aqui porque o
// browser não importa worker/*.js): categoria por nome exato, fallback "Outros"; sub só se
// bater dentro da categoria resolvida.
function resolverCategoriaImport(nomeMacro, nomeSub, catalogo) {
  const cats = catalogo.categorias || [];
  let cat = cats.find(c => c.nome === nomeMacro);
  if (!cat) cat = cats.find(c => c.nome === "Outros");
  const categoria_id = cat ? cat.id : null;

  let subcategoria_id = null;
  if (categoria_id && nomeSub) {
    const sub = (catalogo.subcategorias || []).find(s => s.categoria_id === categoria_id && s.nome === nomeSub);
    if (sub) subcategoria_id = sub.id;
  }
  return { categoria_id, subcategoria_id };
}

// monta a decisao revisada (novos/naoGasto/casados) a partir do preview + catálogo, espelhando
// tools/importar_extrato.py::_gravar / importar_fatura.py: só "novo"/"naoGasto" viram linha de
// inserirTransacao (categoria já resolvida por id); "casado" só carimba linha_hash; "ambiguo" e
// "jaTem" não são aplicados por padrão (o app pode resolver um ambíguo mutando status antes).
export function montarDecisao(preview, catalogo, fonte) {
  const novos = [], naoGasto = [], casados = [];
  for (const item of preview.itens) {
    if (item.status === "casado") {
      casados.push({ matchId: item.matchId, linhaHash: item.linhaHash });
      continue;
    }
    if (item.status !== "novo" && item.status !== "naoGasto") continue; // ambiguo/jaTem: skip

    const nomeCat = item.categoriaOrg || item.categoriaNome || "Outros";
    const { categoria_id, subcategoria_id } = resolverCategoriaImport(nomeCat, item.subNome, catalogo);
    const row = {
      dataISO: item.data, natureza: item.natureza, esfera: "pessoal",
      valorCents: item.valorCents, reembolsoCents: 0,
      categoria_id, subcategoria_id,
      descricao: item.descricaoFinal ?? item.descricao,
      fonte, origem_categoria: item.categoriaNome ? "regra" : "modelo",
      contraparte_nome: item.contraparteNome,
      computa_resumo: item.computaResumo, linha_hash: item.linhaHash,
    };
    (item.status === "novo" ? novos : naoGasto).push(row);
  }
  return { novos, naoGasto, casados };
}

// "Aplicar" bloqueia só quando o checksum manda bloquear (extrato com diferença — o saldo não
// fecha, algo foi mal lido). A fatura é AVISO (bloqueiaAplicar=false): IOF/encargos entram no
// total sem serem lançamentos, então a diferença é esperada e não impede aplicar.
export function podeAplicar(preview) {
  return preview?.checksum?.bloqueiaAplicar !== true;
}

// rótulo curto das contagens do preview, pra mostrar acima da revisão. Conta AO VIVO a partir
// de preview.itens (por status) — não do preview.resumo estático do servidor: assim, quando o
// usuário resolve um ambíguo (muta item.status), o resumo acompanha as tabelas de grupo em vez
// de mostrar a contagem original. Cai pra preview.resumo se não houver itens (defensivo).
export function resumoTexto(preview) {
  const itens = preview.itens;
  let r;
  if (Array.isArray(itens)) {
    const n = st => itens.filter(i => i.status === st).length;
    r = { novos: n("novo"), casados: n("casado"), naoGasto: n("naoGasto"), ambiguos: n("ambiguo"), jaTem: n("jaTem") };
  } else {
    r = preview.resumo || {};
  }
  return `novos ${r.novos ?? 0} · conciliados ${r.casados ?? 0} · fora do resumo ${r.naoGasto ?? 0} · ` +
    `ambíguos ${r.ambiguos ?? 0} · já tinha ${r.jaTem ?? 0}`;
}

// ---------- app (só no browser) ----------
if (typeof document !== "undefined") {
  const { extrairTextoPDF } = await import("/pdf_extrair.js");
  // pdf.js (CDN, carregado em index.html) precisa do worker configurado antes do 1º parse —
  // mesma versão pinada do <script> em index.html.
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const $ = (s, r = document) => r.querySelector(s);
  const BRL = n => "R$ " + Math.round(n).toLocaleString("pt-BR");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CAT = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7"];
  const tip = $("#tip");
  const showTip = (e, html) => { tip.innerHTML = html; tip.style.opacity = 1; tip.style.left = (e.clientX + 12) + "px"; tip.style.top = (e.clientY + 12) + "px"; };
  const hideTip = () => { tip.style.opacity = 0; };
  const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const mesLabel = ym => MES[+ym.slice(5, 7) - 1];
  // Inc 4.5 Tarefa 3: rótulo de coluna da grade leva o ano (ex. "jun/26") — mesLabel sozinho
  // não distingue jun/25 de jun/26 numa grade de 12 meses à frente.
  const mesLabelAno = ym => `${mesLabel(ym)}/${ym.slice(2, 4)}`;

  const estado = {
    mes: new Date().toISOString().slice(0, 7), resumo: null, metasMes: null, transacoes: [], cores: {}, pessoas: [],
    catalogo: { categorias: [], subcategorias: [] }, // Fase B: categorias/subcategorias por id
    filtro: { categoria: "", pessoa: "", origem: "", texto: "", computa: "" },
    selecao: new Set(), // ids selecionados p/ edição em massa (persiste ao filtrar/re-renderizar)
    importar: { tipo: "extrato", preview: null, carregando: false, ultimoResultado: null, ano: null, mes: null },
    lancTudo: false,
    sunburstFoco: null, // Inc 4.5 Tarefa 8: nome da categoria focada no sunburst (null = visão completa)
  };

  // API
  const apiGet = p => fetch(p).then(r => { if (!r.ok) throw new Error(`GET ${p} ${r.status}`); return r.json(); });
  const apiPost = async (p, body) => {
    const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      // tenta ler {erro} do corpo p/ mostrar a mensagem real em vez de só o status
      let msg = `POST ${p} ${r.status}`;
      try { const e = await r.json(); if (e && e.erro) msg = e.erro; } catch { /* corpo não-JSON */ }
      throw new Error(msg);
    }
    return r.json();
  };
  const apiPatch = (p, body) => fetch(p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => { if (!r.ok) throw new Error(`PATCH ${p} ${r.status}`); return r; });
  const apiDelete = p => fetch(p, { method: "DELETE" }).then(r => { if (!r.ok) throw new Error(`DELETE ${p} ${r.status}`); return r; });

  // corDe é keyed pelo NOME da categoria (não pelo id): os gráficos do Resumo recebem
  // nomes via resumo.porCategoria/mesVsAnterior (macro apelidado no backend), e a tabela
  // de Lançamentos recebe t.categoria (nome, via join). Um único mapa nome→cor serve os dois.
  function corDe(nome) { return estado.cores[nome] || "--dim"; }
  function construirCores(nomes) {
    const uniq = [...new Set(nomes)].sort();
    const m = {}; uniq.forEach((nm, i) => m[nm] = CAT[i % CAT.length]); return m;
  }

  // ----- KPIs -----
  function drawKPIs() {
    const k = estado.resumo.kpis || {};
    const receita = +k.receita || 0, despesa = +k.despesa || 0, reembolso = +k.reembolso || 0;
    const saldo = receita - despesa;
    const pct = receita ? Math.round(saldo / receita * 100) : 0;
    const cel = (lbl, val, cor, sub) =>
      `<div class="card kpi"><div class="lbl">${lbl}</div><div class="val"${cor ? ` style="color:var(${cor})"` : ""}>R$ ${Math.round(val).toLocaleString("pt-BR")}</div><div class="delta" style="color:var(--mut)">${sub}</div></div>`;
    $("#kpis").innerHTML =
      cel("Receita", receita, "--receita", "no período") +
      cel("Despesa", despesa, "--despesa", receita ? `${Math.round(despesa / receita * 100)}% da receita` : "&nbsp;") +
      `<div class="card kpi"><div class="lbl">Saldo guardado</div><div class="val">R$ ${Math.round(saldo).toLocaleString("pt-BR")}</div><div class="delta ${saldo >= 0 ? "up" : "down"}">${pct}% da receita</div></div>` +
      cel("Reembolso (IR)", reembolso, "--c3", "dedutível");
  }

  // ----- Inc 4.5 Tarefa 7: gasto no mês — acumulado × orçamento -----
  function drawDiario() {
    const [ano, mes] = estado.mes.split("-").map(Number);
    const hojeISO = new Date().toISOString().slice(0, 10);
    // só passa hojeISO (e portanto para a curva em hoje) quando o mês selecionado é o
    // corrente; num mês passado/futuro a curva cobre o mês inteiro.
    const hojeSeMesCorrente = hojeISO.slice(0, 7) === estado.mes ? hojeISO : null;
    const acum = acumularDiario(estado.resumo.diario || [], ano, mes, hojeSeMesCorrente);
    const alvoTotal = +(estado.metasMes?.total?.alvo_cents || 0);
    const pace = paceOrcamento(alvoTotal, ano, mes); // reta cobre o mês inteiro, não para em hoje
    const ultimo = pace.length;
    const el = $("#evo");
    if (!ultimo) { el.innerHTML = `<p class="vazio">sem dados no mês</p>`; return; }
    const W = 560, H = 230, pl = 8, pr = 8, pt = 14, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
    // domínio Y = maior entre o pico do acumulado (é monotônico, então é a última entrada)
    // e o orçamento total (última entrada da reta de ritmo), com folga de 10%.
    const maiorAcum = acum.length ? acum[acum.length - 1].acum_cents / 100 : 0;
    const orcamentoTotal = alvoTotal / 100;
    const hi = Math.max(1, maiorAcum, orcamentoTotal) * 1.1;
    const X = d => ultimo === 1 ? pl + iw / 2 : pl + iw * (d - 1) / (ultimo - 1);
    const Y = v => pt + ih * (hi - v) / hi;
    let g = "";
    for (let k = 0; k <= 3; k++) { const y = pt + ih * k / 3; g += `<line class="grid-l" x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}"/>`; }
    // pace[i]/acum[i] têm 1 entrada por dia a partir do dia 1, em ordem — o índice já é o dia-1.
    const pathAlvo = pace.map((p, i) => (i ? "L" : "M") + X(p.dia).toFixed(1) + "," + Y(p.alvo_cents / 100).toFixed(1)).join(" ");
    const pathGasto = acum.map((a, i) => (i ? "L" : "M") + X(i + 1).toFixed(1) + "," + Y(a.acum_cents / 100).toFixed(1)).join(" ");
    let labels = "";
    const step = ultimo > 20 ? 5 : ultimo > 10 ? 2 : 1;
    for (let d = 1; d <= ultimo; d++) if ((d - 1) % step === 0) labels += `<text class="axis" x="${X(d).toFixed(1)}" y="${H - 8}" text-anchor="middle">${d}</text>`;
    let hot = "";
    const w = iw / ultimo;
    for (let d = 1; d <= ultimo; d++) hot += `<rect x="${(X(d) - w / 2).toFixed(1)}" y="${pt}" width="${w.toFixed(1)}" height="${ih}" fill="transparent" data-d="${d}"/>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Gasto no mês">
      ${g}
      <path d="${pathAlvo}" stroke-width="2" stroke-dasharray="4 3" style="fill:none;stroke:var(--dim)"/>
      ${pathGasto ? `<path d="${pathGasto}" stroke-width="2" style="fill:none;stroke:var(--despesa)"/>` : ""}
      ${labels}<g id="evohot">${hot}</g></svg>`;
    $("#evohot").querySelectorAll("rect").forEach(r => {
      r.addEventListener("mousemove", e => {
        const d = +r.dataset.d;
        const gasto = d <= acum.length ? acum[d - 1].acum_cents / 100 : null;
        const alvo = pace[d - 1].alvo_cents / 100;
        showTip(e, `<b>dia ${d}</b><br>${gasto != null ? `Gasto acumulado ${BRL(gasto)}` : "sem gasto registrado ainda"}<br>Orçamento previsto ${BRL(alvo)}`);
      });
      r.addEventListener("mouseleave", hideTip);
    });
  }

  // ----- despesa por macro (para donut + waterfall) -----
  function despesaPorMacro() {
    const m = new Map();
    for (const r of (estado.resumo.porCategoria || [])) {
      if (r.natureza !== "despesa") continue;
      m.set(r.macro, (m.get(r.macro) || 0) + parseFloat(r.total));
    }
    return [...m.entries()].map(([nm, v]) => ({ nm, v })).sort((a, b) => b.v - a.v);
  }

  // ----- Inc 4.5 Tarefa 8: sunburst categoria (anel interno) + subcategoria (anel externo) -----
  // agrupa porCategoria (só despesa, linhas com sub preenchida) por macro → [{nm(sub), v}].
  // O total de uma categoria (despesaPorMacro) inclui tanto as linhas com sub quanto as sem
  // (sub null); a diferença entre o total da macro e a soma das subs é o "sem subcategoria".
  function subPorMacro() {
    const m = new Map();
    for (const r of (estado.resumo.porCategoria || [])) {
      if (r.natureza !== "despesa" || !r.sub) continue;
      if (!m.has(r.macro)) m.set(r.macro, []);
      m.get(r.macro).push({ nm: r.sub, v: parseFloat(r.total) });
    }
    return m;
  }

  // caminho de um arco de anel (mesma geometria do donut, generalizada p/ raio interno/externo
  // arbitrários — reusada pelos dois anéis do sunburst).
  function arcoAnel(a0, a1, rIn, rOut, cx, cy) {
    const laf = (a1 - a0) > Math.PI ? 1 : 0;
    const x0 = cx + rOut * Math.cos(a0), y0 = cy + rOut * Math.sin(a0);
    const x1 = cx + rOut * Math.cos(a1), y1 = cy + rOut * Math.sin(a1);
    const xi1 = cx + rIn * Math.cos(a1), yi1 = cy + rIn * Math.sin(a1);
    const xi0 = cx + rIn * Math.cos(a0), yi0 = cy + rIn * Math.sin(a0);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${rOut},${rOut} 0 ${laf} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${xi1.toFixed(1)},${yi1.toFixed(1)} A${rIn},${rIn} 0 ${laf} 0 ${xi0.toFixed(1)},${yi0.toFixed(1)} Z`;
  }
  // uma fatia com ângulo ~2π (categoria/subcategoria única, ou foco numa categoria) degenera
  // no arco SVG (ponto inicial == ponto final); parte em duas metades de π quando isso ocorre.
  function arcoOuCheio(a0, a1, rIn, rOut, cx, cy) {
    if (a1 - a0 >= 2 * Math.PI - 1e-6) {
      const am = a0 + Math.PI;
      return arcoAnel(a0, am, rIn, rOut, cx, cy) + " " + arcoAnel(am, a1, rIn, rOut, cx, cy);
    }
    return arcoAnel(a0, a1, rIn, rOut, cx, cy);
  }
  // subdivide o arco [a0,a1] de uma categoria entre as subs dela + "sem subcategoria" (resto).
  // categoria sem nenhuma sub cai no caso subs.length===0: um único segmento atenuado com
  // v = cat.v cobrindo o arco inteiro (o "atenuado naquele arco" do brief).
  function fatiasSub(cat, a0, a1, subMap) {
    const subs = (subMap.get(cat.nm) || []).slice().sort((a, b) => b.v - a.v);
    const somaSubs = subs.reduce((a, s) => a + s.v, 0);
    const semSub = Math.max(0, cat.v - somaSubs);
    const itens = subs.map(s => ({ nm: s.nm, v: s.v, semSub: false }));
    if (semSub > 1e-9 || itens.length === 0) itens.push({ nm: null, v: semSub || cat.v, semSub: true });
    const total = itens.reduce((a, i) => a + i.v, 0) || 1;
    const span = a1 - a0;
    let ini = a0;
    return itens.map((it, i) => {
      const fim = i === itens.length - 1 ? a1 : ini + span * (it.v / total); // última fecha exato em a1
      const seg = { ...it, a0: ini, a1: fim };
      ini = fim;
      return seg;
    });
  }

  function drawSunburst() {
    let cats = despesaPorMacro();
    const el = $("#donut"), lst = $("#catlist");
    if (!cats.length) { el.innerHTML = `<p class="vazio">sem despesas</p>`; lst.innerHTML = ""; estado.sunburstFoco = null; return; }
    if (cats.length > 7) { const top = cats.slice(0, 6); const out = cats.slice(6).reduce((a, c) => a + c.v, 0); cats = [...top, { nm: "Outros", v: out }]; }

    // se a categoria em foco não existe mais na visão atual (mudou o mês/filtro), reseta.
    const focoPedido = estado.sunburstFoco;
    if (focoPedido && !cats.some(c => c.nm === focoPedido)) estado.sunburstFoco = null;
    const foco = estado.sunburstFoco;
    const viewCats = foco ? cats.filter(c => c.nm === foco) : cats;
    const total = viewCats.reduce((a, c) => a + c.v, 0);

    const subMap = subPorMacro();
    const cx = 76, cy = 76;
    const rC0 = 24, rC1 = 44; // anel interno: categoria
    const rS0 = 46, rS1 = 64; // anel externo: subcategoria

    let a0 = -Math.PI / 2;
    const itens = viewCats.map(c => { const a1 = a0 + 2 * Math.PI * c.v / total; const seg = { ...c, a0, a1 }; a0 = a1; return seg; });
    const segsPorCat = itens.map(c => fatiasSub(c, c.a0, c.a1, subMap));

    let catArcs = "", subArcs = "";
    itens.forEach((c, i) => {
      catArcs += `<path d="${arcoOuCheio(c.a0, c.a1, rC0, rC1, cx, cy)}" data-i="${i}" class="sb-cat" style="fill:var(${corDe(c.nm)});stroke:var(--surface);cursor:pointer" stroke-width="2"/>`;
      segsPorCat[i].forEach((s, j) => {
        // tom do anel externo: opacidade decrescente por sub (distingue fatias da mesma cor);
        // "sem subcategoria" fica bem atenuada — é o caso "categoria sem sub" quando é a única.
        const op = s.semSub ? 0.22 : Math.max(0.35, 0.85 - j * 0.15);
        subArcs += `<path d="${arcoOuCheio(s.a0, s.a1, rS0, rS1, cx, cy)}" data-ci="${i}" data-si="${j}" class="sb-sub" style="fill:var(${corDe(c.nm)});stroke:var(--surface)" stroke-width="1.5" opacity="${op}"/>`;
      });
    });

    const centro = foco
      ? `<text x="76" y="70" text-anchor="middle" font-size="9" style="font-family:var(--mono);fill:var(--mut)">${esc(foco)}</text>
         <text x="76" y="88" text-anchor="middle" font-size="14" font-weight="600" style="font-family:var(--mono);fill:var(--ink)">${BRL(total).replace("R$ ", "")}</text>`
      : `<text x="76" y="72" text-anchor="middle" font-size="10" style="font-family:var(--mono);fill:var(--mut)">total</text>
         <text x="76" y="88" text-anchor="middle" font-size="15" font-weight="600" style="font-family:var(--mono);fill:var(--ink)">${BRL(total).replace("R$ ", "")}</text>`;

    el.innerHTML = `<svg viewBox="0 0 152 152" width="152" height="152" role="img" aria-label="Gastos por categoria e subcategoria">
      ${subArcs}${catArcs}
      <circle cx="76" cy="76" r="${rC0}" class="sb-center" style="fill:transparent;cursor:${foco ? "pointer" : "default"}"/>
      ${centro}</svg>`;

    // hover: categoria (anel interno) — nome + valor + % do total da visão atual.
    el.querySelectorAll(".sb-cat").forEach(p => {
      p.addEventListener("mousemove", e => { const c = itens[+p.dataset.i]; showTip(e, `<b>${esc(c.nm)}</b><br>${BRL(c.v)} · ${(100 * c.v / total).toFixed(0)}%`); });
      p.addEventListener("mouseleave", hideTip);
      // clique numa categoria foca (2º clique na já focada desfoca — sem isso o único jeito
      // de voltar seria acertar o centro, que fica pequeno quando a fatia toma o círculo todo).
      p.addEventListener("click", () => {
        const c = itens[+p.dataset.i];
        estado.sunburstFoco = (estado.sunburstFoco === c.nm) ? null : c.nm;
        drawSunburst();
      });
    });
    // hover: subcategoria (anel externo) — "categoria › sub" (ou "sem subcategoria").
    el.querySelectorAll(".sb-sub").forEach(p => {
      p.addEventListener("mousemove", e => {
        const ci = +p.dataset.ci, si = +p.dataset.si, c = itens[ci], s = segsPorCat[ci][si];
        const rotulo = s.semSub ? `${esc(c.nm)} › sem subcategoria` : `${esc(c.nm)} › ${esc(s.nm)}`;
        showTip(e, `<b>${rotulo}</b><br>${BRL(s.v)} · ${(100 * s.v / total).toFixed(0)}%`);
      });
      p.addEventListener("mouseleave", hideTip);
    });
    // clique no centro reseta o foco (visão completa).
    el.querySelector(".sb-center").addEventListener("click", () => {
      if (estado.sunburstFoco) { estado.sunburstFoco = null; drawSunburst(); }
    });

    // legenda lateral sempre lista todas as categorias (não só a focada); a focada fica em
    // negrito, e clicar numa linha também foca/desfoca — atalho alternativo à fatia no anel.
    lst.innerHTML = cats.map(c => `<div class="catrow" data-nm="${esc(c.nm)}" style="cursor:pointer"><i class="dot" style="background:var(${corDe(c.nm)})"></i><span class="nm" style="font-weight:${c.nm === foco ? 700 : 400}">${esc(c.nm)}</span><span class="vl">${BRL(c.v)}</span></div>`).join("");
    lst.querySelectorAll(".catrow").forEach(row => {
      row.addEventListener("click", () => {
        const nm = row.dataset.nm;
        estado.sunburstFoco = (estado.sunburstFoco === nm) ? null : nm;
        drawSunburst();
      });
    });
  }

  // ----- waterfall -----
  function drawWaterfall() {
    const receita = +(estado.resumo.kpis?.receita || 0);
    const cats = despesaPorMacro();
    const steps = construirWaterfall(receita, cats);
    const W = 560, H = 240, pl = 8, pr = 8, pb = 44, iw = W - pl - pr, ih = H - 14 - pb;
    const el = $("#waterfall");
    // domínio [lo, hi] inclui o piso negativo (quando a despesa supera a receita, o
    // saldo/parciais ficam < 0); sem isso as barras são calculadas fora do viewBox.
    const hi = Math.max(1, ...steps.map(s => s.hi)) * 1.05;
    const lo = Math.min(0, ...steps.map(s => s.lo)) * 1.05;
    const Y = v => 14 + ih * (hi - v) / (hi - lo);
    const gap = iw / steps.length, bw = gap * 0.6;
    let bars = "", labels = "", conn = "";
    steps.forEach((s, i) => {
      const x = pl + gap * i + (gap - bw) / 2;
      const y = Y(s.hi), h = Math.max(Y(s.lo) - Y(s.hi), 1);
      const col = s.tipo === "receita" ? "var(--receita)" : s.tipo === "saldo" ? "var(--pos)" : "var(--despesa)";
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" data-i="${i}" style="fill:${col}"/>`;
      const nm = s.nm.length > 8 ? s.nm.slice(0, 7) + "…" : s.nm;
      labels += `<text class="axis" x="${(x + bw / 2).toFixed(1)}" y="${H - 26}" text-anchor="middle">${esc(nm)}</text>`;
      const valor = s.tipo === "despesa" ? s.hi - s.lo : s.hi;
      labels += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="10" style="font-family:var(--mono);fill:var(--mut)">${kf(valor)}</text>`;
      if (i > 0 && steps[i].tipo !== "receita") { const px = pl + gap * (i - 1) + (gap - bw) / 2 + bw; const yp = Y(steps[i - 1].lo); conn += `<line x1="${px.toFixed(1)}" y1="${yp.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yp.toFixed(1)}" stroke-width="1" stroke-dasharray="2 2" style="stroke:var(--line)"/>`; }
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="De onde vem, pra onde vai">${conn}${bars}${labels}</svg>`;
    el.querySelectorAll("rect").forEach(rc => {
      rc.addEventListener("mousemove", e => { const s = steps[+rc.dataset.i]; const v = s.tipo === "despesa" ? -(s.hi - s.lo) : s.hi; showTip(e, `<b>${esc(s.nm)}</b><br>${v < 0 ? "−" : ""}${BRL(Math.abs(v))}`); });
      rc.addEventListener("mouseleave", hideTip);
    });
  }

  // ----- dumbbell mês vs anterior -----
  function drawDumbbell() {
    const rows = (estado.resumo.mesVsAnterior || []).map(r => ({ nm: r.macro, ant: +r.ant, atual: +r.atual })).sort((a, b) => b.atual - a.atual);
    const el = $("#dumb");
    if (!rows.length) { el.innerHTML = `<p class="vazio">sem despesas nos últimos meses</p>`; return; }
    const max = Math.max(1, ...rows.flatMap(r => [r.ant, r.atual])) * 1.06;
    el.innerHTML = rows.map((r, i) => {
      const xa = (130 * r.ant / max).toFixed(1), xn = (130 * r.atual / max).toFixed(1);
      const lo = Math.min(+xa, +xn).toFixed(1), hi = Math.max(+xa, +xn).toFixed(1);
      const d = deltaPct(r.ant, r.atual), up = d >= 0;
      return `<div class="dbrow" data-i="${i}">
        <span class="dblabel">${esc(r.nm)}</span>
        <svg class="dbtrack" viewBox="0 0 130 18" role="img" aria-label="${esc(r.nm)}">
          <line x1="${lo}" y1="9" x2="${hi}" y2="9" stroke-width="2.5" style="stroke:var(--line)"/>
          <circle cx="${xa}" cy="9" r="4.5" style="fill:var(--dim)"/>
          <circle cx="${xn}" cy="9" r="4.5" style="fill:var(--accent)"/>
        </svg>
        <span class="dbnums">${kf(r.ant)} → <b>${kf(r.atual)}</b></span>
        <span class="dbdelta" style="color:var(${up ? "--neg" : "--pos"})">${up ? "▲" : "▼"} ${Math.abs(d).toFixed(0)}%</span>
      </div>`;
    }).join("");
    el.querySelectorAll(".dbrow").forEach(row => {
      const r = rows[+row.dataset.i], d = deltaPct(r.ant, r.atual);
      row.addEventListener("mousemove", e => showTip(e, `<b>${esc(r.nm)}</b><br>anterior ${BRL(r.ant)}<br>atual ${BRL(r.atual)}<br>${d >= 0 ? "+" : ""}${d.toFixed(1)}%`));
      row.addEventListener("mouseleave", hideTip);
    });
  }

  // ----- Inc 4.5 Tarefa 9: gasto por pessoa — rosca (mesma mecânica de arco do drawDonut),
  // com o total das despesas no centro; legenda reusa .catlist/.catrow (mesmo estilo do
  // donut de categorias) com valor e percentual por pessoa. Substitui a barra de drawPessoa.
  function drawPessoaDonut() {
    const rows = agruparPorPessoa(estado.resumo.porPessoa || []);
    const el = $("#pessoa");
    if (!rows.length) { el.innerHTML = `<p class="vazio">sem despesas no período</p>`; return; }
    const cores = construirCores(rows.map(r => r.pessoa));
    const total = rows.reduce((a, r) => a + r.despesa, 0);
    const R = 64, r = 40, cx = 76, cy = 76;
    let a0 = -Math.PI / 2, arcs = "";
    rows.forEach((row, i) => {
      const a1 = a0 + 2 * Math.PI * row.despesa / (total || 1);
      const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0), x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
      const xi1 = cx + r * Math.cos(a1), yi1 = cy + r * Math.sin(a1), xi0 = cx + r * Math.cos(a0), yi0 = cy + r * Math.sin(a0);
      const laf = (a1 - a0) > Math.PI ? 1 : 0;
      arcs += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${R},${R} 0 ${laf} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${xi1.toFixed(1)},${yi1.toFixed(1)} A${r},${r} 0 ${laf} 0 ${xi0.toFixed(1)},${yi0.toFixed(1)} Z" stroke-width="2" data-i="${i}" style="fill:var(${cores[row.pessoa]});stroke:var(--surface)"/>`;
      a0 = a1;
    });
    el.innerHTML = `<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      <svg viewBox="0 0 152 152" width="152" height="152" role="img" aria-label="Gasto por pessoa">${arcs}
        <text x="76" y="72" text-anchor="middle" font-size="10" style="font-family:var(--mono);fill:var(--mut)">total</text>
        <text x="76" y="88" text-anchor="middle" font-size="15" font-weight="600" style="font-family:var(--mono);fill:var(--ink)">${BRL(total).replace("R$ ", "")}</text></svg>
      <div class="catlist" id="pessoalist" style="flex:1;min-width:150px"></div>
    </div>`;
    el.querySelectorAll("path").forEach(p => {
      p.addEventListener("mousemove", e => {
        const row = rows[+p.dataset.i];
        const pct = total ? (100 * row.despesa / total).toFixed(0) : "0";
        showTip(e, `<b>${esc(row.pessoa)}</b><br>Despesa ${BRL(row.despesa)} · ${pct}%<br>Receita ${BRL(row.receita)}<br>Saldo ${BRL(row.saldo)}`);
      });
      p.addEventListener("mouseleave", hideTip);
    });
    $("#pessoalist").innerHTML = rows.map(row => {
      const pct = total ? (100 * row.despesa / total).toFixed(0) : "0";
      return `<div class="catrow"><i class="dot" style="background:var(${cores[row.pessoa]})"></i><span class="nm">${esc(row.pessoa)}</span><span class="vl">${BRL(row.despesa)} · ${pct}%</span></div>`;
    }).join("");
  }

  // ----- Inc 4.5 Tarefa 9: orçamento × realizado por categoria (bullet chart) -----
  // Uma linha por categoria com alvo definido no mês (estado.metasMes.linhas, já carregado
  // pra Tarefa 7/Planejamento): barra = realizado, marcador vertical = orçamento, cor da
  // barra pelo mesmo status (normal/aviso/estouro) usado na tela de Planejamento.
  function corStatusBullet(status) {
    return status === "estouro" ? "--neg" : status === "aviso" ? "--aviso" : "--ink";
  }
  function drawBullet() {
    const el = $("#bullet");
    const todas = (estado.metasMes && estado.metasMes.linhas) || [];
    const linhas = todas.filter(l => l.alvo_cents != null);
    if (!linhas.length) { el.innerHTML = `<p class="vazio">sem orçamento no mês</p>`; return; }
    // razão realizado/alvo p/ ordenar por estouro; alvo=0 com gasto vira "infinito" (pior caso),
    // alvo=0 sem gasto fica em 0 — mesmo tratamento de statusCelula pro caso alvo=0.
    const razao = l => l.alvo_cents === 0 ? (l.realizado_cents > 0 ? Infinity : 0) : l.realizado_cents / l.alvo_cents;
    const ordenadas = linhas.slice().sort((a, b) => razao(b) - razao(a));
    const W = 200, H = 20;
    el.innerHTML = ordenadas.map((l, i) => {
      // escala por linha (não comum): categorias de porte muito diferente (aluguel vs lazer)
      // ficariam ilegíveis numa escala única — max(realizado,alvo)*1.1 dá folga pro marcador.
      const escala = Math.max(l.realizado_cents, l.alvo_cents, 1) * 1.1;
      const barraW = Math.min(W, W * l.realizado_cents / escala);
      const marcaX = Math.min(W, W * l.alvo_cents / escala);
      return `<div class="bulletrow" data-i="${i}">
        <span class="bulletlabel">${esc(l.categoria)}</span>
        <svg class="bullettrack" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(l.categoria)}">
          <rect x="0" y="4" width="${W}" height="12" rx="3" style="fill:var(--sunk)"/>
          <rect x="0" y="4" width="${barraW.toFixed(1)}" height="12" rx="3" style="fill:var(${corStatusBullet(l.status)})"/>
          <line x1="${marcaX.toFixed(1)}" y1="0" x2="${marcaX.toFixed(1)}" y2="${H}" stroke-width="2" style="stroke:var(--ink)"/>
        </svg>
        <span class="bulletval">${BRL(l.realizado_cents / 100)} / ${BRL(l.alvo_cents / 100)}</span>
      </div>`;
    }).join("");
    el.querySelectorAll(".bulletrow").forEach(row => {
      const l = ordenadas[+row.dataset.i];
      const diff = l.alvo_cents - l.realizado_cents;
      row.addEventListener("mousemove", e => showTip(e,
        `<b>${esc(l.categoria)}</b><br>Realizado ${BRL(l.realizado_cents / 100)}<br>Orçamento ${BRL(l.alvo_cents / 100)}<br>${diff >= 0 ? "Falta" : "Estourou"} ${BRL(Math.abs(diff) / 100)}`));
      row.addEventListener("mouseleave", hideTip);
    });
  }

  // ----- tabela de lançamentos -----
  function fmtData(d) { const s = String(d).slice(0, 10); const [a, m, dia] = s.split("-"); return `${dia}/${m}/${a}`; }

  // opções de Categoria/Pessoa dependem dos dados carregados; repopula em carregar()
  // preservando a seleção atual (o filtro não é resetado ao trocar de período).
  function popularFiltros() {
    // lista as categorias do catálogo (ativas), não as chaves de estado.cores: cores pode
    // conter nomes de categorias já desativadas que ainda aparecem em transações antigas.
    const nomes = estado.catalogo.categorias.map(c => c.nome);
    $("#fcategoria").innerHTML = `<option value="">Categoria</option>` +
      nomes.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
    $("#fpessoa").innerHTML = `<option value="">Pessoa</option><option value="__sem__">Sem pessoa</option>` +
      estado.pessoas.map(p => `<option value="${esc(p.nome)}">${esc(p.nome)}</option>`).join("");
    $("#fcategoria").value = estado.filtro.categoria;
    $("#fpessoa").value = estado.filtro.pessoa;
    $("#forigem").value = estado.filtro.origem;
    $("#fcomputa").value = estado.filtro.computa;
    $("#ftexto").value = estado.filtro.texto;
  }

  function drawRows() {
    const cats = estado.catalogo.categorias;
    const linhas = filtrarTransacoes(estado.transacoes, estado.filtro);
    const contador = $("#fcontador");
    if (contador) contador.textContent = `${linhas.length} de ${estado.transacoes.length}`;
    if (!linhas.length) {
      $("#rows").innerHTML = `<tr><td colspan="9" class="vazio">nenhum lançamento com esses filtros</td></tr>`;
      atualizarMassaBar();
      return;
    }
    $("#rows").innerHTML = linhas.map(t => {
      const rec = t.natureza === "receita";
      const sel = estado.selecao.has(t.id) ? "checked" : "";
      const catOpts = cats.map(c => `<option value="${esc(c.id)}" ${c.id === t.categoria_id ? "selected" : ""}>${esc(c.nome)}</option>`).join("");
      const subOpts = `<option value="">—</option>` +
        subsDaCat(estado.catalogo, t.categoria_id).map(s => `<option value="${esc(s.id)}" ${s.id === t.subcategoria_id ? "selected" : ""}>${esc(s.nome)}</option>`).join("");
      const pessoaOpts = `<option value="">—</option>` +
        estado.pessoas.map(p => `<option value="${esc(p.id)}" ${p.id === t.pessoa_id ? "selected" : ""}>${esc(p.nome)}</option>`).join("");
      // fora do resumo (extrato/fatura não-gasto: transferência, pagamento de fatura etc.) — selo
      // só aparece quando computa_resumo é false; o toggle (botão) inverte o valor nas duas direções.
      const selo = !t.computa_resumo ? `<span class="selo-fora">fora do resumo</span>` : "";
      return `<tr data-id="${t.id}">
        <td class="selcol"><input type="checkbox" class="selrow" ${sel}></td>
        <td class="dt">${fmtData(t.data)}</td>
        <td><input class="eddesc" value="${esc(t.descricao || "")}" placeholder="—">${selo}</td>
        <td><span class="macrochip"><i class="dot" style="background:var(${corDe(t.categoria)})"></i><select class="edcat">${catOpts}</select></span></td>
        <td><select class="edsub">${subOpts}</select></td>
        <td><select class="edpessoa">${pessoaOpts}</select></td>
        <td class="val" style="color:${rec ? "var(--receita)" : "var(--ink)"}">${rec ? "+" : ""}R$ ${centavosBR(t.valor_total)}</td>
        <td class="val" style="color:var(--mut)">${+t.valor_reembolso ? "R$ " + centavosBR(t.valor_reembolso) : "—"}</td>
        <td>
          <button class="toggle-computa" title="${t.computa_resumo ? "Marcar fora do resumo" : "Incluir no resumo"}">${t.computa_resumo ? "⊘" : "↩"}</button>
          <button class="del" title="Apagar">✕</button>
        </td>
      </tr>`;
    }).join("");
    atualizarMassaBar();
  }

  // ids atualmente visíveis (respeitando o filtro) — base do "selecionar todos".
  function idsFiltrados() {
    return filtrarTransacoes(estado.transacoes, estado.filtro).map(t => t.id);
  }

  // atualiza a barra de massa: contagem, visibilidade e o estado do "selecionar todos".
  function atualizarMassaBar() {
    const n = estado.selecao.size;
    const bar = $("#massabar");
    if (bar) bar.classList.toggle("hidden", n === 0);
    const cnt = $("#massacount");
    if (cnt) cnt.textContent = `${n} selecionado${n === 1 ? "" : "s"}`;
    const selall = $("#selall");
    if (selall) {
      const vis = idsFiltrados();
      const todos = vis.length > 0 && vis.every(id => estado.selecao.has(id));
      selall.checked = todos;
      selall.indeterminate = n > 0 && !todos;
    }
  }

  // popula os selects da barra de massa a partir do catálogo/pessoas (chamado no carregar).
  function popularMassaBar() {
    const cats = estado.catalogo.categorias;
    const mcat = $("#mcat"); if (mcat) mcat.innerHTML =
      `<option value="__nao__">Categoria: não mexer</option>` +
      cats.map(c => `<option value="${esc(c.id)}">${esc(c.nome)}</option>`).join("");
    const msub = $("#msub"); if (msub) msub.innerHTML = `<option value="">Subcategoria: —</option>`;
    const mp = $("#mpessoa"); if (mp) mp.innerHTML =
      `<option value="__nao__">Pessoa: não mexer</option><option value="">— (limpar) —</option>` +
      estado.pessoas.map(p => `<option value="${esc(p.id)}">${esc(p.nome)}</option>`).join("");
  }

  // ----- Ajustes (gestão de categorias/subcategorias/pessoas) -----
  // 1ª versão: prompt()/confirm() nativos — funcional, não bonito; o Caio refina depois.
  function drawAjustes() {
    const cats = estado.catalogo.categorias;
    const catBlocos = cats.map(c => {
      const subChips = subsDaCat(estado.catalogo, c.id).map(s => `
        <span class="subchip" data-id="${esc(s.id)}">
          ${esc(s.nome)}
          <button class="miniBtn" data-act="renomeiasub" data-id="${esc(s.id)}" title="Renomear">✎</button>
          <button class="miniBtn" data-act="mesclarsub" data-id="${esc(s.id)}" title="Mesclar em outra sub">⇄</button>
          <button class="miniBtn" data-act="apagarsub" data-id="${esc(s.id)}" title="Desativar">✕</button>
        </span>`).join("");
      return `<div class="ajcat">
        <div class="ajcathead">
          <b>${esc(c.nome)}</b><span class="ajnat">${esc(c.natureza)}</span>
          <span class="ajactions">
            <button class="miniBtn" data-act="renomeiacat" data-id="${esc(c.id)}">renomear</button>
            <button class="miniBtn" data-act="apagarcat" data-id="${esc(c.id)}">desativar</button>
          </span>
        </div>
        <div class="ajsubs">${subChips}<button class="chip" data-act="novasub" data-id="${esc(c.id)}" type="button">＋ sub</button></div>
      </div>`;
    }).join("");
    const pessoaBlocos = estado.pessoas.map(p => `<div class="ajrow">
        <span>${esc(p.nome)}</span>
        <span class="ajactions">
          <button class="miniBtn" data-act="renomeiapessoa" data-id="${esc(p.id)}">renomear</button>
          <button class="miniBtn" data-act="apagarpessoa" data-id="${esc(p.id)}">desativar</button>
        </span>
      </div>`).join("");
    $("#ajustes").innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="cardhead">
          <div><h2>Categorias</h2><p class="sub">categorias e subcategorias usadas na classificação</p></div>
          <button class="chip" id="ajnovacat" type="button">＋ categoria</button>
        </div>
        <div id="ajcats">${catBlocos || `<p class="vazio">sem categorias</p>`}</div>
      </div>
      <div class="card">
        <div class="cardhead">
          <div><h2>Pessoas</h2><p class="sub">quem aparece no corte "gasto por pessoa"</p></div>
          <button class="chip" id="ajnovapessoa" type="button">＋ pessoa</button>
        </div>
        <div id="ajpessoas">${pessoaBlocos || `<p class="vazio">sem pessoas</p>`}</div>
      </div>`;
  }

  $("#ajustes").addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    const cats = estado.catalogo.categorias, subs = estado.catalogo.subcategorias;
    try {
      if (b.id === "ajnovacat") {
        const nome = prompt("Nome da nova categoria:");
        if (!nome || !nome.trim()) return;
        let natureza = (prompt("Natureza (despesa/receita):", "despesa") || "despesa").trim().toLowerCase();
        if (natureza !== "despesa" && natureza !== "receita") natureza = "despesa";
        await apiPost("/api/categorias", { nome: nome.trim(), natureza });
      } else if (b.id === "ajnovapessoa") {
        const nome = prompt("Nome da nova pessoa:");
        if (!nome || !nome.trim()) return;
        await apiPost("/api/pessoas", { nome: nome.trim() });
      } else if (b.dataset.act === "novasub") {
        const nome = prompt("Nome da nova subcategoria:");
        if (!nome || !nome.trim()) return;
        await apiPost("/api/subcategorias", { categoria_id: b.dataset.id, nome: nome.trim() });
      } else if (b.dataset.act === "renomeiacat") {
        const c = cats.find(x => x.id === b.dataset.id); if (!c) return;
        const nome = prompt("Novo nome:", c.nome);
        if (!nome || !nome.trim() || nome.trim() === c.nome) return;
        await apiPatch(`/api/categorias/${c.id}`, { nome: nome.trim() });
      } else if (b.dataset.act === "apagarcat") {
        const c = cats.find(x => x.id === b.dataset.id); if (!c) return;
        if (!confirm(`Desativar a categoria "${c.nome}"? Lançamentos existentes mantêm a referência.`)) return;
        await apiDelete(`/api/categorias/${c.id}`);
      } else if (b.dataset.act === "renomeiasub") {
        const s = subs.find(x => x.id === b.dataset.id); if (!s) return;
        const nome = prompt("Novo nome:", s.nome);
        if (!nome || !nome.trim() || nome.trim() === s.nome) return;
        await apiPatch(`/api/subcategorias/${s.id}`, { nome: nome.trim() });
      } else if (b.dataset.act === "mesclarsub") {
        const s = subs.find(x => x.id === b.dataset.id); if (!s) return;
        const destNome = prompt(`Mesclar "${s.nome}" em qual subcategoria (nome exato, mesma categoria)?`);
        if (!destNome || !destNome.trim()) return;
        const destino = subs.find(x => x.categoria_id === s.categoria_id && x.nome === destNome.trim());
        if (!destino) { alert("Subcategoria de destino não encontrada nessa categoria."); return; }
        if (destino.id === s.id) return;
        if (!confirm(`Mover os lançamentos de "${s.nome}" para "${destino.nome}" e desativar "${s.nome}"?`)) return;
        await apiPost("/api/subcategorias/merge", { origem_id: s.id, destino_id: destino.id });
      } else if (b.dataset.act === "apagarsub") {
        const s = subs.find(x => x.id === b.dataset.id); if (!s) return;
        if (!confirm(`Desativar a subcategoria "${s.nome}"?`)) return;
        await apiDelete(`/api/subcategorias/${s.id}`);
      } else if (b.dataset.act === "renomeiapessoa") {
        const p = estado.pessoas.find(x => x.id === b.dataset.id); if (!p) return;
        const nome = prompt("Novo nome:", p.nome);
        if (!nome || !nome.trim() || nome.trim() === p.nome) return;
        await apiPatch(`/api/pessoas/${p.id}`, { nome: nome.trim() });
      } else if (b.dataset.act === "apagarpessoa") {
        const p = estado.pessoas.find(x => x.id === b.dataset.id); if (!p) return;
        if (!confirm(`Desativar a pessoa "${p.nome}"?`)) return;
        await apiDelete(`/api/pessoas/${p.id}`);
      } else {
        return;
      }
      // recarrega tudo (catálogo, pessoas, cores, tabela) e redesenha a própria aba
      await carregar();
      drawAjustes();
    } catch (err) { alert("Falha: " + err.message); }
  });

  // ----- Inc 4: Planejamento (tela do mês — alvo vs realizado) -----
  // Espelha parseBRtoCents de worker/money.js (vírgula/ponto → centavos): teclado BR entrega
  // vírgula, e o campo é type="text"+inputmode="decimal" (regra do CLAUDE.md), então precisa
  // de um parser aqui mesmo — este arquivo não importa código do Worker.
  function parseBRtoCentsUI(str) {
    if (typeof str !== "string") return null;
    let s = str.replace(/R\$\s*/i, "").trim();
    if (!s) return null;
    if (s.startsWith("-")) return null; // valor de meta é sempre positivo
    s = s.replace(/\./g, ""); // remove separador de milhar
    if (s.includes(",")) s = s.replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  }

  const apiPut = (p, body) => fetch(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(r => { if (!r.ok) throw new Error(`PUT ${p} ${r.status}`); return r; });

  // Inc 4.5 Tarefa 3: soma N meses a um 'YYYY-MM' com aritmética local — evita importar
  // mesAnterior (backend, worker/metas.js) só pra calcular o fim da janela da grade.
  function somarMeses(mes, n) {
    const [a, m] = mes.split("-").map(Number);
    const total = (m - 1) + n;
    const ano = a + Math.floor(total / 12);
    const mesNovo = ((total % 12) + 12) % 12 + 1;
    return `${ano}-${String(mesNovo).padStart(2, "0")}`;
  }

  // Inc 4.5 Tarefa 3: replica statusMeta (worker/metas.js) no front pra colorir a grade
  // sem precisar que o /api/metas/grade devolva status por célula.
  function statusCelula(realizado_cents, alvo_cents) {
    if (realizado_cents == null || alvo_cents == null) return ""; // futuro ou sem alvo: neutro
    if (alvo_cents === 0) return realizado_cents > 0 ? "status-estouro" : "status-normal";
    const frac = realizado_cents / alvo_cents;
    if (frac > 1) return "status-estouro";
    if (frac >= 0.8) return "status-aviso";
    return "status-normal";
  }

  async function renderPlanejamento() {
    // Inc 4.5 Tarefa 3: mês próprio (#planMes) removido — a tela segue estado.mes,
    // que é a mesma fonte do seletor global #mesSel (Tarefa 2).
    const mes = estado.mes;
    const [dados, sug] = await Promise.all([
      apiGet(`/api/metas?mes=${mes}`),
      apiGet(`/api/metas/sugestao?mes=${mes}`),
    ]);
    const sugPorCat = {};
    for (const s of sug.linhas) sugPorCat[s.categoria_id] = s.sugestao_cents;

    const tbody = $("#planTabela tbody");
    tbody.innerHTML = dados.linhas.map(l => {
      const alvo = l.alvo_cents == null ? "" : centavosBR(l.alvo_cents / 100 + "");
      const placeholder = l.alvo_cents == null && sugPorCat[l.categoria_id] != null
        ? `sug. ${centavosBR(sugPorCat[l.categoria_id] / 100 + "")}` : "definir";
      const realizado = centavosBR(l.realizado_cents / 100 + "");
      const barra = l.alvo_cents ? Math.min(100, Math.round(100 * l.realizado_cents / l.alvo_cents)) : 0;
      const diff = l.diff_cents == null ? "—"
        : (l.diff_cents >= 0 ? `falta ${centavosBR(l.diff_cents / 100 + "")}` : `estourou ${centavosBR(-l.diff_cents / 100 + "")}`);
      const selo = l.origem === "excecao" ? ` <span class="selo-excecao" title="ajuste só deste mês">exceção</span>` : "";
      return `<tr data-cat="${l.categoria_id}">
        <td>${esc(l.categoria)}${selo}</td>
        <td><input class="planAlvo" type="text" inputmode="decimal" value="${alvo}" placeholder="${placeholder}" data-sug="${sugPorCat[l.categoria_id] ?? ""}"></td>
        <td>${realizado}</td>
        <td class="status-${l.status}"><div class="planbar"><i style="width:${barra}%"></i></div>${diff}</td>
      </tr>`;
    }).join("");

    const tfoot = $("#planTabela tfoot");
    tfoot.innerHTML = `<tr><td>Total</td>
      <td>${centavosBR(dados.total.alvo_cents / 100 + "")}</td>
      <td>${centavosBR(dados.total.realizado_cents / 100 + "")}</td>
      <td>${dados.total.diff_cents >= 0 ? "falta" : "estourou"} ${centavosBR(Math.abs(dados.total.diff_cents) / 100 + "")}</td></tr>`;

    await renderGrade();
  }

  // ----- Inc 4 Tarefa 8 / Inc 4.5 Tarefa 3: grade categorias × meses (visão secundária,
  // recolhível) — ancorada em estado.mes, 12 meses à frente, com ano no rótulo e cor por
  // célula (status de estouro/aviso/normal, igual à tela do mês). -----
  async function renderGrade() {
    const de = estado.mes;
    const ate = somarMeses(de, 11); // 12 colunas: de..ate inclusive
    const g = await apiGet(`/api/metas/grade?de=${de}&ate=${ate}`);
    const head = `<thead><tr><th>Categoria</th>${g.meses.map(m => `<th>${mesLabelAno(m)}</th>`).join("")}</tr></thead>`;
    const body = g.categorias.map(c => {
      const tds = c.celulas.map(cel => {
        const alvo = cel.alvo_cents == null ? "" : centavosBR(cel.alvo_cents / 100 + "");
        const real = cel.realizado_cents == null ? "" : `<small>${centavosBR(cel.realizado_cents / 100 + "")}</small>`;
        const status = statusCelula(cel.realizado_cents, cel.alvo_cents);
        return `<td class="${status}"><input class="gAlvo" type="text" inputmode="decimal" value="${alvo}" data-cat="${c.categoria_id}" data-mes="${cel.mes}">${real}</td>`;
      }).join("");
      return `<tr><td>${esc(c.categoria)}</td>${tds}</tr>`;
    }).join("");
    $("#planGrade").innerHTML = head + `<tbody>${body}</tbody>`;
  }

  // editar célula da grade = baseline a partir daquele mês ("daqui pra frente")
  $("#planGrade").addEventListener("change", async (e) => {
    if (!e.target.classList.contains("gAlvo")) return;
    const cents = parseBRtoCentsUI(e.target.value.trim());
    if (cents == null) return;
    try {
      await apiPut(`/api/metas`, { categoria_id: e.target.dataset.cat, mes: e.target.dataset.mes, valor_cents: cents, escopo: "baseline" });
    } catch (err) { alert("Falha ao salvar: " + err.message); }
    renderPlanejamento(); // re-render mês + grade
  });

  // salvar alvo: pergunta o escopo (só este mês vs deste mês em diante)
  $("#planTabela").addEventListener("change", async (e) => {
    if (!e.target.classList.contains("planAlvo")) return;
    const tr = e.target.closest("tr");
    const categoria_id = tr.dataset.cat;
    const mes = estado.mes;
    const raw = e.target.value.trim();
    if (raw === "") { // limpar → apaga exceção do mês (baseline permanece)
      await apiDelete(`/api/metas?categoria_id=${categoria_id}&mes=${mes}&escopo=excecao`).catch(() => {});
      return renderPlanejamento();
    }
    const cents = parseBRtoCentsUI(raw);
    if (cents == null) { alert("Valor inválido"); return renderPlanejamento(); }
    const soEste = confirm("OK = só este mês (exceção)\nCancelar = deste mês em diante (baseline)");
    const escopo = soEste ? "excecao" : "baseline";
    try {
      await apiPut(`/api/metas`, { categoria_id, mes, valor_cents: cents, escopo });
    } catch (err) { alert("Falha ao salvar: " + err.message); }
    renderPlanejamento();
  });

  // "Sugerir pra todas": pré-preenche os campos vazios com a sugestão; NÃO grava (Caio revisa e salva).
  $("#planSugerir").addEventListener("click", () => {
    $("#planTabela").querySelectorAll(".planAlvo").forEach(inp => {
      if (inp.value.trim() === "" && inp.dataset.sug) inp.value = centavosBR(Number(inp.dataset.sug) / 100 + "");
    });
  });

  // ----- Importar (upload PDF → preview → revisão → aplicar; Task 9) -----
  function tabelaItens(titulo, itens, { comAmbiguo = false } = {}) {
    if (!itens.length) return "";
    const linhas = itens.map((it, i) => `
      <tr data-i="${i}">
        <td class="dt">${fmtData(it.data)}</td>
        <td>${esc(it.descricaoFinal ?? it.descricao)}</td>
        <td>${esc(it.categoriaOrg || it.categoriaNome || "Outros")}${it.subNome ? " › " + esc(it.subNome) : ""}</td>
        <td class="val">${it.natureza === "receita" ? "+" : ""}R$ ${centavosBR(String(it.valorCents / 100))}</td>
        ${comAmbiguo ? `<td><button class="chip impResolve" type="button" data-i="${i}">tratar como novo</button></td>` : "<td></td>"}
      </tr>`).join("");
    return `<div class="impgrupo">
      <h3>${esc(titulo)} <span class="impcount">${itens.length}</span></h3>
      <div class="tblwrap"><table><thead><tr>
        <th>Data</th><th>Descrição</th><th>Categoria</th><th style="text-align:right">Valor</th><th></th>
      </tr></thead><tbody>${linhas}</tbody></table></div>
    </div>`;
  }

  // mensagem de resultado do "Aplicar" (compartilhada pelos dois ramos de render de drawImportar).
  function msgResultado(r) {
    if (!r) return "";
    let extra = "";
    if (r.pagamentoMarcado != null) { // presente só em fatura
      extra = r.pagamentoMarcado
        ? " · pagamento da fatura no extrato marcado fora do resumo"
        : ` · pagamento no extrato não marcado automaticamente (${r.pagamentoCandidatos} candidato(s)) — ajuste em Lançamentos se preciso`;
    }
    return `<p class="impresultado">✅ gravados ${r.gravados} (${r.naoGasto} fora do resumo) · conciliados ${r.conciliados}${extra}. Atualize Resumo/Lançamentos para ver.</p>`;
  }

  function drawImportar() {
    const st = estado.importar;
    const preview = st.preview;
    const isFatura = st.tipo === "fatura";

    const controles = `
      <div class="card" style="margin-bottom:16px">
        <div class="cardhead"><div><h2>Importar extrato ou fatura (PDF)</h2><p class="sub">o PDF é lido no navegador; só o texto vai pro servidor</p></div></div>
        <div class="impctl">
          <select id="imptipo" aria-label="Tipo de importação">
            <option value="extrato" ${!isFatura ? "selected" : ""}>Extrato (conta corrente)</option>
            <option value="fatura" ${isFatura ? "selected" : ""}>Fatura (cartão)</option>
          </select>
          ${!isFatura
            ? `<input id="impconta" type="text" placeholder="conta (ex.: itau)" value="itau">`
            : `<input id="impano" type="text" inputmode="numeric" placeholder="ano" style="width:80px">
               <input id="impmes" type="text" inputmode="numeric" placeholder="mês" style="width:60px">`}
          <input id="imparquivo" type="file" accept="application/pdf">
          <button id="imppreview" class="chip" type="button">${st.carregando ? "Lendo…" : "Pré-visualizar"}</button>
        </div>
      </div>`;

    if (!preview) {
      $("#importar").innerHTML = controles + msgResultado(st.ultimoResultado);
      return;
    }

    const ok = podeAplicar(preview);
    const chk = preview.checksum || {};
    const diff = centavosBR(String(Math.abs(chk.diferencaCents ?? 0) / 100));
    const checksumHtml = chk.ok
      ? `<span class="impchk impchk-ok">✓ checksum confere</span>`
      : chk.bloqueiaAplicar
        ? `<span class="impchk impchk-bad">✕ checksum não bate (diferença R$ ${diff}) — aplicar desabilitado</span>`
        : `<span class="impchk impchk-warn">⚠ diferença de R$ ${diff} — provável IOF/encargos da fatura (não bloqueia)</span>`;

    const novos = preview.itens.filter(it => it.status === "novo");
    const casados = preview.itens.filter(it => it.status === "casado");
    const naoGasto = preview.itens.filter(it => it.status === "naoGasto");
    const ambiguos = preview.itens.filter(it => it.status === "ambiguo");
    const jaTem = preview.itens.filter(it => it.status === "jaTem");

    const resultado = msgResultado(st.ultimoResultado);

    $("#importar").innerHTML = controles + `
      <div class="card" style="margin-bottom:16px">
        <div class="cardhead"><div><h2>Preview</h2><p class="sub">${esc(resumoTexto(preview))}</p></div></div>
        ${checksumHtml}
        ${resultado}
        <div style="margin-top:14px">
          <button id="impaplicar" class="chip" type="button" ${ok ? "" : "disabled"}>Aplicar</button>
        </div>
      </div>
      ${tabelaItens("Novos", novos)}
      ${tabelaItens("Conciliados (já existem no extrato)", casados)}
      ${tabelaItens("Fora do resumo (transferência/pagamento de fatura)", naoGasto)}
      ${tabelaItens("Ambíguos — não serão aplicados, a menos que você trate como novo", ambiguos, { comAmbiguo: true })}
      ${tabelaItens("Já importados antes (ignorados)", jaTem)}
    `;
  }

  $("#importar").addEventListener("click", async e => {
    const st = estado.importar;
    if (e.target.id === "imppreview") {
      const arquivo = $("#imparquivo")?.files?.[0];
      if (!arquivo) { alert("Escolha um arquivo PDF."); return; }
      st.tipo = $("#imptipo").value;
      // Captura TODOS os valores do form ANTES de re-renderizar: drawImportar() (chamado logo
      // abaixo p/ mostrar "Lendo…") recria os inputs vazios, então ler conta/ano/mês depois dele
      // pegava string vazia (conta virava "conta", ano virava 0 → 500 no servidor).
      let conta = null, ano = null, mes = null;
      if (st.tipo === "extrato") {
        conta = $("#impconta").value || "conta";
      } else {
        ano = parseInt($("#impano").value, 10); mes = parseInt($("#impmes").value, 10);
        if (!ano || !mes || mes < 1 || mes > 12) { alert("Preencha ano (ex.: 2025) e mês (1–12) da fatura."); return; }
        st.ano = ano; st.mes = mes;
      }
      st.carregando = true; st.ultimoResultado = null; drawImportar();
      try {
        const buf = await arquivo.arrayBuffer();
        const modo = st.tipo === "fatura" ? "layout" : "simples";
        const texto = await extrairTextoPDF(buf, modo);
        const corpo = { tipo: st.tipo, texto };
        if (st.tipo === "extrato") corpo.conta = conta;
        else { corpo.ano = ano; corpo.mes = mes; }
        st.preview = await apiPost("/api/importar/preview", corpo);
      } catch (err) {
        alert("Falha ao ler/pré-visualizar: " + err.message);
      } finally {
        st.carregando = false; drawImportar();
      }
      return;
    }
    if (e.target.id === "impaplicar") {
      if (!podeAplicar(st.preview)) return;
      try {
        const decisao = montarDecisao(st.preview, estado.catalogo, st.tipo);
        const payload = { decisao };
        // fatura: manda o total impresso + ano/mês pro servidor achar o pagamento no extrato e
        // marcá-lo fora do resumo (evita contar o gasto do cartão duas vezes).
        if (st.tipo === "fatura") payload.fatura = { totalCents: st.preview.totalCents, ano: st.ano, mes: st.mes };
        st.ultimoResultado = await apiPost("/api/importar/aplicar", payload);
        st.preview = null; // evita reaplicar o mesmo lote sem novo preview
        drawImportar();
      } catch (err) {
        alert("Falha ao aplicar: " + err.message);
      }
      return;
    }
    if (e.target.classList.contains("impResolve")) {
      const tr = e.target.closest("tr"); if (!tr) return;
      const ambiguos = st.preview.itens.filter(it => it.status === "ambiguo");
      const item = ambiguos[+tr.dataset.i];
      if (item) { item.status = "novo"; item.matchId = null; }
      drawImportar();
    }
  });
  $("#importar").addEventListener("change", e => {
    if (e.target.id === "imptipo") { estado.importar.tipo = e.target.value; estado.importar.preview = null; drawImportar(); }
  });

  // Inc 4.5 Tarefa 2: range de datas p/ buscar TRANSAÇÕES (aba Lançamentos) — mês único
  // (rangeDoMes, da Tarefa 1) por padrão, ou janela aberta quando "Todos os meses" está
  // ligado. Mesmo estado.mes que agora também governa o Resumo (Tarefa 7).
  function transacoesRange() {
    if (estado.lancTudo) return { de: "1900-01-01", ate: "2999-12-31" };
    const { de, ateExcl } = rangeDoMes(estado.mes);
    // /api/transacoes filtra ate com "<=" (inclusivo) — rangeDoMes devolve o range
    // meio-aberto [de, ateExcl); volta 1 dia p/ obter o último dia do mês.
    const d = new Date(`${ateExcl}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return { de, ate: d.toISOString().slice(0, 10) };
  }

  // ----- carga e eventos -----
  async function carregar() {
    try {
      // Inc 4.5 Tarefa 7: Resumo fechou no mês (nada de presets) — mesmo estado.mes do
      // #mesSel. /api/metas devolve o alvo do mês, usado como orçamento em drawDiario.
      const qsResumo = `?mes=${estado.mes}`;
      const rt = transacoesRange();
      const qsTransacoes = `?de=${rt.de}&ate=${rt.ate}`;
      const [resumo, metasMes, transacoes, catalogo, pessoas] = await Promise.all([
        apiGet("/api/resumo" + qsResumo), apiGet("/api/metas" + qsResumo),
        apiGet("/api/transacoes" + qsTransacoes), apiGet("/api/catalogo"), apiGet("/api/pessoas"),
      ]);
      estado.resumo = resumo; estado.metasMes = metasMes; estado.transacoes = transacoes; estado.catalogo = catalogo; estado.pessoas = pessoas;
      // remove da seleção ids que sumiram (troca de período/recarga) — evita "selecionados" fantasmas
      const presentes = new Set(transacoes.map(t => t.id));
      for (const id of estado.selecao) if (!presentes.has(id)) estado.selecao.delete(id);
      // cores por nome de categoria: catálogo (pra sempre ter cor definida no select da Ajustes/filtro)
      // + nomes vindos das transações (cobre categoria já desativada que ainda aparece no histórico)
      const nomes = estado.catalogo.categorias.map(c => c.nome).concat(transacoes.map(t => t.categoria));
      estado.cores = construirCores(nomes);
      popularFiltros(); popularMassaBar();
      drawKPIs(); drawDiario(); drawSunburst(); drawWaterfall(); drawDumbbell(); drawPessoaDonut(); drawBullet(); drawRows();
    } catch (e) { alert("Falha ao carregar: " + e.message); }
  }

  // Inc 4.5 Tarefa 7: recarrega só o Resumo (resumo do mês + metas do mês, p/ o orçamento
  // de drawDiario) — espelha carregarLancamentos: evita refazer o fetch de transações/
  // catálogo quando só o mês do Resumo mudou (troca de #mesSel ou clique na aba).
  async function carregarResumo() {
    try {
      const qs = `?mes=${estado.mes}`;
      const [resumo, metasMes] = await Promise.all([apiGet("/api/resumo" + qs), apiGet("/api/metas" + qs)]);
      estado.resumo = resumo; estado.metasMes = metasMes;
      drawKPIs(); drawDiario(); drawSunburst(); drawWaterfall(); drawDumbbell(); drawPessoaDonut(); drawBullet();
    } catch (e) { alert("Falha ao carregar resumo: " + e.message); }
  }

  // Recarrega só as transações (aba Lançamentos) com o range corrente — usado pela troca de
  // mês/"Todos os meses" p/ não refazer o fetch do Resumo (agora em carregarResumo()).
  async function carregarLancamentos() {
    try {
      const { de, ate } = transacoesRange();
      const transacoes = await apiGet(`/api/transacoes?de=${de}&ate=${ate}`);
      estado.transacoes = transacoes;
      const presentes = new Set(transacoes.map(t => t.id));
      for (const id of estado.selecao) if (!presentes.has(id)) estado.selecao.delete(id);
      const nomes = estado.catalogo.categorias.map(c => c.nome).concat(transacoes.map(t => t.categoria));
      estado.cores = construirCores(nomes);
      popularFiltros(); popularMassaBar();
      drawRows();
    } catch (e) { alert("Falha ao carregar lançamentos: " + e.message); }
  }

  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("on")); b.classList.add("on");
    const v = b.dataset.view;
    $("#resumo").classList.toggle("hidden", v !== "resumo");
    $("#lanc").classList.toggle("hidden", v !== "lanc");
    $("#importar").classList.toggle("hidden", v !== "importar");
    $("#ajustes").classList.toggle("hidden", v !== "ajustes");
    $("#planejamento").classList.toggle("hidden", v !== "planejamento");
    if (v === "ajustes") drawAjustes();
    if (v === "importar") drawImportar();
    if (v === "lanc") carregarLancamentos();
    if (v === "planejamento") renderPlanejamento();
    if (v === "resumo") carregarResumo();
  }));

  // Inc 4.5 Tarefa 7: mês global — agora governa Lançamentos, Planejamento E Resumo (os
  // presets de .period saíram; o Resumo fecha no mês de #mesSel, igual às outras abas).
  $("#mesSel").value = estado.mes;
  $("#mesSel").addEventListener("change", e => {
    estado.mes = e.target.value;
    const v = document.querySelector(".tab.on")?.dataset.view;
    if (v === "lanc") carregarLancamentos();
    else if (v === "planejamento") renderPlanejamento();
    else if (v === "resumo") carregarResumo();
  });
  $("#lancTudo").addEventListener("click", () => {
    estado.lancTudo = !estado.lancTudo;
    $("#lancTudo").setAttribute("aria-pressed", String(estado.lancTudo));
    $("#mesSel").disabled = estado.lancTudo; // ligado, o mês global é ignorado p/ Lançamentos
    carregarLancamentos();
  });
  $("#theme").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : cur === "light" ? "dark" : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("tema", next); } catch { /* ignora */ }
  });
  // toolbar de filtro: client-side, nunca refaz fetch — só recalcula drawRows()
  $("#filtros").addEventListener("change", e => {
    if (e.target.id === "fcategoria") estado.filtro.categoria = e.target.value;
    else if (e.target.id === "fpessoa") estado.filtro.pessoa = e.target.value;
    else if (e.target.id === "forigem") estado.filtro.origem = e.target.value;
    else if (e.target.id === "fcomputa") estado.filtro.computa = e.target.value;
    else return;
    drawRows();
  });
  $("#ftexto").addEventListener("input", e => { estado.filtro.texto = e.target.value; drawRows(); });
  $("#flimpar").addEventListener("click", () => {
    estado.filtro = { categoria: "", pessoa: "", origem: "", texto: "", computa: "" };
    $("#fcategoria").value = ""; $("#fpessoa").value = ""; $("#forigem").value = ""; $("#fcomputa").value = ""; $("#ftexto").value = "";
    drawRows();
  });
  // tabela: editar/apagar
  $("#rows").addEventListener("change", async e => {
    const tr = e.target.closest("tr"); if (!tr) return; const id = tr.dataset.id;
    // seleção p/ edição em massa (checkbox da linha)
    if (e.target.classList.contains("selrow")) {
      if (e.target.checked) estado.selecao.add(id); else estado.selecao.delete(id);
      atualizarMassaBar();
      return;
    }
    try {
      if (e.target.classList.contains("edcat")) {
        const categoria_id = e.target.value;
        // "" no PATCH vira null no backend: limpa a sub antiga, que pode não pertencer
        // mais à categoria nova (ela é filtrada por categoria_id no select de Subcategoria)
        await apiPatch(`/api/transacoes/${id}`, { categoria_id, subcategoria_id: "" });
        const subSel = tr.querySelector(".edsub");
        if (subSel) subSel.innerHTML = `<option value="">—</option>` +
          subsDaCat(estado.catalogo, categoria_id).map(s => `<option value="${esc(s.id)}">${esc(s.nome)}</option>`).join("");
        // atualiza a cor do chip
        const cat = estado.catalogo.categorias.find(c => c.id === categoria_id);
        const dot = tr.querySelector(".macrochip .dot");
        if (dot && cat) dot.style.background = `var(${corDe(cat.nome)})`;
      }
      if (e.target.classList.contains("edsub")) await apiPatch(`/api/transacoes/${id}`, { subcategoria_id: e.target.value || null });
      if (e.target.classList.contains("eddesc")) await apiPatch(`/api/transacoes/${id}`, { descricao: e.target.value });
      // select vazio ("—") vira null: transação sem pessoa vinculada
      if (e.target.classList.contains("edpessoa")) await apiPatch(`/api/transacoes/${id}`, { pessoa_id: e.target.value || null });
    } catch (err) { alert("Falha ao salvar: " + err.message); }
  });
  $("#rows").addEventListener("click", async e => {
    const tr = e.target.closest("tr"); if (!tr) return;
    if (e.target.classList.contains("del")) {
      try { await apiDelete(`/api/transacoes/${tr.dataset.id}`); carregar(); }
      catch (err) { alert("Falha ao apagar: " + err.message); }
    } else if (e.target.classList.contains("toggle-computa")) {
      const t = estado.transacoes.find(x => String(x.id) === tr.dataset.id);
      if (!t) return;
      try { await apiPatch(`/api/transacoes/${tr.dataset.id}`, { computa_resumo: !t.computa_resumo }); carregar(); }
      catch (err) { alert("Falha ao atualizar: " + err.message); }
    }
  });

  // ----- edição em massa -----
  // "selecionar todos": marca/desmarca todos os ids do filtro atual.
  $("#selall").addEventListener("change", e => {
    const vis = idsFiltrados();
    if (e.target.checked) vis.forEach(id => estado.selecao.add(id));
    else vis.forEach(id => estado.selecao.delete(id));
    drawRows(); // re-renderiza os checkboxes das linhas
  });
  // ao escolher a categoria na barra, repovoa a subcategoria com as subs daquela categoria.
  $("#mcat").addEventListener("change", e => {
    const catId = e.target.value;
    const msub = $("#msub");
    if (catId === "__nao__") { msub.innerHTML = `<option value="">Subcategoria: —</option>`; return; }
    msub.innerHTML = `<option value="">— (sem sub) —</option>` +
      subsDaCat(estado.catalogo, catId).map(s => `<option value="${esc(s.id)}">${esc(s.nome)}</option>`).join("");
  });
  $("#mlimpar").addEventListener("click", () => { estado.selecao.clear(); drawRows(); });
  $("#maplicar").addEventListener("click", async () => {
    const ids = [...estado.selecao];
    if (!ids.length) return;
    const mudancas = montarMudancas({
      categoria: $("#mcat").value, subcategoria: $("#msub").value,
      pessoa: $("#mpessoa").value, computa: $("#mcomputa").value,
    });
    if (!Object.keys(mudancas).length) { alert("Escolha ao menos um campo pra alterar (categoria, pessoa ou fora do resumo)."); return; }
    if (!confirm(`Alterar ${ids.length} lançamento${ids.length === 1 ? "" : "s"}?`)) return;
    try {
      const r = await apiPost("/api/transacoes/lote", { ids, mudancas });
      estado.selecao.clear();
      await carregar();
      const regras = r.regras ? ` · ${r.regras} regra${r.regras === 1 ? "" : "s"} aprendida${r.regras === 1 ? "" : "s"}` : "";
      alert(`✅ ${r.atualizados} lançamento${r.atualizados === 1 ? "" : "s"} alterado${r.atualizados === 1 ? "" : "s"}${regras}.`);
    } catch (err) { alert("Falha na edição em massa: " + err.message); }
  });

  try { const t = localStorage.getItem("tema"); if (t) document.documentElement.setAttribute("data-theme", t); } catch { /* ignora */ }
  addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(() => { if (estado.resumo) { drawDiario(); drawSunburst(); drawWaterfall(); drawDumbbell(); drawPessoaDonut(); drawBullet(); } }, 150); });
  carregar();
}
