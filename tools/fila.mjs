// tools/fila.mjs
// Regras da fila autônoma do financas. A fila mora em fila/ — um .md por item
// aberto, ORDEM.md com as faixas e feitos.js com o histórico. Este arquivo lê a
// pasta (do disco ou de um ref do git) com precisão para o workflow
// .claude/workflows/fila.js, que não acessa arquivo nem git e não se testa com
// node --test. O que precisa ser exato mora aqui e em fila-md.mjs.
//
// Veio do LM Ateliê (docs/superpowers/specs/2026-09-26-fila-autonoma-receita.md).
// Aqui não há vitrine, então não há arquivo gerado nem comando gerar.
//
// Comandos (ver o fim do arquivo): checar · concluir · candidatos · toca · degrau2.
import vm from "node:vm";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { montarFila, serializar } from "./fila-md.mjs";

export const ESTADOS = ["feito", "livre", "espera", "exec"];
// O escopo declarado de um item: cada valor é uma área do repositório com
// consequência própria. migracao = banco (fica com o "entrega a #N");
// worker = API + bot do Telegram (o que o wrangler deploya); app = o que o
// Caio vê em /app (public/); tools = os importadores Python.
export const TOCA_FIXOS = ["migracao", "worker", "app", "tools"];

export function tocaValido(t) {
  return TOCA_FIXOS.includes(t);
}

// fila/feitos.js é `const ITENS = [...]` — sem export, herança da vitrine do
// projeto de origem; um item por linha dá diff legível. Avaliar num contexto
// vazio devolve o array sem dar ao arquivo acesso a nada do Node.
export function carregarFila(texto) {
  let itens;
  try {
    itens = vm.runInNewContext(`${texto}\n;typeof ITENS === "undefined" ? undefined : ITENS`, {});
  } catch (e) {
    throw new Error(`não consegui ler feitos.js: ${e.message}`);
  }
  if (!Array.isArray(itens)) throw new Error("feitos.js não define o array ITENS");
  return itens;
}

const vazio = (s) => typeof s !== "string" || !s.trim();

export function checar(itens) {
  const erros = [];
  const ids = new Set();
  // Um item que não é objeto (vírgula dobrada vira buraco no array, "null"
  // colado no lugar errado) precisa virar mensagem, não TypeError.
  const eItem = (i) => i !== null && typeof i === "object" && !Array.isArray(i);
  for (let k = 0; k < itens.length; k++) {
    const i = itens[k];
    if (!eItem(i)) { erros.push(`posição ${k}: não é um item (vírgula dobrada ou valor solto?)`); continue; }
    if (vazio(i.id)) { erros.push(`item sem id: ${JSON.stringify(i).slice(0, 60)}`); continue; }
    if (ids.has(i.id)) erros.push(`${i.id}: id repetido`);
    ids.add(i.id);
  }
  for (const i of itens) {
    if (!eItem(i) || vazio(i.id)) continue;
    if (!ESTADOS.includes(i.e)) erros.push(`${i.id}: estado "${i.e}" fora de ${ESTADOS.join("/")}`);
    for (const campo of ["exige", "destrava"]) {
      if (i[campo] === undefined) continue;
      // Texto no lugar de lista seria iterado letra por letra, e passaria.
      if (!Array.isArray(i[campo])) { erros.push(`${i.id}: ${campo} tem que ser lista`); continue; }
      for (const ref of i[campo])
        if (!ids.has(ref)) erros.push(`${i.id}: ${campo} aponta para ${ref}, que não existe`);
    }
    if (i.pronto === undefined) continue;
    const p = i.pronto;
    if (!eItem(p)) { erros.push(`${i.id}: pronto tem que ser objeto {por, em, aceite, fora, toca, auto_merge}`); continue; }
    if (vazio(p.por)) erros.push(`${i.id}: pronto.por vazio (quem marcou)`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.em ?? "")) erros.push(`${i.id}: pronto.em tem que ser AAAA-MM-DD`);
    if (!Array.isArray(p.aceite) || !p.aceite.length || p.aceite.some(vazio))
      erros.push(`${i.id}: pronto.aceite vazio ou com frase vazia`);
    if (p.fora !== undefined && !Array.isArray(p.fora)) erros.push(`${i.id}: pronto.fora tem que ser lista`);
    if (!Array.isArray(p.toca)) erros.push(`${i.id}: pronto.toca tem que ser lista (vazia = nada disso)`);
    else for (const t of p.toca)
      if (!tocaValido(t)) erros.push(`${i.id}: toca "${t}" fora do vocabulário (${TOCA_FIXOS.join(", ")})`);
    if (typeof p.auto_merge !== "boolean") erros.push(`${i.id}: pronto.auto_merge tem que ser true ou false`);
  }
  return erros;
}

