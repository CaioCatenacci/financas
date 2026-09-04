// ---------- funções puras (testadas em node) ----------
export function agruparMensal(rows) {
  const mapa = new Map();
  for (const r of rows) {
    if (!mapa.has(r.mes)) mapa.set(r.mes, { mes: r.mes, receita: 0, despesa: 0, saldo: 0 });
    const o = mapa.get(r.mes);
    const v = parseFloat(r.total);
    if (r.natureza === "receita") o.receita += v; else o.despesa += v;
    o.saldo = o.receita - o.despesa;
  }
  return [...mapa.values()].sort((a, b) => a.mes.localeCompare(b.mes));
}

// resumo.porPessoa vem do backend como linhas {pessoa, natureza, total} (uma por pessoa×natureza)
// dobra em uma linha por pessoa. Mesmo formato de saída que agruparMensal usa (receita/despesa/saldo).
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

export function periodoRange(preset, hoje = new Date()) {
  const y = hoje.getUTCFullYear(), m = hoje.getUTCMonth();
  const pad = x => String(x).padStart(2, "0");
  const iso = (yy, mm, dd) => `${yy}-${pad(mm + 1)}-${pad(dd)}`;
  const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  if (preset === "mes") return { de: iso(y, m, 1), ate: iso(y, m, lastDay(y, m)) };
  if (preset === "mespassado") {
    // mês anterior; Date resolve a virada de ano (janeiro → dezembro do ano passado)
    const d = new Date(Date.UTC(y, m - 1, 1)), yy = d.getUTCFullYear(), mm = d.getUTCMonth();
    return { de: iso(yy, mm, 1), ate: iso(yy, mm, lastDay(yy, mm)) };
  }
  if (preset === "ano") return { de: `${y}-01-01`, ate: `${y}-12-31` };
  if (preset === "12m") {
    const s = new Date(Date.UTC(y, m - 11, 1));
    return { de: iso(s.getUTCFullYear(), s.getUTCMonth(), 1), ate: iso(y, m, lastDay(y, m)) };
  }
  return { de: "1900-01-01", ate: "2999-12-31" };
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

// "Aplicar" só habilita quando o checksum bateu — extrato/fatura com diferença é abortado
// (mesmo critério dos scripts .py: não grava nada até o checksum bater).
export function podeAplicar(preview) {
  return preview?.checksum?.ok === true;
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

  const estado = {
    periodo: "12m", resumo: null, transacoes: [], cores: {}, pessoas: [],
    catalogo: { categorias: [], subcategorias: [] }, // Fase B: categorias/subcategorias por id
    filtro: { categoria: "", pessoa: "", origem: "", texto: "", computa: "" },
    importar: { tipo: "extrato", preview: null, carregando: false, ultimoResultado: null, ano: null, mes: null },
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

  // ----- evolução mensal -----
  function drawEvo() {
    const dados = agruparMensal(estado.resumo.mensal || []);
    const W = 560, H = 230, pl = 8, pr = 8, pt = 14, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
    const el = $("#evo");
    if (!dados.length) { el.innerHTML = `<p class="vazio">sem dados no período</p>`; return; }
    // domínio inclui o saldo negativo (senão a barra de saldo é desenhada fora do viewBox
    // quando a receita é 0 e vaza do card via svg{overflow}). hi = topo, lo = fundo (≤ 0).
    const hi = Math.max(1, ...dados.map(d => Math.max(d.receita, d.despesa))) * 1.1;
    const lo = Math.min(0, ...dados.map(d => d.saldo)) * 1.1;
    const n = dados.length;
    const X = i => n === 1 ? pl + iw / 2 : pl + iw * i / (n - 1), Y = v => pt + ih * (hi - v) / (hi - lo);
    const path = key => dados.map((d, i) => (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(d[key]).toFixed(1)).join(" ");
    // fecha a área na linha do zero (Y(0)), não no fundo do viewBox: com domínio [lo,hi]
    // e lo<0, pt+ih passou a ser Y(lo), o que inflava o preenchimento até o piso negativo.
    const area = key => path(key) + ` L${X(n - 1).toFixed(1)},${Y(0).toFixed(1)} L${X(0).toFixed(1)},${Y(0).toFixed(1)} Z`;
    let g = "";
    for (let k = 0; k <= 3; k++) { const y = pt + ih * k / 3; g += `<line class="grid-l" x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}"/>`; }
    let bars = "";
    dados.forEach((d, i) => { const s = d.saldo; bars += `<rect x="${(X(i) - 3.5).toFixed(1)}" y="${(s >= 0 ? Y(s) : Y(0)).toFixed(1)}" width="7" height="${Math.abs(Y(s) - Y(0)).toFixed(1)}" rx="2" opacity=".28" style="fill:var(--dim)"/>`; });
    let labels = "";
    const step = n > 8 ? 2 : 1;
    dados.forEach((d, i) => { if (i % step === 0) labels += `<text class="axis" x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${mesLabel(d.mes)}</text>`; });
    let hot = "";
    dados.forEach((d, i) => { const w = iw / n; hot += `<rect x="${(X(i) - w / 2).toFixed(1)}" y="${pt}" width="${w.toFixed(1)}" height="${ih}" fill="transparent" data-i="${i}"/>`; });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Evolução mensal">
      ${g}${bars}
      <path d="${area("despesa")}" opacity=".10" style="fill:var(--despesa)"/>
      <path d="${path("despesa")}" stroke-width="2" style="fill:none;stroke:var(--despesa)"/>
      <path d="${path("receita")}" stroke-width="2" style="fill:none;stroke:var(--receita)"/>
      ${labels}<g id="evohot">${hot}</g></svg>`;
    $("#evohot").querySelectorAll("rect").forEach(r => {
      r.addEventListener("mousemove", e => { const d = dados[+r.dataset.i]; showTip(e, `<b>${mesLabel(d.mes)}</b><br>Receita ${BRL(d.receita)}<br>Despesa ${BRL(d.despesa)}<br>Saldo ${BRL(d.saldo)}`); });
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

  // ----- donut -----
  function drawDonut() {
    let cats = despesaPorMacro();
    const el = $("#donut"), lst = $("#catlist");
    if (!cats.length) { el.innerHTML = `<p class="vazio">sem despesas</p>`; lst.innerHTML = ""; return; }
    if (cats.length > 7) { const top = cats.slice(0, 6); const out = cats.slice(6).reduce((a, c) => a + c.v, 0); cats = [...top, { nm: "Outros", v: out }]; }
    const total = cats.reduce((a, c) => a + c.v, 0), R = 64, r = 40, cx = 76, cy = 76;
    let a0 = -Math.PI / 2, arcs = "";
    cats.forEach((c, i) => {
      const a1 = a0 + 2 * Math.PI * c.v / total;
      const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0), x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
      const xi1 = cx + r * Math.cos(a1), yi1 = cy + r * Math.sin(a1), xi0 = cx + r * Math.cos(a0), yi0 = cy + r * Math.sin(a0);
      const laf = (a1 - a0) > Math.PI ? 1 : 0;
      arcs += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${R},${R} 0 ${laf} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${xi1.toFixed(1)},${yi1.toFixed(1)} A${r},${r} 0 ${laf} 0 ${xi0.toFixed(1)},${yi0.toFixed(1)} Z" stroke-width="2" data-i="${i}" style="fill:var(${corDe(c.nm)});stroke:var(--surface)"/>`;
      a0 = a1;
    });
    el.innerHTML = `<svg viewBox="0 0 152 152" width="152" height="152" role="img" aria-label="Gastos por categoria">${arcs}
      <text x="76" y="72" text-anchor="middle" font-size="10" style="font-family:var(--mono);fill:var(--mut)">total</text>
      <text x="76" y="88" text-anchor="middle" font-size="15" font-weight="600" style="font-family:var(--mono);fill:var(--ink)">${BRL(total).replace("R$ ", "")}</text></svg>`;
    el.querySelectorAll("path").forEach(p => {
      p.addEventListener("mousemove", e => { const c = cats[+p.dataset.i]; showTip(e, `<b>${esc(c.nm)}</b><br>${BRL(c.v)} · ${(100 * c.v / total).toFixed(0)}%`); });
      p.addEventListener("mouseleave", hideTip);
    });
    lst.innerHTML = cats.map(c => `<div class="catrow"><i class="dot" style="background:var(${corDe(c.nm)})"></i><span class="nm">${esc(c.nm)}</span><span class="vl">${BRL(c.v)}</span></div>`).join("");
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

  // ----- gasto por pessoa -----
  function drawPessoa() {
    const rows = agruparPorPessoa(estado.resumo.porPessoa || []);
    const el = $("#pessoa");
    if (!rows.length) { el.innerHTML = `<p class="vazio">sem despesas no período</p>`; return; }
    const max = Math.max(1, ...rows.map(r => r.despesa)) * 1.06;
    const cores = construirCores(rows.map(r => r.pessoa));
    el.innerHTML = rows.map((r, i) => {
      const w = (100 * r.despesa / max).toFixed(1);
      return `<div class="pprow" data-i="${i}">
        <span class="pplabel">${esc(r.pessoa)}</span>
        <svg class="pptrack" viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label="${esc(r.pessoa)}">
          <rect x="0" y="2" width="${w}" height="10" rx="3" style="fill:var(${cores[r.pessoa]})"/>
        </svg>
        <span class="ppval">${BRL(r.despesa)}</span>
      </div>`;
    }).join("");
    el.querySelectorAll(".pprow").forEach(row => {
      const r = rows[+row.dataset.i];
      row.addEventListener("mousemove", e => showTip(e, `<b>${esc(r.pessoa)}</b><br>Despesa ${BRL(r.despesa)}<br>Receita ${BRL(r.receita)}<br>Saldo ${BRL(r.saldo)}`));
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
      $("#rows").innerHTML = `<tr><td colspan="8" class="vazio">nenhum lançamento com esses filtros</td></tr>`;
      return;
    }
    $("#rows").innerHTML = linhas.map(t => {
      const rec = t.natureza === "receita";
      const catOpts = cats.map(c => `<option value="${esc(c.id)}" ${c.id === t.categoria_id ? "selected" : ""}>${esc(c.nome)}</option>`).join("");
      const subOpts = `<option value="">—</option>` +
        subsDaCat(estado.catalogo, t.categoria_id).map(s => `<option value="${esc(s.id)}" ${s.id === t.subcategoria_id ? "selected" : ""}>${esc(s.nome)}</option>`).join("");
      const pessoaOpts = `<option value="">—</option>` +
        estado.pessoas.map(p => `<option value="${esc(p.id)}" ${p.id === t.pessoa_id ? "selected" : ""}>${esc(p.nome)}</option>`).join("");
      // fora do resumo (extrato/fatura não-gasto: transferência, pagamento de fatura etc.) — selo
      // só aparece quando computa_resumo é false; o toggle (botão) inverte o valor nas duas direções.
      const selo = !t.computa_resumo ? `<span class="selo-fora">fora do resumo</span>` : "";
      return `<tr data-id="${t.id}">
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
    const checksumHtml = ok
      ? `<span class="impchk impchk-ok">✓ checksum confere</span>`
      : `<span class="impchk impchk-bad">✕ checksum não bate (diferença R$ ${centavosBR(String(Math.abs(preview.checksum?.diferencaCents ?? 0) / 100))}) — aplicar desabilitado</span>`;

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

  // ----- carga e eventos -----
  async function carregar() {
    try {
      const { de, ate } = periodoRange(estado.periodo);
      const qs = `?de=${de}&ate=${ate}`;
      const [resumo, transacoes, catalogo, pessoas] = await Promise.all([
        apiGet("/api/resumo" + qs), apiGet("/api/transacoes" + qs), apiGet("/api/catalogo"), apiGet("/api/pessoas"),
      ]);
      estado.resumo = resumo; estado.transacoes = transacoes; estado.catalogo = catalogo; estado.pessoas = pessoas;
      // cores por nome de categoria: catálogo (pra sempre ter cor definida no select da Ajustes/filtro)
      // + nomes vindos das transações (cobre categoria já desativada que ainda aparece no histórico)
      const nomes = estado.catalogo.categorias.map(c => c.nome).concat(transacoes.map(t => t.categoria));
      estado.cores = construirCores(nomes);
      popularFiltros();
      drawKPIs(); drawEvo(); drawDonut(); drawWaterfall(); drawDumbbell(); drawPessoa(); drawRows();
    } catch (e) { alert("Falha ao carregar: " + e.message); }
  }

  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("on")); b.classList.add("on");
    const v = b.dataset.view;
    $("#resumo").classList.toggle("hidden", v !== "resumo");
    $("#lanc").classList.toggle("hidden", v !== "lanc");
    $("#importar").classList.toggle("hidden", v !== "importar");
    $("#ajustes").classList.toggle("hidden", v !== "ajustes");
    if (v === "ajustes") drawAjustes();
    if (v === "importar") drawImportar();
  }));
  document.querySelectorAll(".period").forEach(p => p.addEventListener("click", e => {
    if (!e.target.dataset.p) return;
    document.querySelectorAll(".period .chip").forEach(c => { if (c.dataset.p) c.classList.remove("on"); });
    document.querySelectorAll(`.period .chip[data-p="${e.target.dataset.p}"]`).forEach(c => c.classList.add("on"));
    estado.periodo = e.target.dataset.p; carregar();
  }));
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

  try { const t = localStorage.getItem("tema"); if (t) document.documentElement.setAttribute("data-theme", t); } catch { /* ignora */ }
  addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(() => { if (estado.resumo) { drawEvo(); drawDonut(); drawWaterfall(); drawDumbbell(); drawPessoa(); } }, 150); });
  carregar();
}
