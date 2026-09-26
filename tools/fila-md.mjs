// tools/fila-md.mjs
// A fila em Markdown: fila/<id>.md (um por item aberto), fila/ORDEM.md (as três
// faixas) e fila/feitos.js (o histórico). Este módulo é PURO — recebe os textos
// e devolve a mesma lista ITENS que o /roadmap e as regras da rodada já
// consomem. Quem lê disco e git é o tools/fila.mjs.

export const SECOES = ["Problema", "Valor", "Pronto quando (DoD)", "Exemplo", "Fora", "Decisões", "Perguntas em aberto"];
export const ESTADOS_MD = ["livre", "espera", "pronto"];
export const FAIXAS = ["Agora", "Próximo", "Depois"];

// O Windows deste projeto grava CRLF no checkout (core.autocrlf=true).
const lf = (t) => t.replace(/\r\n/g, "\n");
// Comentário de frontmatter só depois de espaço: "tela:/x#y" não é comentário.
const semComentario = (v) => v.replace(/\s+#.*$/, "").trim();

export function lerFrontmatter(texto) {
  const t = lf(texto);
  const m = t.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const campos = {};
  for (const linha of m[1].split("\n")) {
    if (!linha.trim() || linha.trim().startsWith("#")) continue;
    const k = linha.indexOf(":");   // o PRIMEIRO dois-pontos separa: o valor pode ter outros
    if (k < 0) continue;
    const bruto = semComentario(linha.slice(k + 1));
    let valor = bruto;
    if (bruto.startsWith("[") && bruto.endsWith("]"))
      valor = bruto.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    else if (bruto === "true" || bruto === "false") valor = bruto === "true";
    campos[linha.slice(0, k).trim()] = valor;
  }
  return { campos, resto: t.slice(m[0].length) };
}

export function lerCorpo(resto) {
  let nome = null;
  const secoes = [];
  let atual = null;
  for (const l of lf(resto).split("\n")) {
    const h2 = l.match(/^## (.+?)\s*$/);
    if (h2) { atual = { titulo: h2[1], linhas: [] }; secoes.push(atual); continue; }
    const h1 = l.match(/^# (.+?)\s*$/);
    if (h1 && !atual && nome === null) { nome = h1[1]; continue; }
    if (atual) atual.linhas.push(l);
  }
  return { nome, secoes };
}

// Só o item de primeiro nível conta: o que o Caio escreve embaixo, recuado ou
// solto, é resposta. "(a definir)" e "(nenhuma…)" marcam seção vazia — só esses:
// uma pergunta "(PM, data) ..." ou uma frase "(opcional) ..." é conteúdo.
const MARCADOR = /^\((a definir|nenhuma)[^)]*\)$/i;
export function itensDeLista(linhas) {
  return linhas
    .map((l) => l.match(/^- (?:\[[ xX]\] )?(.*\S)\s*$/))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((t) => !MARCADOR.test(t));
}

export function lerOrdem(texto) {
  const faixas = { Agora: [], "Próximo": [], Depois: [] };
  const erros = [];
  let atual = null;
  for (const l of lf(texto).split("\n")) {
    const h = l.match(/^## (.+?)\s*$/);
    if (h) {
      atual = FAIXAS.includes(h[1]) ? h[1] : null;
      if (!atual) erros.push(`ORDEM.md: faixa "${h[1]}" fora de ${FAIXAS.join("/")}`);
      continue;
    }
    const it = l.match(/^- (\S+)/);
    if (!it) continue;
    if (atual) faixas[atual].push(it[1]);
    else erros.push(`ORDEM.md: ${it[1]} fora de uma faixa`);
  }
  return { faixas, erros };
}

const corrido = (linhas) => linhas.join(" ").replace(/\s+/g, " ").trim();
// "2026-09-25 · estado: pronto · Caio (redação: assistente)" → em, por.
const LINHA_PRONTO = /^(\d{4}-\d{2}-\d{2})\s*·.*estado: pronto.*·\s*([^·]+?)\s*$/;

export function itemDeMarkdown(id, texto, lugar) {
  const fm = lerFrontmatter(texto);
  if (!fm) return { item: null, erros: [`${id}: sem frontmatter (--- no topo)`] };
  const c = fm.campos;
  const erros = [];
  if (c.id !== id) erros.push(`${id}: frontmatter diz id "${c.id}", o arquivo é ${id}.md`);
  if (!ESTADOS_MD.includes(c.estado))
    erros.push(`${id}: estado "${c.estado}" fora de ${ESTADOS_MD.join("/")} (feito vai para feitos.js)`);
  if (c.espera !== undefined && c.estado !== "espera") erros.push(`${id}: espera: só com estado: espera`);
  if (c.espera !== undefined && !["paola", "caio"].includes(c.espera)) erros.push(`${id}: espera "${c.espera}" fora de paola/caio`);
  for (const campo of ["exige", "toca"])
    if (!Array.isArray(c[campo])) erros.push(`${id}: ${campo} tem que ser lista [..]`);
  if (typeof c.auto_merge !== "boolean") erros.push(`${id}: auto_merge tem que ser true ou false`);

  const { nome, secoes } = lerCorpo(fm.resto);
  if (!nome) erros.push(`${id}: sem título "# Nome"`);
  const titulos = secoes.map((s) => s.titulo);
  if (titulos.join("|") !== SECOES.join("|"))
    erros.push(`${id}: seções têm que ser, nesta ordem: ${SECOES.join(", ")} (achei: ${titulos.join(", ") || "nenhuma"})`);
  const sec = Object.fromEntries(secoes.map((s) => [s.titulo, s.linhas]));
  const lista = (t) => itensDeLista(sec[t] ?? []);

  const item = {
    id, camada: 3, e: c.estado === "espera" ? "espera" : "livre", quem: "", nome: nome ?? id,
    meta: typeof c.meta === "string" ? c.meta : "",
    ...(typeof c.cx === "string" ? { cx: c.cx } : {}),
    desc: [corrido(sec["Problema"] ?? []), corrido(sec["Valor"] ?? [])].filter(Boolean).join(" "),
    exige: Array.isArray(c.exige) ? c.exige : [], destrava: [],
  };
  if (item.e === "espera") {
    const paola = c.espera === "paola";
    item.camada = paola ? 1 : 2;
    item.quem = paola ? "espera a Paola" : "espera o Caio";
  } else if (lugar?.faixa === "Depois") { item.camada = 4; item.quem = "depois"; }
  else if (lugar?.faixa === "Próximo") item.quem = "próximo";
  else if (lugar?.faixa === "Agora") item.quem = `agora ${lugar.pos}`;

  if (c.estado === "pronto") {
    const dod = lista("Pronto quando (DoD)");
    const perguntas = lista("Perguntas em aberto");
    if (lugar?.faixa !== "Agora") erros.push(`${id}: estado: pronto fora da faixa Agora`);
    if (perguntas.length) erros.push(`${id}: estado: pronto com ${perguntas.length} pergunta(s) em aberto`);
    if (!dod.length) erros.push(`${id}: estado: pronto sem frase no "Pronto quando"`);
    // Filtrar o "(a definir)" deixaria o item pronto com um pedaço do DoD em aberto.
    if ((sec["Pronto quando (DoD)"] ?? []).some((l) => /\(a definir/i.test(l)))
      erros.push(`${id}: estado: pronto com "(a definir)" no "Pronto quando"`);
    const marca = [...lista("Decisões")].reverse().map((d) => d.match(LINHA_PRONTO)).find(Boolean);
    if (!marca) erros.push(`${id}: estado: pronto sem a linha "AAAA-MM-DD · estado: pronto · quem" em Decisões`);
    item.pronto = {
      por: marca ? marca[2] : "", em: marca ? marca[1] : "", aceite: dod, fora: lista("Fora"),
      toca: Array.isArray(c.toca) ? c.toca : [], auto_merge: c.auto_merge, exemplo: corrido(sec["Exemplo"] ?? []),
    };
  }
  return { item, erros };
}

export function montarFila({ ordem, arquivos, feitos }) {
  const { faixas, erros } = lerOrdem(ordem);
  const onde = new Map();
  for (const f of FAIXAS) faixas[f].forEach((id, k) => {
    if (onde.has(id)) erros.push(`ORDEM.md: ${id} aparece mais de uma vez`);
    else onde.set(id, { faixa: f, pos: k + 1 });
  });
  const idsFeitos = new Set(feitos.map((i) => i?.id));
  const abertos = [];
  for (const [arq, texto] of Object.entries(arquivos)) {
    const id = arq.replace(/\.md$/, "");
    const r = itemDeMarkdown(id, texto, onde.get(id));
    erros.push(...r.erros);
    if (!r.item) continue;
    if (idsFeitos.has(id)) erros.push(`${id}: está em fila/ e em feitos.js`);
    if (!onde.has(id)) erros.push(`${id}: não aparece no ORDEM.md`);
    abertos.push(r.item);
  }
  const idsAbertos = new Set(abertos.map((i) => i.id));
  for (const id of onde.keys()) if (!idsAbertos.has(id)) erros.push(`ORDEM.md: ${id} não tem arquivo em fila/`);
  // A posição no array é a ordem da rodada (classificar) e da vitrine dentro da camada.
  const pos = (i) => { const o = onde.get(i.id); return o ? FAIXAS.indexOf(o.faixa) * 1000 + o.pos : 1e9; };
  abertos.sort((a, b) => pos(a) - pos(b));
  const itens = [...abertos, ...feitos];
  for (const a of abertos)
    a.destrava = itens.filter((o) => Array.isArray(o?.exige) && o.exige.includes(a.id)).map((o) => o.id);
  return { itens, erros };
}

// Um item por linha, em JSON: é JS válido para o <script src> da vitrine, e o
// diff de uma entrega mostra só as linhas que mudaram.
export function serializar(itens, cabecalho) {
  return `${cabecalho}const ITENS = [\n${itens.map((i) => `  ${JSON.stringify(i)}`).join(",\n")}\n];\n`;
}