// Quem a rodada pode pegar. A PR aberta é o estado "em curso": o item segue
// "livre" no master até o merge, e a branch fila/<id> é quem diz que já tem dono.
export function classificar(itens, { prs = [], locais = [] } = {}) {
  const feitos = new Set(itens.filter((i) => i.e === "feito").map((i) => i.id));
  const abertas = new Set(prs);
  const daqui = new Set(locais);
  const r = { prontos: [], bloqueados: [], em_pr: [] };
  for (const i of itens) {
    if (i.e === "feito" || !i.pronto) continue;
    const branch = `fila/${i.id}`;
    if (abertas.has(branch)) { r.em_pr.push(i.id); continue; }
    if (daqui.has(branch)) {
      r.bloqueados.push({ id: i.id, motivo: `branch ${branch} de rodada anterior ainda existe (sem PR) — olhar e apagar` });
      continue;
    }
    if (i.e === "espera") { r.bloqueados.push({ id: i.id, motivo: "estado espera: depende de alguém, não da fila" }); continue; }
    const faltam = (i.exige ?? []).filter((x) => !feitos.has(x));
    if (faltam.length) { r.bloqueados.push({ id: i.id, motivo: `espera ${faltam.join(", ")}` }); continue; }
    r.prontos.push({ id: i.id, nome: i.nome, toca: i.pronto.toca });
  }
  return r;
}

// O que o item tocou sai do DIFF, não do relato do coder: quem se desviou do
// escopo é justamente quem não percebeu. Neutros são o que toda entrega mexe
// (a própria fila, documentação, specs, testes) — contá-los devolveria todo item.
// Código fora do vocabulário (CI, package.json, wrangler.toml) não devolve o
// item, mas vira nao_classificado e bloqueia o merge automático.
const NEUTROS = [
  (c) => c.startsWith("fila/") || c.startsWith("docs/") || c.startsWith("tests/"),
  (c) => c.endsWith(".md"),
  (c) => /(^|\/)(test-[\w-]+|[\w-]+\.test)\.mjs$/.test(c),
];
// A infra da própria fila: mudar as regras muda as rodadas seguintes. Nunca
// neutra, nunca merge automático — igual a .claude/ e CLAUDE.md.
const INFRA_FILA = ["tools/fila.mjs", "tools/fila-md.mjs", "tools/db.py", "tools/app.mjs", "tools/deploy.mjs"];

export function tocaDeCaminhos(caminhos) {
  const derivado = new Set();
  const nao = new Set();
  for (const bruto of caminhos) {
    const c = bruto.replace(/\\/g, "/");
    if (c.startsWith(".claude/") || c === "CLAUDE.md") { nao.add(c); continue; }
    if (INFRA_FILA.includes(c) || c.startsWith("tools/hooks/")) { nao.add(c); continue; }
    if (c.startsWith("migrations/") || c === "schema.sql") { derivado.add("migracao"); continue; }
    if (NEUTROS.some((f) => f(c))) continue;
    if (c.startsWith("worker/")) { derivado.add("worker"); continue; }
    if (c.startsWith("public/")) { derivado.add("app"); continue; }
    if (/^tools\/[\w-]+\.py$/.test(c)) { derivado.add("tools"); continue; }
    nao.add(c);
  }
  return { derivado: [...derivado].sort(), nao_classificados: [...nao].sort() };
}

export function foraDoDeclarado(derivado, declarado) {
  return derivado.filter((t) => !declarado.includes(t));
}

// Merge e deploy sem o Caio olhar. O único usuário é ele, e a entrega deploya e
// confere no ar: worker e app podem. O que não pode é mexer no banco de
// produção sem ninguém presente (migracao), código que a regra não conhece, e
// mudança nas regras dos agentes (vem em nao_classificados).
export function degrau2(item, { degrau, derivado = [], nao_classificados = [], aprovou_de_primeira }) {
  const motivos = [];
  if (degrau !== 2) motivos.push(`rodada em degrau ${degrau}`);
  if (item.pronto?.auto_merge !== true) motivos.push("item sem auto_merge");
  const tudo = new Set([...(item.pronto?.toca ?? []), ...derivado]);
  if (tudo.has("migracao")) motivos.push("toca migracao (aplicar em produção fica com o \"entrega a #N\")");
  if (nao_classificados.length) motivos.push(`código não classificado: ${nao_classificados.join(", ")}`);
  if (!aprovou_de_primeira) motivos.push("reviewer não aprovou de primeira");
  return { ok: motivos.length === 0, motivos };
}

// Branches fila/* locais, a partir da saída de `git branch --list --format`.
export function branchesLocais(saida) {
  return saida.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- comandos
// Cada comando imprime UMA linha de JSON: é o que o agente repassa ao
// workflow, e JSON não deixa margem para o agente "resumir" o resultado.
function lerStdin() {
  const t = readFileSync(0, "utf8").trim();
  return t ? JSON.parse(t) : {};
}

function acharItem(itens, id) {
  const item = itens.find((i) => i.id === id);
  if (!item) { console.error(`item ${id} não existe em fila/`); process.exit(1); }
  return item;
}

export const CABECALHO_FEITOS =
  "// fila/feitos.js — itens entregues. Histórico: não se edita à mão;\n" +
  "// `node tools/fila.mjs concluir <id> \"<meta>\"` acrescenta o item que a PR entrega.\n";
const FORA_DA_FILA = new Set(["README.md", "_modelo.md", "ORDEM.md"]);

// concluir grava sem pedir permissão (o settings libera node tools/fila.mjs):
// só a própria fila/ — ou uma pasta temporária, que é onde os testes trabalham.
// Caminho livre aqui seria escrita livre para quem roda o coder.
function gravavel(caminho, esperado) {
  const alvo = resolve(caminho);
  return alvo === resolve(esperado) || alvo.startsWith(resolve(tmpdir()) + sep);
}
function exigirGravavel(caminho, esperado) {
  if (gravavel(caminho, esperado)) return;
  console.error(`o fila.mjs só grava em ${esperado} (ou numa pasta temporária de teste), não em ${caminho}`);
  process.exit(1);
}

// Lê fila/ inteira. Com ref, pelo git — a rodada nunca lê a árvore de trabalho.
function lerPasta(ref, pasta) {
  const ler = ref
    ? (n) => execFileSync("git", ["show", `${ref}:${pasta}/${n}`], { encoding: "utf8" })
    : (n) => readFileSync(join(pasta, n), "utf8");
  const nomes = ref
    ? execFileSync("git", ["ls-tree", "--name-only", ref, `${pasta}/`], { encoding: "utf8" })
        .split("\n").filter(Boolean).map((p) => p.slice(pasta.length + 1))
    : readdirSync(pasta);
  let feitos;
  try { feitos = carregarFila(ler("feitos.js")); }
  catch (e) { throw new Error(`${pasta}/feitos.js: ${e.message}`); }
  const arquivos = {};
  for (const n of nomes) if (n.endsWith(".md") && !FORA_DA_FILA.has(n)) arquivos[n] = ler(n);
  return { ordem: ler("ORDEM.md"), arquivos, feitos };
}

// Toda leitura passa pelas regras: um .md torto para a rodada inteira (falha
// fechada), em vez de virar item sumido.
function carregar(ref, pasta) {
  let lido;
  try { lido = lerPasta(ref, pasta); }
  catch (e) { console.error(`não consegui ler ${ref ? `${ref}:` : ""}${pasta}/: ${e.message}`); process.exit(1); }
  const { itens, erros } = montarFila(lido);
  erros.push(...checar(itens));
  if (erros.length) { console.error(`${pasta}/ com problema:\n  - ` + [...new Set(erros)].join("\n  - ")); process.exit(1); }
  return { itens, lido };
}

function principal(argv) {
  const iRef = argv.indexOf("--ref");
  const ref = iRef >= 0 ? argv[iRef + 1] : null;
  const [cmd, ...args] = iRef >= 0 ? argv.filter((_, k) => k !== iRef && k !== iRef + 1) : argv;
  const pastaDe = (k) => args[k] || "fila";

  if (cmd === "checar") {
    const { itens, lido } = carregar(ref, pastaDe(0));
    const abertos = Object.keys(lido.arquivos).length;
    console.log(`${pastaDe(0)}/: ${itens.length} itens (${abertos} abertos, ${lido.feitos.length} no histórico), ` +
      `${itens.filter((i) => i.pronto).length} prontos`);
    return;
  }
  if (cmd === "concluir") {
    const [id, meta, pasta = "fila"] = args;
    if (ref || !id || !meta) { console.error('uso: node tools/fila.mjs concluir <id> "<meta>" [pasta]'); process.exit(1); }
    exigirGravavel(pasta, "fila");
    const { itens, lido } = carregar(null, pasta);
    const item = acharItem(itens, id);
    if (!lido.arquivos[`${id}.md`]) { console.error(`${id} não é item aberto em ${pasta}/`); process.exit(1); }
    const { pronto, ...resto } = item;
    const feito = { ...resto, camada: 0, e: "feito", quem: "feito", meta };
    writeFileSync(join(pasta, "feitos.js"), serializar([...lido.feitos, feito], CABECALHO_FEITOS));
    unlinkSync(join(pasta, `${id}.md`));
    const ordem = lido.ordem.replace(/\r\n/g, "\n").split("\n")
      .filter((l) => !new RegExp(`^- ${id}(\\s|$)`).test(l)).join("\n");
    writeFileSync(join(pasta, "ORDEM.md"), ordem);
    carregar(null, pasta);   // a pasta tem que continuar legível depois da mudança
    console.log(`${id} concluído: saiu de ${pasta}/${id}.md, entrou em ${pasta}/feitos.js`);
    return;
  }
  const { itens } = carregar(ref, "fila");
  if (cmd === "candidatos") {
    const entrada = lerStdin();
    if (!("locais" in entrada))
      entrada.locais = branchesLocais(execFileSync("git", ["branch", "--list", "fila/*", "--format", "%(refname:short)"], { encoding: "utf8" }));
    console.log(JSON.stringify(classificar(itens, entrada)));
    return;
  }
  if (cmd === "toca") {
    const [id, base, head] = args;
    const item = acharItem(itens, id);
    const saida = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" });
    const { derivado, nao_classificados } = tocaDeCaminhos(saida.split("\n").filter(Boolean));
    const declarado = item.pronto?.toca ?? [];
    console.log(JSON.stringify({ id, declarado, derivado, nao_classificados,
      fora_do_declarado: foraDoDeclarado(derivado, declarado) }));
    return;
  }
  if (cmd === "degrau2") {
    const item = acharItem(itens, args[0]);
    console.log(JSON.stringify({ id: args[0], ...degrau2(item, lerStdin()) }));
    return;
  }
  console.error('uso: node tools/fila.mjs [--ref <ref>] checar [pasta] | concluir <id> "<meta>" [pasta] | candidatos | toca <id> <base> <head> | degrau2 <id>');
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) principal(process.argv.slice(2));
