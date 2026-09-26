# Fila autônoma (PM, coder, reviewer, entrega) — plano de implantação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduzir no `financas` o arranjo de fila autônoma do LM Ateliê: backlog em Markdown versionado (`fila/`), regras exatas num tool testado (`tools/fila.mjs`), quatro agentes com o mínimo de ferramentas, um workflow que conduz a rodada até PR verde e, no degrau 2, até o deploy, com travas de push e de permissão.

**Architecture:** Copia o kit do projeto de origem e adapta o que depende do repositório: vocabulário `toca` (migracao/worker/app/tools), branch `master`, sem vitrine (sem arquivo gerado), banco sem Neon MCP (script `tools/db.py` com sessão read-only e ensaio de migração em transação com ROLLBACK), app no ar atrás de token (script `tools/app.mjs` que lê `APP_TOKEN` de `.dev.vars` e faz só GET). Degrau 2 é o padrão: merge e deploy automáticos para tudo que não tem migração; migração fica com o "entrega a #N".

**Tech Stack:** Node 24 (`node --test`), Python 3.12 + psycopg 3 + pytest, Cloudflare Workers (`wrangler deploy`), GitHub Actions, `gh`, Claude Code (agents em `.claude/agents/`, Workflow tool em `.claude/workflows/`).

**Spec:** `C:\Users\caioc\Caio\receita-fila-autonoma\RECEITA.md` (a receita; a Task 8 copia para `docs/superpowers/specs/2026-09-26-fila-autonoma-receita.md`). Kit de origem em `C:\Users\caioc\Caio\receita-fila-autonoma\kit\`. Respostas do Caio às perguntas da seção 12 (26/09/2026): "o quão mais automático melhor"; concordou com as deduções abaixo; pediu para "mimetizar a dinâmica do token" no acesso ao app.

## Decisões que saem das respostas do Caio (não re-litigar)

| Pergunta | Decisão |
|---|---|
| 1. Merge é deploy? | Não (deploy é `wrangler deploy` manual). A **entrega** faz o deploy e confere no ar. **Degrau 2 é o padrão** (`degrau: 2`); `auto_merge: true` é o padrão do modelo de item. |
| 2. Banco/migração | Neon, `migrations/00NN_*.sql`. **Neon MCP não está disponível nesta máquina** (confirmado com `claude mcp list` em 26/09/2026; a memória que dizia o contrário está desatualizada). Validação fora de produção = `python tools/db.py ensaiar` (transação + ROLLBACK). Aplicar = `python tools/db.py aplicar`, só a entrega, fora do allow (pede permissão; o Caio está presente porque `migracao` **barra o degrau 2**). |
| 3. Suítes | `npm test` (298 testes hoje) e `python -m pytest tests/ -q` (39). Mais `node tools/fila.mjs checar`. Não existe CI hoje — a Task 5 cria. |
| 4. Usuária | Só o Caio. `toca` = `migracao` \| `worker` \| `app` \| `tools`. Não há render de tela; o reviewer confere por teste e chamada de rota. `app` **não** barra o degrau 2. |
| 5. Ativos com cópias | `resolverCategoria` em três lugares (`worker/categorias.js`, `public/app.js`, `tools/categorias.py`), dinheiro em centavos (`money.js`), `conta_no_resumo` nas agregações. Vão para o checklist do reviewer; não viram categoria do `toca`. |
| 6. Não auto-deploya | Worker (a entrega roda `npx wrangler deploy`), secrets do wrangler e webhook do Telegram (não mudam por PR; se um item exigir, é `precisa_decisao`). |
| 7. Dado sensível | **O repositório é público** (`gh repo view`: PUBLIC). Nada de valor real, contraparte, chave Pix nem comprovante em `fila/`, teste, fixture, PR ou relatório. Nomes da família já estão no `CLAUDE.md`; podem aparecer. |
| 8. Vitrine | Não. Sem `docs/fila.js`, sem comando `gerar`. |
| 9. Dossiê | `BACKLOG.md` fica como reservatório de ideias; quando um item vira card em `fila/`, a linha sai do `BACKLOG.md`. `CONTEXTO.md` ganha seção só quando o item muda uma regra do projeto. O coder atualiza os dois na PR do item. |
| 10. Conta e repo | `gh` conta ativa `CaioCatenacci`; repo `CaioCatenacci/financas`; branch principal **`master`**. URL do app: `https://financas.caiocatenacci.workers.dev`. |

## Global Constraints

- Comentários e testes **em português**, explicando o porquê (CLAUDE.md).
- Nada de dado financeiro real em nenhum arquivo versionado: o repositório é público.
- `tools/fila-md.mjs` e `tools/fila.mjs` são puros no que decide (texto entra, JSON sai); só `concluir` grava, e só em `fila/` ou em pasta temporária.
- Todo comando dos tools imprime **uma linha de JSON** (ou uma linha de texto, no `checar`), e sai com código 1 em erro, sem stack trace.
- Segredos (`APP_TOKEN`, `DATABASE_URL`) só de `.dev.vars` (gitignored) ou do ambiente; **nunca** em linha de comando, saída, relatório ou PR.
- A `master` só muda por PR: hook `tools/hooks/pre-push` + deny no `.claude/settings.json`.
- Branch de trabalho deste plano: `fila-autonoma`, saída de `master`. Commits em português, padrão `feat:`/`fix:`/`docs:` do repo, terminando com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Mensagem de commit **por arquivo** (`git commit -F`) quando contiver `--no-verify` em texto.
- CRLF: `core.autocrlf=true` nesta máquina. Parsers normalizam `\r\n`.

## Review Focus

1. `.dev.vars` ausente, ou sem `APP_TOKEN`: `node tools/app.mjs /api/catalogo` sai 1 com mensagem em português, sem stack trace e sem imprimir nada do arquivo (teste na Task 4).
2. `python tools/db.py select "select 1; delete from transacoes"`: recusado **antes** de abrir conexão, mesmo com `DATABASE_URL` inválida no ambiente (teste na Task 3).
3. Diff que toca só `.github/workflows/ci.yml` ou `package.json`: vira `nao_classificados`, o item **não** é devolvido, mas o degrau 2 é barrado (teste na Task 1).
4. Fila recém-criada (`ORDEM.md` com as três faixas vazias, `feitos.js` vazio): `checar` passa e `candidatos` devolve as três listas vazias (teste na Task 1).
5. `git push origin fila/x:master` ou `git push origin HEAD:master`: o hook recusa pela ref de destino, qualquer que seja a branch local (teste na Task 2).

## Mapa de arquivos

```
fila/_modelo.md · fila/README.md · fila/ORDEM.md · fila/feitos.js        (Task 1) formato da fila
tools/fila-md.mjs (cópia) · tools/fila.mjs · tools/test-fila.mjs        (Task 1) regras + comandos + testes
package.json (script test com globs explícitos)                          (Task 1)
tools/hooks/pre-push · .gitignore                                         (Task 2) trava de push
tools/db.py · tests/test_db.py                                            (Task 3) banco: select read-only, ensaiar, aplicar
tools/app.mjs · tools/test-app.mjs                                        (Task 4) GET no app com o token
.github/workflows/ci.yml · .claude/settings.json · etiquetas do gh        (Task 5) CI e permissões
.claude/agents/{pm,coder,reviewer,entrega}-financas.md                    (Task 6) os quatro papéis
.claude/workflows/fila.js                                                 (Task 7) o condutor
CLAUDE.md · README.md · BACKLOG.md · docs/superpowers/specs/…receita.md   (Task 8) documentação
PR, merge, hook instalado, ensaio                                         (Task 9) integração
```

---

### Task 1: Formato da fila, parser e regras (`fila/`, `tools/fila*.mjs`)

**Files:**
- Create: `fila/_modelo.md`, `fila/README.md`, `fila/ORDEM.md`, `fila/feitos.js`
- Create: `tools/fila-md.mjs` (cópia literal de `C:\Users\caioc\Caio\receita-fila-autonoma\kit\tools\fila-md.mjs`)
- Create: `tools/fila.mjs` (conteúdo abaixo, adaptado do kit)
- Create: `tools/test-fila.mjs` (cópia do kit + as edições abaixo)
- Modify: `package.json` (script `test`)

**Interfaces:**
- Consumes: nada.
- Produces: `node tools/fila.mjs [--ref <ref>] checar [pasta] | concluir <id> "<meta>" [pasta] | candidatos | toca <id> <base> <head> | degrau2 <id>`; exports `TOCA_FIXOS`, `tocaValido`, `checar`, `classificar`, `tocaDeCaminhos`, `foraDoDeclarado`, `degrau2`, `branchesLocais`, `carregarFila`, `CABECALHO_FEITOS`. Vocabulário `toca`: `migracao`, `worker`, `app`, `tools`. Saída de `toca`: `{id, declarado, derivado, nao_classificados, fora_do_declarado}`. Saída de `degrau2`: `{id, ok, motivos}`. Saída de `candidatos`: `{prontos:[{id,nome,toca}], bloqueados:[{id,motivo}], em_pr:[id]}`.

- [ ] **Step 1: Criar a branch e a pasta `fila/`**

```bash
git checkout -b fila-autonoma master
mkdir -p fila
```

`fila/_modelo.md`:

```markdown
---
id: XNN
estado: livre          # livre | espera | pronto  (feito sai daqui e vai para feitos.js)
exige: []              # ids que precisam estar feitos antes
toca: []               # migracao | worker | app | tools
auto_merge: true       # false = mesmo no degrau 2 a PR espera o "entrega a #N"
---
# Nome do item

## Problema
O que dói hoje, no uso diário.

## Valor
O que muda quando estiver pronto. Por que vale mais que o item de baixo.

## Pronto quando (DoD)
- [ ] frases conferíveis — cada uma vira teste ou conferência numa rota

## Exemplo
Um caso concreto com números **inventados** (o repositório é público). Trava a interpretação melhor que prosa. Vira teste.

## Fora
- o que não fazer, mesmo parecendo óbvio

## Decisões
- AAAA-MM-DD · o que ficou decidido · quem decidiu

## Perguntas em aberto
- o PM pergunta e recomenda aqui, terminando em (PM, AAAA-MM-DD); o Caio responde embaixo. Só vira `pronto` com esta seção vazia.
```

`fila/README.md`:

```markdown
# fila/ — um arquivo por item do backlog

A fonte da fila autônoma. A rodada lê esta pasta pelo `tools/fila.mjs`, sempre de
`origin/master`. Ver `docs/superpowers/specs/2026-09-26-fila-autonoma-receita.md`.

- Um `<id>.md` por item aberto, no formato do [`_modelo.md`](_modelo.md): sete seções
  fixas, nesta ordem.
- A ordem mora no [`ORDEM.md`](ORDEM.md), em três faixas (Agora, Próximo, Depois); só a
  faixa Agora tem ordem exata, e é a ordem da rodada.
- O histórico dos entregues mora no `feitos.js`, escrito só por
  `node tools/fila.mjs concluir <id> "<meta>"`. Não se edita à mão.
- No Obsidian, edite as listas do frontmatter no texto (`exige: [B2]`): o painel de
  Propriedades as regrava em bloco, e o `checar` recusa.
- **O repositório é público.** Nada de valor real, contraparte, chave Pix ou comprovante
  aqui: exemplos com números inventados.
- Ideia ainda sem card fica no `BACKLOG.md`; quando vira card aqui, a linha sai de lá.
```

`fila/ORDEM.md`:

```markdown
# Ordem da fila

## Agora

## Próximo

## Depois
```

`fila/feitos.js`:

```js
// fila/feitos.js — itens entregues. Histórico: não se edita à mão;
// `node tools/fila.mjs concluir <id> "<meta>"` acrescenta o item que a PR entrega.
const ITENS = [
];
```

- [ ] **Step 2: Copiar o parser puro**

```bash
cp "C:/Users/caioc/Caio/receita-fila-autonoma/kit/tools/fila-md.mjs" tools/fila-md.mjs
```

Sem edição: o parser não sabe de vocabulário nem de vitrine. (Os valores `espera: paola|caio` continuam válidos; `quem`/`camada` são campos herdados, inofensivos.)

- [ ] **Step 3: Escrever `tools/fila.mjs`** (conteúdo completo)

```js
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
const INFRA_FILA = ["tools/fila.mjs", "tools/fila-md.mjs", "tools/db.py", "tools/app.mjs"];

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
```

- [ ] **Step 4: Copiar `tools/test-fila.mjs` do kit e aplicar as edições abaixo**

```bash
cp "C:/Users/caioc/Caio/receita-fila-autonoma/kit/tools/test-fila.mjs" tools/test-fila.mjs
```

Edições (cada `old` é texto exato do kit; substituir pelo `new`):

(a) Helper `pronto` — `toca: ["tela:/financas"]` → `toca: ["app"]`.

(b) Teste `carregarFila com erro de sintaxe explica em português`: `/não consegui ler docs\/fila\.js/` → `/não consegui ler feitos\.js/`.

(c) Teste `vocabulário de toca` — corpo inteiro:

```js
test("vocabulário de toca: só as quatro áreas do repositório", () => {
  for (const t of ["migracao", "worker", "app", "tools"]) assert.ok(tocaValido(t), t);
  for (const t of ["tela:/app", "tela:*", "costing", "banco", "Migracao", "api", ""]) assert.ok(!tocaValido(t), t);
});
```

(d) Teste `toca: cada caminho vai para a sua categoria` — corpo inteiro:

```js
test("toca: cada caminho vai para a sua categoria", () => {
  const r = tocaDeCaminhos([
    "migrations/0010_x.sql", "schema.sql",
    "worker/index.js", "worker/db.js", "worker/telegram.js",
    "public/app.js", "public/index.html", "public/shell.css",
    "tools/import_planilha.py", "tools/categorias.py",
  ]);
  assert.deepEqual(r.derivado, ["app", "migracao", "tools", "worker"]);
  assert.deepEqual(r.nao_classificados, []);
});
```

(e) Teste `toca: a calculadora é costing E tela — é a cópia inline da fórmula` — substituir inteiro por:

```js
test("toca: a infra da fila não é neutra nem vocabulário — mudar a regra muda as rodadas seguintes", () => {
  const r = tocaDeCaminhos(["tools/fila.mjs", "tools/fila-md.mjs", "tools/db.py", "tools/app.mjs", "tools/hooks/pre-push"]);
  assert.deepEqual(r.derivado, []);
  assert.deepEqual(r.nao_classificados, ["tools/app.mjs", "tools/db.py", "tools/fila-md.mjs", "tools/fila.mjs", "tools/hooks/pre-push"]);
});
```

(f) Teste `toca: neutros não contam — toda entrega mexe neles` — corpo inteiro:

```js
test("toca: neutros não contam — toda entrega mexe neles", () => {
  const r = tocaDeCaminhos([
    "docs/superpowers/specs/x.md", "docs/superpowers/plans/y.md", "BACKLOG.md", "CONTEXTO.md", "README.md",
    "tests/test_db.py", "tests/test_import.py", "worker/db.test.mjs", "public/app.test.mjs",
    "tools/test-fila.mjs", "tools/test-app.mjs",
  ]);
  assert.deepEqual(r, { derivado: [], nao_classificados: [] });
  // A fila em Markdown também é registro: toda entrega a move (concluir).
  assert.deepEqual(tocaDeCaminhos(["fila/feitos.js", "fila/ORDEM.md", "fila/B50.md"]), { derivado: [], nao_classificados: [] });
});
```

(g) Teste `toca: código de produção fora do vocabulário vira nao_classificado` — corpo inteiro (cobre o Review Focus 3):

```js
test("toca: código fora do vocabulário vira nao_classificado — não devolve, mas barra o degrau 2", () => {
  const r = tocaDeCaminhos([".github/workflows/ci.yml", "package.json", "wrangler.toml", "pyproject.toml", "tools/hooks/x"]);
  assert.deepEqual(r.derivado, []);
  assert.deepEqual(r.nao_classificados, [".github/workflows/ci.yml", "package.json", "pyproject.toml", "tools/hooks/x", "wrangler.toml"]);
  assert.deepEqual(foraDoDeclarado(r.derivado, ["app"]), []);
  const item = base({ pronto: pronto({ toca: ["app"], auto_merge: true }) });
  const d2 = degrau2(item, { degrau: 2, derivado: [], nao_classificados: r.nao_classificados, aprovou_de_primeira: true });
  assert.equal(d2.ok, false);
  assert.match(d2.motivos.join(" "), /não classificado/);
});
```

(h) Teste `toca: barra do Windows é normalizada`: `assert.deepEqual(tocaDeCaminhos(["docs\\financas.html"]).derivado, ["tela:/financas"]);` → `assert.deepEqual(tocaDeCaminhos(["public\\app.js"]).derivado, ["app"]);`.

(i) Teste `fora do declarado: tela:* declarado cobre qualquer tela` — substituir inteiro por:

```js
test("fora do declarado: o que o diff tocou e o item não declarou", () => {
  assert.deepEqual(foraDoDeclarado(["app", "worker"], ["app"]), ["worker"]);
  assert.deepEqual(foraDoDeclarado(["app"], ["app", "worker"]), []);
  assert.deepEqual(foraDoDeclarado(["migracao"], ["app"]), ["migracao"]);
  assert.deepEqual(foraDoDeclarado([], []), []);
});
```

(j) Bloco do degrau 2 — substituir `const itemAuto = ...` até o fim do teste `degrau 2: cada condição derruba sozinha` por:

```js
const itemAuto = base({ pronto: pronto({ toca: ["app"], auto_merge: true }) });
const d2ok = { degrau: 2, derivado: ["app"], nao_classificados: [], aprovou_de_primeira: true };

test("degrau 2: tudo certo, pode", () => {
  assert.deepEqual(degrau2(itemAuto, d2ok), { ok: true, motivos: [] });
});

test("degrau 2: worker e app não barram — o Caio é o único usuário e a entrega deploya e confere", () => {
  assert.deepEqual(degrau2(itemAuto, { ...d2ok, derivado: ["app", "worker"] }), { ok: true, motivos: [] });
  const itemWorker = base({ pronto: pronto({ toca: ["worker", "tools"], auto_merge: true }) });
  assert.deepEqual(degrau2(itemWorker, { ...d2ok, derivado: ["tools", "worker"] }), { ok: true, motivos: [] });
});

test("degrau 2: cada condição derruba sozinha", () => {
  const casos = [
    [itemAuto, { ...d2ok, degrau: 1 }, /degrau 1/],
    [base({ pronto: pronto({ toca: ["app"], auto_merge: false }) }), d2ok, /auto_merge/],
    [base({ pronto: pronto({ toca: ["migracao"], auto_merge: true }) }), d2ok, /migracao/],
    [itemAuto, { ...d2ok, derivado: ["migracao"] }, /migracao/],
    [itemAuto, { ...d2ok, nao_classificados: ["package.json"] }, /não classificado/],
    [itemAuto, { ...d2ok, aprovou_de_primeira: false }, /de primeira/],
  ];
  for (const [item, ctx, esperado] of casos) {
    const r = degrau2(item, ctx);
    assert.equal(r.ok, false, String(esperado));
    assert.match(r.motivos.join(" "), esperado);
  }
});
```

(k) Teste `toca: prompts dos agentes e CLAUDE.md não são neutros` — corpo inteiro:

```js
test("toca: prompts dos agentes e CLAUDE.md não são neutros", () => {
  const r = tocaDeCaminhos([".claude/agents/reviewer-financas.md", ".claude/workflows/fila.js", ".claude/settings.json", "CLAUDE.md", "CONTEXTO.md"]);
  assert.deepEqual(r.derivado, []);
  assert.deepEqual(r.nao_classificados, [".claude/agents/reviewer-financas.md", ".claude/settings.json", ".claude/workflows/fila.js", "CLAUDE.md"]);
});
```

(l) Helper `md` — `toca: [tela:/financas]` → `toca: [app]`. E no teste `pronto completo vira o bloco que a rodada consome, com o Exemplo junto`, o `deepEqual` esperado passa a ter `toca: ["app"]` no lugar de `toca: ["tela:/financas"]`.

(m) Testes de `gerar`: **apagar** os testes `CLI gerar escreve; --conferir aponta o esquecimento do gerar` e `CLI gerar --conferir ignora CRLF — o checkout do Windows não é diferença`.

(n) Teste `CLI concluir: sai do Markdown e do ORDEM, entra no histórico como feito` — corpo inteiro:

```js
test("CLI concluir: sai do Markdown e do ORDEM, entra no histórico como feito", () => {
  const dir = pastaTemporaria();
  const r = rodar(["concluir", "B1", "entregue 26/09 · resumo por pessoa", dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(dir, "B1.md")), false);
  assert.doesNotMatch(readFileSync(join(dir, "ORDEM.md"), "utf8"), /B1/);
  const feitos = carregarFila(readFileSync(join(dir, "feitos.js"), "utf8"));
  const b1 = feitos.find((i) => i.id === "B1");
  assert.deepEqual([b1.e, b1.camada, b1.quem, b1.meta], ["feito", 0, "feito", "entregue 26/09 · resumo por pessoa"]);
  assert.equal(b1.pronto, undefined);
  assert.equal(rodar(["checar", dir]).status, 0);
});
```

(o) Teste `CLI checar e gerar --conferir sobre a fila/ real passam` — substituir inteiro por (cobre o Review Focus 4):

```js
test("CLI checar sobre a fila/ real passa", () => {
  const r = rodar(["checar"]);
  assert.equal(r.status, 0, r.stderr);
});

test("fila recém-criada: faixas vazias e histórico vazio passam no checar e não têm candidatos", () => {
  const dir = pastaTemporaria({ ordem: "# Ordem da fila\n\n## Agora\n\n## Próximo\n\n## Depois\n", arquivos: {}, feitos: [] });
  const c = rodar(["checar", dir]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /0 itens \(0 abertos, 0 no histórico\), 0 prontos/);
  assert.deepEqual(classificar([], { prs: [], locais: [] }), { prontos: [], bloqueados: [], em_pr: [] });
});
```

(p) Teste `CLI gerar e concluir só gravam no docs/fila.js (ou em pasta temporária de teste)` — substituir inteiro por:

```js
test("CLI concluir só grava em fila/ (ou em pasta temporária de teste)", () => {
  const r = rodar(["concluir", "B1", "x", "tools"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /só grava/);
});
```

(q) Testes do hook `pre-push` — em todos, `refs/heads/main` → `refs/heads/master`, e:
- comentário: `A main publica o site sozinha no push` → `O master é o que se deploya`;
- nome `pre-push: main recusa, qualquer que seja a branch local` → `pre-push: master recusa, qualquer que seja a branch local`, com `for (const local of ["refs/heads/master", "refs/heads/fila/B1", "HEAD"])` e `assert.match(r.stderr, /master/)`;
- nome `pre-push: uma ref para a main no meio de várias recusa tudo` → `...para o master...`.

- [ ] **Step 5: Script `test` com globs explícitos** (`node --test` sem padrão varre a pasta inteira, e as worktrees da rodada em `.claude/worktrees/` duplicariam as suítes)

Em `package.json`, trocar `"test": "node --test"` por:

```json
"test": "node --test \"worker/*.test.mjs\" worker/test-worker.mjs \"public/*.test.mjs\" \"tools/test-*.mjs\""
```

- [ ] **Step 6: Rodar os testes da fila e a suíte inteira**

Run: `node --test tools/test-fila.mjs`
Expected: todos passam (o teste do hook falha até a Task 2 — aceitável neste passo **só** se o erro for `ENOENT` de `tools/hooks/pre-push`; qualquer outro vermelho é bug desta task). Depois `npm test` → `pass` = 298 + os da fila, `fail 0` (idem para o hook).

Run: `node tools/fila.mjs checar`
Expected: `fila/: 0 itens (0 abertos, 0 no histórico), 0 prontos`

- [ ] **Step 7: Commit**

```bash
git add fila/ tools/fila-md.mjs tools/fila.mjs tools/test-fila.mjs package.json
git commit -F - <<'EOF'
feat(fila): formato da fila em fila/ e regras em tools/fila.mjs (vocabulário do financas, sem vitrine)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 2: Trava de push (`tools/hooks/pre-push`) e `.gitignore`

**Files:**
- Create: `tools/hooks/pre-push`
- Modify: `.gitignore`
- Test: `tools/test-fila.mjs` (os três testes de `pre-push` da Task 1, item q)

**Interfaces:**
- Produces: hook instalado por `git config core.hooksPath tools/hooks` (Task 9); recusa qualquer push cuja ref de destino seja `refs/heads/master`.

- [ ] **Step 1: Rodar os testes do hook e ver falhar**

Run: `node --test tools/test-fila.mjs --test-name-pattern "pre-push"`
Expected: 3 falhas com `ENOENT`/`spawnSync sh` (o arquivo não existe).

- [ ] **Step 2: Escrever o hook**

`tools/hooks/pre-push`:

```sh
#!/bin/sh
# tools/hooks/pre-push - ninguem empurra para o master daqui.
#
# O master e o que a entrega deploya (wrangler deploy), e o GitHub deste plano
# nao protege o master do lado do servidor. As regras de permissao do
# .claude/settings.json casam texto de comando e se contornam (ex.:
# `git push origin fila/x:master`); este hook olha a ref DE DESTINO que o git
# vai atualizar, qualquer que seja o comando que chegou ate aqui.
#
# O master muda por PR (gh pr merge, no servidor, nao passa por aqui). Se um dia
# for preciso empurrar para o master a mao, o Caio usa --no-verify no terminal
# dele; nas sessoes do Claude o --no-verify e negado no settings.json.
#
# Instalar (uma vez por clone): git config core.hooksPath tools/hooks
while read -r _local _sha remota _rsha; do
  case "$remota" in
    refs/heads/master)
      echo "pre-push: recusado - o master so muda por PR (gh pr merge)." >&2
      exit 1
      ;;
  esac
done
exit 0
```

- [ ] **Step 3: `.gitignore`** — acrescentar ao fim:

```
.superpowers/            # relatórios e rascunhos de execução da fila
.claude/worktrees/       # worktrees da rodada
.claude/settings.local.json
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `node --test tools/test-fila.mjs`
Expected: tudo verde, inclusive `pre-push: branch fila/<id> passa`, `pre-push: master recusa, qualquer que seja a branch local`, `pre-push: uma ref para o master no meio de várias recusa tudo`.

- [ ] **Step 5: Commit**

```bash
git add tools/hooks/pre-push .gitignore
git commit -F - <<'EOF'
feat(fila): hook pre-push recusa push para o master; gitignore das worktrees e relatórios

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 3: Banco sem Neon MCP — `tools/db.py` (select read-only, ensaiar, aplicar)

**Files:**
- Create: `tools/db.py`
- Test: `tests/test_db.py`

**Interfaces:**
- Produces: `python tools/db.py select "<consulta>"` → `{"ok":true,"linhas":[{...}],"n":<int>}` (sessão `SET TRANSACTION READ ONLY`, no máximo 200 linhas); `python tools/db.py ensaiar <arquivo.sql> [--consulta "<select>"]...` → `{"ok":bool,"arquivo":str,"pos_deploy":bool,"consultas":[{"sql","linhas"}],"erro":str}` (transação com ROLLBACK, nada persiste); `python tools/db.py aplicar <arquivo.sql>` → `{"ok":bool,"arquivo":str,"erro":str}` (COMMIT). Código de saída 1 quando `ok:false`. `DATABASE_URL` do ambiente ou de `.dev.vars`.
- Funções puras exportadas: `ler_dev_vars(texto)`, `url_do_banco(env, raiz)`, `so_leitura(sql)`, `fase_pos_deploy(texto)`, `para_json(valor)`.

- [ ] **Step 1: Escrever os testes**

`tests/test_db.py`:

```python
"""Testes de tools/db.py — as partes puras: o que conta como leitura, de onde vem a
URL do banco, o marcador de fase. A conexão de verdade não roda no CI (não há banco
lá); o que se prova aqui é que a guarda vem ANTES de conectar."""
import json
import os
import subprocess
import sys
from datetime import date
from decimal import Decimal
from uuid import UUID

import pytest

from tools.db import ler_dev_vars, url_do_banco, so_leitura, fase_pos_deploy, para_json


def test_ler_dev_vars_tolera_crlf_comentario_aspas_e_igual_no_valor():
    texto = "# segredos\r\nAPP_TOKEN=abc==\r\n\r\nDATABASE_URL='postgresql://u:p=1@h/db'\r\nX = \"y\"\r\n"
    assert ler_dev_vars(texto) == {"APP_TOKEN": "abc==", "DATABASE_URL": "postgresql://u:p=1@h/db", "X": "y"}


def test_url_vem_do_ambiente_antes_do_dev_vars(tmp_path):
    (tmp_path / ".dev.vars").write_text("DATABASE_URL=do-arquivo\n", encoding="utf-8")
    assert url_do_banco({"DATABASE_URL": "do-ambiente"}, tmp_path) == "do-ambiente"


def test_url_cai_no_dev_vars_quando_o_ambiente_nao_tem(tmp_path):
    (tmp_path / ".dev.vars").write_text("DATABASE_URL=do-arquivo\n", encoding="utf-8")
    assert url_do_banco({}, tmp_path) == "do-arquivo"


def test_sem_url_em_lugar_nenhum_para_com_mensagem(tmp_path):
    with pytest.raises(SystemExit, match="DATABASE_URL"):
        url_do_banco({}, tmp_path)


def test_so_leitura_aceita_select_with_explain_e_ignora_comentarios():
    assert so_leitura("select 1")
    assert so_leitura("  -- conta\n  SELECT count(*) from transacoes;")
    assert so_leitura("with t as (select 1) select * from t")
    assert so_leitura("/* x */ explain select 1")


def test_so_leitura_recusa_escrita_ddl_e_duas_consultas():
    # Review Focus 2: "select 1; delete ..." tem que cair aqui, antes de qualquer conexão.
    for sql in ["delete from transacoes", "update transacoes set x=1", "insert into t values (1)",
                "drop table t", "select 1; delete from transacoes", "begin; select 1", ""]:
        assert not so_leitura(sql), sql


def test_fase_pos_deploy_so_pela_primeira_linha():
    assert fase_pos_deploy("-- fase: pos-deploy\nalter table t drop column x;")
    assert fase_pos_deploy("\n  -- FASE: pos-deploy\n")
    assert not fase_pos_deploy("-- 0010: aditiva\n-- fase: pos-deploy no fim não vale\n")


def test_para_json_converte_o_que_o_json_nao_sabe():
    assert para_json(Decimal("12.50")) == "12.50"
    assert para_json(date(2026, 9, 26)) == "2026-09-26"
    assert para_json(UUID("12345678-1234-5678-1234-567812345678")) == "12345678-1234-5678-1234-567812345678"
    with pytest.raises(TypeError):
        para_json(object())


def test_cli_select_com_escrita_sai_1_sem_tocar_o_banco():
    # URL inválida de propósito: se o script tentasse conectar, o erro seria outro.
    r = subprocess.run([sys.executable, "tools/db.py", "select", "select 1; delete from transacoes"],
                       capture_output=True, text=True, env={**os.environ, "DATABASE_URL": "postgresql://invalido"})
    assert r.returncode == 1
    saida = json.loads(r.stdout)
    assert saida["ok"] is False
    assert "só SELECT" in saida["erro"]


def test_cli_sem_comando_mostra_o_uso():
    r = subprocess.run([sys.executable, "tools/db.py"], capture_output=True, text=True)
    assert r.returncode == 1
    assert "uso:" in r.stderr
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `python -m pytest tests/test_db.py -q`
Expected: `ModuleNotFoundError: No module named 'tools.db'`.

- [ ] **Step 3: Escrever `tools/db.py`**

```python
"""tools/db.py — acesso ao banco para os papéis da fila autônoma.

Não há Neon MCP nesta máquina; o que existe é a DATABASE_URL em .dev.vars. Este
script é a única porta dos agentes para o banco, e cada comando tem a trava
embutida — não é regra de prompt:

  select  "<consulta>"                         leitura: SET TRANSACTION READ ONLY + ROLLBACK
  ensaiar <arquivo.sql> [--consulta "<sel>"]   roda o arquivo numa transação e dá ROLLBACK
                                               (prova que a migração roda e que as consultas
                                               das rotas rodam contra o schema novo)
  aplicar <arquivo.sql>                        roda o arquivo e COMMITA — só a entrega, com
                                               o Caio presente (fora do allow de propósito)

Cada comando imprime UMA linha de JSON e sai 1 quando ok=false. A URL nunca é
impressa. Sem parâmetros, o psycopg manda o texto como uma query simples, então um
arquivo com vários comandos roda de uma vez.
"""
import datetime
import decimal
import json
import os
import re
import sys
import uuid
from pathlib import Path

LIMITE_LINHAS = 200
USO = ('uso: python tools/db.py select "<consulta>" | ensaiar <arquivo.sql> [--consulta "<select>"]... '
       "| aplicar <arquivo.sql>")


def ler_dev_vars(texto):
    """KEY=valor por linha; vazias e # ignoradas; CRLF e aspas toleradas; o primeiro = separa."""
    campos = {}
    for bruta in texto.splitlines():
        linha = bruta.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        k, v = linha.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        campos[k.strip()] = v
    return campos


def url_do_banco(env=None, raiz=None):
    env = os.environ if env is None else env
    if env.get("DATABASE_URL"):
        return env["DATABASE_URL"]
    arquivo = Path(raiz or ".") / ".dev.vars"
    if arquivo.exists():
        url = ler_dev_vars(arquivo.read_text(encoding="utf-8")).get("DATABASE_URL")
        if url:
            return url
    raise SystemExit("DATABASE_URL: nem no ambiente nem em .dev.vars")


def so_leitura(sql):
    """Primeira barreira (a segunda é a transação read-only): uma consulta só, começando
    por SELECT/WITH/EXPLAIN. Ponto-e-vírgula no meio recusa — "select 1; delete" não passa."""
    limpo = re.sub(r"--[^\n]*|/\*.*?\*/", "", sql or "", flags=re.S).strip().rstrip(";")
    if ";" in limpo:
        return False
    return re.match(r"^(select|with|explain)\b", limpo, re.I) is not None


def fase_pos_deploy(texto):
    """Só a primeira linha não vazia marca a fase: comando destrutivo vive em arquivo à parte."""
    primeira = next((l.strip() for l in texto.splitlines() if l.strip()), "")
    return primeira.lower().startswith("-- fase: pos-deploy")


def para_json(v):
    if isinstance(v, (datetime.date, datetime.datetime, datetime.time)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, uuid.UUID):
        return str(v)
    raise TypeError(f"não sei serializar {type(v).__name__}")


def _linhas(cur):
    if cur.description is None:
        return []
    colunas = [d.name for d in cur.description]
    return [dict(zip(colunas, linha)) for linha in cur.fetchmany(LIMITE_LINHAS)]


def _erro(e):
    return f"{type(e).__name__}: {e}"


def cmd_select(sql):
    if not so_leitura(sql):
        return {"ok": False, "erro": "select: só SELECT/WITH/EXPLAIN, uma consulta por chamada"}
    import psycopg
    r = {"ok": True, "linhas": [], "n": 0}
    try:
        with psycopg.connect(url_do_banco(), autocommit=True) as conn:
            with conn.transaction():
                conn.execute("set transaction read only")
                cur = conn.execute(sql)
                r["linhas"] = _linhas(cur)
                r["n"] = cur.rowcount
                raise psycopg.Rollback()
    except Exception as e:
        r = {"ok": False, "erro": _erro(e)}
    return r


def cmd_ensaiar(arquivo, consultas):
    for c in consultas:
        if not so_leitura(c):
            return {"ok": False, "arquivo": arquivo, "pos_deploy": False, "consultas": [],
                    "erro": f"--consulta só aceita SELECT: {c[:80]}"}
    import psycopg
    texto = Path(arquivo).read_text(encoding="utf-8")
    r = {"ok": True, "arquivo": arquivo, "pos_deploy": fase_pos_deploy(texto), "consultas": [], "erro": ""}
    try:
        with psycopg.connect(url_do_banco(), autocommit=True) as conn:
            with conn.transaction():
                conn.execute(texto)
                for c in consultas:
                    r["consultas"].append({"sql": c, "linhas": _linhas(conn.execute(c))})
                raise psycopg.Rollback()   # o ensaio nunca persiste
    except Exception as e:
        r["ok"] = False
        r["erro"] = _erro(e)
    return r


def cmd_aplicar(arquivo):
    import psycopg
    texto = Path(arquivo).read_text(encoding="utf-8")
    r = {"ok": True, "arquivo": arquivo, "erro": ""}
    try:
        with psycopg.connect(url_do_banco(), autocommit=True) as conn:
            with conn.transaction():
                conn.execute(texto)
    except Exception as e:
        r["ok"] = False
        r["erro"] = _erro(e)
    return r


def main(argv):
    if not argv:
        print(USO, file=sys.stderr)
        sys.exit(1)
    cmd, *args = argv
    if cmd == "select" and len(args) == 1:
        r = cmd_select(args[0])
    elif cmd == "ensaiar" and args:
        arquivo, resto, consultas = args[0], args[1:], []
        while resto:
            if resto[0] == "--consulta" and len(resto) > 1:
                consultas.append(resto[1])
                resto = resto[2:]
            else:
                print(USO, file=sys.stderr)
                sys.exit(1)
        r = cmd_ensaiar(arquivo, consultas)
    elif cmd == "aplicar" and len(args) == 1:
        r = cmd_aplicar(args[0])
    else:
        print(USO, file=sys.stderr)
        sys.exit(1)
    print(json.dumps(r, ensure_ascii=False, default=para_json))
    sys.exit(0 if r["ok"] else 1)


if __name__ == "__main__":
    main(sys.argv[1:])
```

- [ ] **Step 4: Rodar e ver passar**

Run: `python -m pytest tests/test_db.py -q`
Expected: 10 passed.

- [ ] **Step 5: Ensaio real contra o banco (efeito zero: tudo em ROLLBACK)**

Criar `C:\Users\caioc\AppData\Local\Temp\claude\...\scratchpad\ensaio.sql` (fora do repo) com:

```sql
create table _ensaio_fila (x int);
insert into _ensaio_fila values (1), (2);
```

Run: `python tools/db.py ensaiar <caminho>/ensaio.sql --consulta "select count(*) as n from _ensaio_fila"`
Expected: `{"ok": true, ..., "pos_deploy": false, "consultas": [{"sql": "...", "linhas": [{"n": 2}]}], "erro": ""}`

Run: `python tools/db.py select "select count(*) as n from _ensaio_fila"`
Expected: `ok:false` com `UndefinedTable` (a tabela não existe: o ensaio não persistiu). Exit 1.

Run: `python tools/db.py select "select count(*) as n from categorias"`
Expected: `ok:true`, `linhas:[{"n": <número>}]`.

Run: `python tools/db.py select "delete from categorias"`
Expected: recusado pela guarda (`só SELECT`), exit 1, sem conectar.

Se o ensaio falhar com erro de "múltiplos comandos" do psycopg: separar os comandos por `;` e executar um a um dentro da mesma transação (`for parte in texto.split(";")`) — e acrescentar teste em `tests/test_db.py` para a função de split ignorando `;` em comentários.

- [ ] **Step 6: Commit**

```bash
git add tools/db.py tests/test_db.py
git commit -F - <<'EOF'
feat(fila): tools/db.py — select read-only, ensaio de migração com rollback e aplicar (sem Neon MCP)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 4: App no ar com o token — `tools/app.mjs`

**Files:**
- Create: `tools/app.mjs`
- Test: `tools/test-app.mjs`

**Interfaces:**
- Produces: `node tools/app.mjs <rota>` com `<rota>` = `/api/...` ou `/app`; imprime `{"status":<int>,"corpo":"<até 4000 chars>"}`; exit 0 se status < 400. Exports `URL_APP`, `lerDevVars`, `montarPedido(rota, token, base)`, `resumir(status, corpo, max)`.

- [ ] **Step 1: Escrever os testes**

`tools/test-app.mjs`:

```js
// tools/app.mjs é a única porta dos agentes para o app no ar. O que se prova aqui:
// o token sai do .dev.vars e vai só no cookie; só GET em /api/* e /app; a saída é
// curta. O fetch de verdade não roda em teste.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lerDevVars, montarPedido, resumir, URL_APP } from "./app.mjs";

test("lerDevVars: CRLF, comentário, aspas e '=' dentro do valor", () => {
  assert.deepEqual(lerDevVars("# x\r\nAPP_TOKEN=abc==\r\n\r\nDATABASE_URL='postgresql://u:p=1@h/db'\r\nX = \"y\"\r\n"),
    { APP_TOKEN: "abc==", DATABASE_URL: "postgresql://u:p=1@h/db", X: "y" });
});

test("montarPedido: rota de API ou /app, token só no cookie", () => {
  const p = montarPedido("/api/resumo?mes=2026-09", "tok123");
  assert.equal(p.url, `${URL_APP}/api/resumo?mes=2026-09`);
  assert.deepEqual(p.headers, { Cookie: "token=tok123" });
  assert.equal(montarPedido("/app", "t").url, `${URL_APP}/app`);
  assert.equal(montarPedido("/api/x", "t", "http://localhost:8787").url, "http://localhost:8787/api/x");
});

test("montarPedido: recusa o que não é /api/* nem /app, e token vazio", () => {
  for (const rota of ["/telegram", "https://outro.site/api/x", "api/x", "/app/../telegram", "/api/x y", "", undefined])
    assert.throws(() => montarPedido(rota, "t"), /rota/, String(rota));
  assert.throws(() => montarPedido("/api/x", ""), /APP_TOKEN/);
});

test("resumir: corta o corpo e diz que cortou", () => {
  assert.deepEqual(resumir(200, "abc", 10), { status: 200, corpo: "abc" });
  const r = resumir(200, "x".repeat(50), 10);
  assert.equal(r.status, 200);
  assert.match(r.corpo, /^x{10}…\[cortado, 50 chars\]$/);
});

// Review Focus 1: sem .dev.vars o script para com mensagem, sem stack e sem vazar nada.
test("CLI sem .dev.vars sai 1 com mensagem em português", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-"));
  const r = spawnSync(process.execPath, [join(process.cwd(), "tools/app.mjs"), "/api/catalogo"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.dev\.vars/);
  assert.doesNotMatch(r.stderr, /at .*app\.mjs/);
});

test("CLI com rota proibida sai 1 antes de qualquer rede", () => {
  const r = spawnSync(process.execPath, ["tools/app.mjs", "/telegram"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rota/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tools/test-app.mjs`
Expected: falha ao importar `./app.mjs` (não existe).

- [ ] **Step 3: Escrever `tools/app.mjs`**

```js
// tools/app.mjs — GET no app no ar com o token que o próprio app usa.
//
// O app fica atrás de APP_TOKEN (cookie `token`, ver worker/auth.js). Os papéis da
// fila precisam chamar o app no ar — o PM apura uma queixa chamando a rota, a
// entrega confere o deploy — sem abrir rota sem token e sem que o token apareça
// numa linha de comando, num relatório ou numa PR. Este script lê o token de
// .dev.vars (nunca versionado), manda como cookie e imprime só status e corpo.
// Só GET, só /api/* e /app: é tudo que a apuração e a conferência precisam.
//
// Uso: node tools/app.mjs /api/resumo?mes=2026-09
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const URL_APP = "https://financas.caiocatenacci.workers.dev";
const MAX_CORPO = 4000;

export function lerDevVars(texto) {
  const campos = {};
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith("#")) continue;
    const k = linha.indexOf("=");
    if (k < 0) continue;
    campos[linha.slice(0, k).trim()] = linha.slice(k + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return campos;
}

// Caminho absoluto, sem espaço, sem "..": /api/<qualquer coisa> ou /app. Vem
// antes de ler o .dev.vars: rota errada é erro do pedido, não do ambiente.
export function validarRota(rota) {
  if (typeof rota !== "string" || /\s|\.\./.test(rota) || !/^\/(api\/\S*|app)$/.test(rota))
    throw new Error(`rota tem que ser /api/... ou /app, não "${rota}"`);
  return rota;
}

export function montarPedido(rota, token, base = URL_APP) {
  validarRota(rota);
  if (!token) throw new Error("APP_TOKEN vazio ou ausente em .dev.vars");
  return { url: `${base}${rota}`, headers: { Cookie: `token=${token}` } };
}

export function resumir(status, corpo, max = MAX_CORPO) {
  return { status, corpo: corpo.length > max ? `${corpo.slice(0, max)}…[cortado, ${corpo.length} chars]` : corpo };
}

async function principal(argv) {
  let pedido;
  try {
    validarRota(argv[0]);
    let vars;
    try { vars = lerDevVars(readFileSync(".dev.vars", "utf8")); }
    catch { throw new Error("não achei .dev.vars na pasta atual (rode na raiz do repositório)"); }
    pedido = montarPedido(argv[0], vars.APP_TOKEN);
  } catch (e) { console.error(e.message); process.exit(1); }
  const r = await fetch(pedido.url, { method: "GET", headers: pedido.headers, redirect: "manual" });
  console.log(JSON.stringify(resumir(r.status, await r.text())));
  process.exit(r.status < 400 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) principal(process.argv.slice(2));
```

- [ ] **Step 4: Rodar e ver passar; chamar o app de verdade**

Run: `node --test tools/test-app.mjs`
Expected: 6 passam.

Run: `node tools/app.mjs /api/catalogo`
Expected: `{"status":200,"corpo":"{\"categorias\":[...` (exit 0). Não colar o corpo no relatório: contém nomes de categorias, só isso, mas a regra é não copiar.

Run: `node tools/app.mjs /api/nao-existe`
Expected: `{"status":404,...}`, exit 1.

- [ ] **Step 5: Commit**

```bash
git add tools/app.mjs tools/test-app.mjs
git commit -F - <<'EOF'
feat(fila): tools/app.mjs — GET no app no ar com o token do .dev.vars, só /api/* e /app

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 5: CI, etiquetas e permissões (`.github/workflows/ci.yml`, `.claude/settings.json`)

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.claude/settings.json`
- Externo: etiquetas `fila` e `tem migração` no repositório (`gh label create`)

**Interfaces:**
- Produces: workflow `ci.yml` (nome que o pré-voo consulta com `gh run list --workflow ci.yml`); permissões que cobrem tudo que os quatro papéis rodam.

- [ ] **Step 1: `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:
  workflow_dispatch:

jobs:
  testes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "24"

      # Só as dependências de produção: as suítes são puras (sem banco, sem rede).
      - run: npm ci --omit=dev

      # Worker, app e as regras da fila (tools/test-fila.mjs entra pelo glob do script).
      - name: Testes do Worker, do app e da fila
        run: npm test

      # A fila mora em fila/ (um .md por item, ORDEM.md, feitos.js). Um .md torto
      # pararia a rodada inteira; aqui ele para a PR.
      - name: Fila bem formada?
        run: node tools/fila.mjs checar

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      # Sem `pip install -e .`: o pyproject não declara pacotes e o setuptools recusaria
      # o layout plano com tools/ e tests/. O pytest acha tools/ pelo tests/__init__.py.
      - run: pip install "psycopg[binary]>=3.0" "openpyxl>=3.1" "pytest>=8"

      - name: Import, mapeamento e tools/db.py
        run: python -m pytest tests/ -q
```

- [ ] **Step 2: `.claude/settings.json`** (versionado; casa texto de comando — o que segura de verdade é o hook e a lista `tools` de cada agente)

```json
{
  "permissions": {
    "allow": [
      "Bash(git status)", "Bash(git status *)", "Bash(git fetch *)", "Bash(git diff *)", "Bash(git log *)",
      "Bash(git show *)", "Bash(git branch *)", "Bash(git worktree *)", "Bash(git add *)",
      "Bash(git commit *)", "Bash(git checkout *)", "Bash(git switch *)", "Bash(git rev-parse *)",
      "Bash(git merge origin/master*)", "Bash(git merge --ff-only origin/master)",
      "Bash(git push -u origin fila/*)",
      "Bash(node tools/fila.mjs *)", "Bash(node tools/app.mjs *)",
      "Bash(npm test)", "Bash(node --test tools/test-fila.mjs)", "Bash(node --test tools/test-app.mjs)",
      "Bash(python -m pytest tests/ -q)", "Bash(python -m pytest tests/ -q *)",
      "Bash(python tools/db.py select *)", "Bash(python tools/db.py ensaiar *)",
      "Bash(npx wrangler deploy)", "Bash(npx wrangler deploy *)", "Bash(npx wrangler deployments list*)",
      "Bash(gh auth status)", "Bash(gh auth status *)", "Bash(gh run list *)", "Bash(gh run view *)",
      "Bash(gh pr list *)", "Bash(gh pr view *)", "Bash(gh pr diff *)",
      "Bash(gh pr create *)", "Bash(gh pr checks *)", "Bash(gh pr merge *)",
      "Edit(fila/**)", "Write(fila/**)", "Write(.superpowers/**)"
    ],
    "deny": [
      "Bash(git push * master)", "Bash(git push * master *)", "Bash(git push *:master*)",
      "Bash(git push *refs/heads/master*)", "Bash(git push * HEAD:master*)",
      "Bash(git push *--force*)", "Bash(git push * -f*)", "Bash(git push *--no-verify*)",
      "Bash(git * --no-verify*)", "Bash(git config *hooksPath*)",
      "Bash(node *..*)", "Bash(python *..*)",
      "Bash(curl * -X *)", "Bash(curl * --request*)", "Bash(curl * -d *)",
      "Bash(curl * --data*)", "Bash(curl * -F *)", "Bash(curl * --form*)",
      "Bash(curl * -T *)", "Bash(curl * --upload-file*)"
    ]
  }
}
```

Fora do allow **de propósito**: `python tools/db.py aplicar` (efeito em produção; só a entrega, com o Caio presente, porque `migracao` barra o degrau 2). `gh pr merge` **está** no allow porque o degrau 2 é o padrão e a entrega precisa mergear sem ninguém olhando.

- [ ] **Step 3: Etiquetas** (externo, reversível)

```bash
gh label create "fila" --color 5319e7 --description "PR aberta pela rodada autônoma" --force
gh label create "tem migração" --color d93f0b --description "Aplicar no banco antes do merge, pelo entrega a #N" --force
gh label list | grep -E "^(fila|tem migra)"
```

Expected: as duas etiquetas listadas.

- [ ] **Step 4: Validar o YAML e o JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('settings ok')"`
Expected: `settings ok`.

Run: `python -c "import yaml" 2>/dev/null && python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci ok')" || echo "sem pyyaml — o CI valida na PR"`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .claude/settings.json
git commit -F - <<'EOF'
feat(fila): CI (npm test, checar, pytest) e permissões dos papéis em .claude/settings.json

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 6: Os quatro agentes (`.claude/agents/*-financas.md`)

**Files:**
- Create: `.claude/agents/pm-financas.md`, `.claude/agents/coder-financas.md`, `.claude/agents/reviewer-financas.md`, `.claude/agents/entrega-financas.md`

**Interfaces:**
- Consumes: `tools/fila.mjs`, `tools/db.py`, `tools/app.mjs`, suítes (`npm test`, `python -m pytest tests/ -q`).
- Produces: schemas que o workflow (Task 7) exige — PM pré-voo `{ok, motivo, prontos[], bloqueados[], em_pr[]}`; PM apuração `{veredito: segue|devolve, motivo, achados, aceite_interpretado[]}`; coder `{status: pronto|precisa_decisao|falhou, motivo, worktree, branch, commits[]}`; reviewer `{veredito: aprova|reprova, achados[], evidencia_por_aceite[{aceite, evidencia}], migracao_ensaiada}`; entrega `{entregue, migracao_aplicada, deploy, verificacao}`.

- [ ] **Step 1: `pm-financas.md`**

```markdown
---
name: pm-financas
description: PM da fila autônoma do financas. Faz o pré-voo da rodada e apura um item pronto contra código, app no ar e banco, devolvendo "segue" ou "devolve"; no planejamento, escreve perguntas e registra decisões em fila/. Nunca decide requisito. Usado pelo workflow fila e pelo "revisa o planejamento".
tools: Read, Grep, Glob, Bash, Edit, Write
model: inherit
---

Você é o PM da fila autônoma do financas. Você **apura e devolve; nunca decide**.
Decidir o que um item é pertence ao Caio: no projeto de origem, uma conclusão inteira
caiu por um parâmetro chutado sem aviso.

## Regras do papel

- **Só leitura, com uma exceção.** No pré-voo e na apuração você não edita nada, não
  faz commit, não cria branch. No **refinamento** (abaixo) você edita **só**
  `fila/*.md` e `fila/ORDEM.md`, e só na branch `planejamento`. Nunca commit no
  `master`, nunca push. Bash é para `git show/log/diff/fetch/branch --list/status/add/commit`,
  `gh`, `node tools/fila.mjs`, `node tools/app.mjs` e `python tools/db.py select`.
- **Banco:** `python tools/db.py select "<consulta>"` — uma consulta por chamada, a
  sessão é read-only por construção. Nunca `ensaiar`, nunca `aplicar`.
- **App no ar:** `node tools/app.mjs /api/<rota>` — só GET; o token sai de `.dev.vars`
  sozinho. Nunca `curl`. Queixa sobre uma tela se apura **chamando a rota** que a
  alimenta (`/api/transacoes`, `/api/resumo?mes=`, `/api/metas?mes=`, `/api/catalogo`,
  `/api/pessoas`), não lendo o código.
- **O repositório é público.** Nunca copie valor, descrição, nome de contraparte, chave
  Pix nem linha de transação para a sua saída, para `fila/` ou para uma pergunta. Cite
  contagens, colunas, ids de categoria e datas.
- A fila se lê de `origin/master`, nunca da árvore de trabalho:
  `node tools/fila.mjs --ref origin/master ...` e `git show origin/master:fila/<id>.md`.
  (Exceção: no refinamento você lê e edita a árvore de trabalho da branch `planejamento`.)
- No pré-voo e na apuração sua saída vai para um script, não para uma pessoa: preencha o
  schema, sem floreio. No refinamento ela vai para o Caio: curta, por item.

## Pré-voo (quando o pedido disser "pré-voo")

1. `gh auth status`: a conta ativa tem que ser `CaioCatenacci`. Se não for,
   `ok:false`, motivo `gh na conta errada: rode gh auth switch --user CaioCatenacci`.
   Não troque você.
2. `git fetch origin --prune`.
3. CI do master: `gh run list --branch master --workflow ci.yml --limit 1 --json status,conclusion`.
   Só `completed` + `success` é verde. Senão `ok:false`, com o que viu.
4. Candidatos:
   ```bash
   gh pr list --state open --json headRefName --jq '{prs: [.[].headRefName]}' | node tools/fila.mjs --ref origin/master candidatos
   ```
   (As branches `fila/*` locais o próprio comando lê do git.)
   Copie `prontos`, `bloqueados` e `em_pr` **exatamente** como o comando devolveu.
5. Tudo certo → `ok:true`, `motivo:""`.

## Apuração de um item (quando o pedido disser "apure o item <id>")

1. Leia o item em `git show origin/master:fila/<id>.md` — **Pronto quando** (= aceite),
   **Fora**, **Exemplo** e o `toca` do frontmatter — e, se o item citar, a seção do
   `CONTEXTO.md` ou a linha do `BACKLOG.md` de onde veio. O **Exemplo** também se
   confere: os números dele têm que ser reproduzíveis com o código de hoje (é exemplo
   inventado; o que se confere é se o cálculo descrito bate com o que o código faz).
2. Para cada frase do `aceite`, confronte com o código (`worker/`, `public/app.js`,
   `tools/*.py`), com o app no ar e, se precisar de número, com o banco (contagens e
   agregados). Anote o que achou **e o comando que usou**.
3. `devolve` quando:
   - a apuração **muda a figura** do item: o defeito não é o descrito, a causa é outra,
     o dado não é o que o aceite supõe;
   - uma frase do aceite é vaga ("melhorar", "mais legível", "se fizer sentido",
     "ajustar") ou não tem como ser conferida;
   - falta um dado ou uma decisão do Caio que não está escrita;
   - o `toca` declarado claramente não cobre o que o aceite exige (ex.: o aceite pede
     coluna nova e o `toca` não tem `migracao`; pede algo no app e não tem `app`).
4. Senão, `segue`. Em `aceite_interpretado`, reescreva cada frase do aceite como a
   conferência concreta que o coder e o reviewer vão fazer (teste em que arquivo, rota
   e campo, comando).
5. `achados` vai **inteiro** para o relatório do Caio: é o insumo do próximo
   refinamento. Escreva completo, com contagens e comandos. Não resuma.

## Refinamento (quando o pedido disser "revisa o planejamento" ou "fecha o planejamento")

Você trabalha na branch `planejamento`, na árvore de trabalho (não em origin/master).
Confira com `git branch --show-current` antes de editar; em outra branch, pare e diga.

**"revisa o planejamento":**
1. `git diff --name-only origin/master...HEAD -- fila/` mais todos os itens da faixa
   Agora do `fila/ORDEM.md`.
2. Para cada item, apure como na apuração da rodada: cada frase do **Pronto quando** é
   conferível? o dado existe (`select`, GET na rota)? o `toca` cobre? o **Exemplo** é
   reproduzível?
3. Escreva cada pergunta ou recomendação em **Perguntas em aberto**, como item de lista
   de primeiro nível, terminando em `(PM, AAAA-MM-DD)`, com o número ou comando que a
   originou. Recomendação diz qual opção você recomenda e por quê.
4. Resposta do Caio embaixo de uma pergunta (linha recuada ou texto solto): transforme
   em linha de **Decisões** — `AAAA-MM-DD · <o que ficou decidido> · Caio` — e apague a
   pergunta junto com a resposta. Se a redação da decisão é sua, escreva
   `Caio (redação: assistente)`. Se a resposta abre outra dúvida, a pergunta nova entra
   no lugar.
5. **Não altere Problema, Valor, Pronto quando nem Fora por conta própria.** Proponha
   em pergunta; mude só o que o Caio decidiu.
6. `node tools/fila.mjs checar` no fim — o arquivo tem que continuar legível.
7. Devolva: por item, quantas perguntas abertas e o que bloqueia a faixa Agora.

**Decisão tomada na conversa:** quando o pedido trouxer uma decisão do Caio, registre-a
em **Decisões** do item e apague a pergunta que ela fecha.

**"fecha o planejamento":**
1. Para cada item de Agora que o Caio disse estar pronto: `estado: pronto` e, em
   Decisões, a linha `AAAA-MM-DD · estado: pronto · Caio`. Nunca marque pronto por
   conta própria.
2. `node tools/fila.mjs checar`. Erro → diga qual e pare.
3. `git add fila/` e commit na branch `planejamento` (mensagem por arquivo:
   `git commit -F <arquivo>`). Diga que está pronto para a PR — o push e a PR ficam
   com a sessão principal.
```

- [ ] **Step 2: `coder-financas.md`**

```markdown
---
name: coder-financas
description: Implementa um item pronto da fila autônoma do financas numa worktree própria, com TDD a partir do aceite. Não faz push. Usado pelo workflow fila.
tools: Read, Edit, Write, Glob, Grep, Bash
permissionMode: acceptEdits
model: inherit
---

Você implementa **um** item da fila do financas. O `CLAUDE.md` do projeto vale
inteiro (leia o `CONTEXTO.md` quando o item tocar uma decisão registrada lá); aqui
estão só as regras do papel.

## Onde trabalhar

- Primeira vez no item:
  ```bash
  git fetch origin
  git worktree add .claude/worktrees/fila-<id> -b fila/<id> origin/master
  ```
  e **todo** o trabalho acontece dentro dessa pasta. O `node_modules` da raiz serve
  (o Node sobe as pastas até achar); o `pytest` acha `tools/` da worktree pelo
  `tests/__init__.py`.
- Correção (o pedido traz achados do reviewer): a worktree já existe; trabalhe nela.
- **Nunca** `git push`, nunca `gh pr`, nunca tocar o `master`. Quem publica é outro
  passo, depois da revisão.
- **Nunca** `python tools/db.py` (nem `select`). Migração é arquivo; quem a ensaia é o
  reviewer. Nunca `npx wrangler`.

## Como

1. Leia o item (`fila/<id>.md`: Pronto quando, Exemplo, Fora) e, se citar, a seção do
   `CONTEXTO.md` ou a linha do `BACKLOG.md`. O **Exemplo** vira um dos testes. Numa
   passada de correção o arquivo já saiu da worktree (pelo `concluir`): leia de
   `git show origin/master:fila/<id>.md`. O `aceite_interpretado` e o apurado do PM
   vêm no pedido.
2. TDD: para cada frase do aceite, um teste que falha antes e passa depois. Teste em
   português, dizendo o porquê. Regra pura vai em módulo puro (`worker/*.js` sem
   banco/rede, testado em `worker/*.test.mjs`; `public/app.js` idem em
   `public/app.test.mjs`; Python em `tools/*.py` + `tests/test_*.py`).
3. Respeite `Fora` à risca. Se o aceite só fecha mexendo em algo fora do `toca`
   declarado, ou exige uma escolha que o aceite não resolve, **pare**:
   `status: precisa_decisao`, com a escolha descrita. Não escolha pelo Caio.
4. As regras do projeto que mais mordem:
   - dinheiro em **centavos** na API; `parseBRtoCents()` de `worker/money.js` na
     entrada; agregação em SQL, nunca float acumulado em JS; parcelas fecham com o total;
   - campo de número: `type="text"` + `inputmode="decimal"`;
   - **toda leitura agregada filtra por `conta_no_resumo`**, nunca por `computa_resumo`;
   - categoria: fallback é a `padrao=true`, nunca por nome; `resolverCategoria` existe em
     três lugares (`worker/categorias.js`, `public/app.js`, `tools/categorias.py`) — se
     mexer num, mexa nos três; natureza segue a categoria ao reclassificar;
   - vocabulário das colunas (`natureza`, `esfera`, `fonte`, `origem_categoria`,
     `extraido_por`) é fechado: nada de valor novo;
   - banco → `migrations/00NN_<nome>.sql` (próximo número livre, aditiva e idempotente:
     `if not exists`) **e** `schema.sql`. Comando destrutivo (DROP, DELETE) **só** em
     arquivo à parte cuja primeira linha é `-- fase: pos-deploy`;
   - **nada de dado real** em teste ou fixture: o repositório é público.
5. No mesmo trabalho:
   - `node tools/fila.mjs concluir <id> "entregue <DD/MM> · <o que saiu, em uma linha>"`
     — tira o item de `fila/`, põe no `fila/feitos.js`. Não edite esses arquivos à mão;
   - se o item veio de uma linha do `BACKLOG.md`, tire a linha; o que ficou de fora e
     vale registrar entra lá como linha nova, com a origem;
   - se o item muda uma regra do projeto (vocabulário, fórmula, fluxo), a seção
     correspondente do `CONTEXTO.md` ganha o registro (o `CLAUDE.md` só se a regra for
     de convenção — e isso tira o item do merge automático, de propósito).
6. Rode tudo antes de dizer pronto, **dentro da worktree**:
   ```bash
   npm test
   python -m pytest tests/ -q
   node tools/fila.mjs checar
   ```
7. Commits pequenos, em português, no padrão do repo (`feat: …`, `fix: …`, `docs: …`),
   terminando com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Mensagem
   por arquivo (`git commit -F <arquivo em .superpowers/>`): texto com `--no-verify`
   dentro da mensagem casa com uma regra de deny.

## Saída

`pronto` só com as suítes verdes. `falhou` se não conseguiu deixá-las verdes — diga
qual e por quê. `precisa_decisao` conforme o passo 3. Sempre devolva `worktree`
(caminho absoluto), `branch` e a lista de `commits` (hash curto + mensagem).
```

- [ ] **Step 3: `reviewer-financas.md`**

```markdown
---
name: reviewer-financas
description: Revisa e testa a entrega de um item da fila autônoma do financas — suítes, diff inteiro, ensaio da migração com rollback, e evidência para cada frase do aceite. Não edita. Usado pelo workflow fila.
tools: Read, Grep, Glob, Bash
model: inherit
---

Você revisa a entrega de um item da fila. **Não edita nada**: seus achados voltam
para o coder. No degrau 2 a sua aprovação vira merge e deploy sem ninguém olhar —
aprove só o que você defenderia.

## O que rodar, dentro da worktree que o pedido informa

1. As suítes inteiras, você mesmo — não confie no relato do coder:
   `npm test`, `python -m pytest tests/ -q`, `node tools/fila.mjs checar`.
2. `git diff origin/master...HEAD` — leia tudo.
3. Tem migração (arquivo novo em `migrations/`)? Ensaie contra o banco, com rollback:
   ```bash
   python tools/db.py ensaiar migrations/00NN_<nome>.sql --consulta "<consulta real da rota tocada>"
   ```
   As `--consulta` são as consultas de `worker/db.js` das rotas que o item toca, com
   parâmetros plausíveis, copiadas (não inventadas). O que se prova é que a migração
   **roda** e que a consulta **roda contra o schema novo** — o `sql` falso das suítes só
   prova que ela cita a coluna. `ok:false` é reprovação. Devolva `migracao_ensaiada:true`.
   Arquivo que começa com `-- fase: pos-deploy` se ensaia **separado, depois** do outro
   (ele pressupõe o código novo no ar).
   Nunca `python tools/db.py aplicar`. Nunca `npx wrangler`.
4. Sem migração: `migracao_ensaiada:false`.

## Checklist das regras que não se deduzem

- Dinheiro em centavos na API; `parseBRtoCents()` na entrada; agregação em SQL; parcelas
  fecham com o total, ao centavo.
- Campo numérico: `type="text"` + `inputmode="decimal"`.
- Agregação nova ou mudada filtra por `conta_no_resumo`, não por `computa_resumo`.
- `resolverCategoria`: se uma cópia mudou, as três mudaram (`worker/categorias.js`,
  `public/app.js`, `tools/categorias.py`); fallback pela `padrao`, nunca por nome.
- Natureza segue a categoria ao reclassificar (exceto crédito/estorno de extrato/fatura).
- Vocabulário das colunas fechado; migração aditiva, numerada, idempotente, com
  `schema.sql` atualizado; destrutivo só em arquivo `-- fase: pos-deploy`.
- **Nenhum dado real** (valor, contraparte, chave Pix, descrição de transação) em
  código, teste, fixture ou `fila/`. O repositório é público.
- `extrair.js`, `money.js`, `metas.js`, `grupos.js` seguem puros (sem banco, sem rede).
- O `Fora` do item foi respeitado.
- `fila/<id>.md` saiu e `fila/feitos.js` ganhou o item (pelo `concluir`, não à mão).

## Evidência por aceite

Para **cada** frase do aceite: o teste (arquivo e nome) ou a conferência (comando e
resultado) que a prova. Frase sem evidência é reprovação.

O **Exemplo** do item também precisa de evidência: leia-o em
`git show origin/master:fila/<id>.md` (na worktree o arquivo já saiu, pelo `concluir`) e
exija um teste que o reproduza.

## Saída

`aprova` ou `reprova`, com `achados` acionáveis: arquivo, linha, o que está errado,
o que você esperaria. Achado de gosto não reprova.
```

- [ ] **Step 4: `entrega-financas.md`**

```markdown
---
name: entrega-financas
description: Põe no ar uma PR da fila autônoma do financas — migração no banco, merge, wrangler deploy e conferência na rota. Só age com o "entrega a #N" do Caio, ou chamado pelo workflow no degrau 2 para item sem migração.
tools: Read, Grep, Glob, Bash
model: inherit
---

Você põe uma PR no ar. A entrega **só fecha em produção**: PR mergeada não é
feature no ar, e "deployou" não é verificação.

## Autorização

- Só aja se o pedido disser que o Caio mandou "entrega a #N", **ou** que veio do degrau 2.
- Degrau 2: confira o escopo com a **mesma regra** da rodada, não com uma lista sua:
  `node tools/fila.mjs --ref origin/master toca <id> origin/master fila/<id>`. O `derivado`
  não pode ter `migracao`, e `nao_classificados` tem que vir vazio. Se não for assim,
  pare sem fazer nada: `entregue:false`, `verificacao:"degrau 2 com escopo proibido"` e
  o JSON que o comando imprimiu.

## Ordem — não troque (código novo contra schema velho derruba o app)

1. `gh pr view N --json state,headRefName,mergeable,statusCheckRollup,body` e
   `gh pr diff N --name-only`. PR aberta e checks verdes; senão pare.
   - **Não mergeável porque outra PR da mesma rodada entrou antes** é o caso comum:
     todas saem do mesmo `origin/master` e mexem nos mesmos arquivos de registro. Se o
     conflito estiver **só** em `fila/feitos.js`, `fila/ORDEM.md`, `BACKLOG.md` e
     `CONTEXTO.md`: na worktree do item, `git fetch origin && git merge origin/master`,
     resolva mantendo **os dois lados** (os dois itens `feito` no `fila/feitos.js`,
     nenhum dos dois ids no `ORDEM.md`, as duas linhas/seções nos `.md`),
     `node tools/fila.mjs checar`, commit (mensagem por arquivo),
     `git push -u origin fila/<id>`, e espere o CI ficar verde de novo
     (`gh pr checks N --watch --fail-fast`). Conflito em qualquer outro arquivo: pare e
     diga qual.
2. Migração (arquivos novos em `migrations/`, na ordem numérica), só com o
   "entrega a #N" do Caio:
   1. `python tools/db.py ensaiar migrations/00NN_<nome>.sql --consulta "<consulta real da rota>"`
      para cada arquivo **sem** `-- fase: pos-deploy`. `ok:false` → pare.
   2. `python tools/db.py aplicar migrations/00NN_<nome>.sql` (pede permissão: o Caio
      está presente). `ok:false` → pare e diga o que já entrou.
3. Merge: `gh pr merge N --merge --delete-branch` (merge commit, como o repo faz).
4. Deploy, a partir de uma worktree limpa do master (não mexa no checkout principal,
   que pode ter trabalho do Caio):
   ```bash
   git fetch origin
   git worktree add .claude/worktrees/deploy origin/master
   npx wrangler deploy -c .claude/worktrees/deploy/wrangler.toml
   git worktree remove --force .claude/worktrees/deploy
   ```
   (Se `.claude/worktrees/deploy` já existir, `git worktree remove --force` antes.)
   Confira: `npx wrangler deployments list` mostra um deploy novo no topo (data de agora).
5. Verificação de fora, com o token do app:
   - `node tools/app.mjs /api/catalogo` → `status:200`;
   - para cada rota que o item tocou, `node tools/app.mjs /api/<rota>` responde no
     formato novo (campo novo presente, sem `erro`). Tente por até 2 minutos, a cada
     20 s, se a primeira resposta ainda vier no formato velho;
   - item que toca `app` (`public/`): `node tools/app.mjs /app` → `status:200`.
   Sem dado na saída: cite status, campos e contagens.
6. Fase 2: arquivos `-- fase: pos-deploy` só **depois** do passo 5 confirmado —
   ensaiar e aplicar, como no passo 2.
7. Limpeza local, se existirem: `git worktree remove --force .claude/worktrees/fila-<id>` e
   `git branch -D fila/<id>`.

## Saída

`entregue`, `migracao_aplicada` (o que rodou, em que ordem, ou "sem migração"),
`deploy` (o id ou a data do deployment novo, ou "não deployou") e `verificacao` (o que
você chamou e o que voltou, sem dado). Se parou no meio, diga **exatamente** em que
passo, o que já mudou em produção e o que não.
```

- [ ] **Step 5: Conferir que os agentes carregam**

Run: `claude -p "Liste os nomes dos agent types disponíveis que terminam em -financas. Responda só a lista." --max-turns 1 2>&1 | tail -8`
Expected: `pm-financas`, `coder-financas`, `reviewer-financas`, `entrega-financas`. Se `claude -p` não estiver no PATH ou pedir login, pular: a Task 9 (ensaio) confirma na prática.

- [ ] **Step 6: Commit**

```bash
git add .claude/agents/
git commit -F - <<'EOF'
feat(fila): os quatro agentes — pm, coder, reviewer e entrega do financas

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 7: O condutor — `.claude/workflows/fila.js`

**Files:**
- Create: `.claude/workflows/fila.js`

**Interfaces:**
- Consumes: agentes da Task 6 (`agentType`), `tools/fila.mjs toca|degrau2`, `gh`.
- Produces: `Workflow({ name: "fila", args: { limite, degrau, ensaio, data } })`; devolve `{parou, prs, resultados, relatorio, arquivo}` e grava `.superpowers/fila/<data>.md`.

- [ ] **Step 1: Escrever o workflow** (conteúdo completo)

```js
export const meta = {
  name: 'fila',
  description: 'Consome a fila do financas: PM apura, coder implementa, reviewer valida, PR aberta e, no degrau 2, entrega no ar — até o limite',
  whenToUse: 'Quando o Caio disser "roda a fila" ou "ensaia a fila". args: {limite, degrau, ensaio, data}',
  phases: [
    { title: 'Pré-voo', detail: 'conta do gh, CI do master, candidatos' },
    { title: 'Itens', detail: 'um por vez: PM, coder, escopo, reviewer, PR, degrau 2' },
    { title: 'Relatório', detail: 'grava .superpowers/fila/<data>.md' },
  ],
}

// As regras de parada moram aqui, em código: "até N", "para na primeira
// falha", "devolução não é falha". O julgamento fica com os agentes; a
// decisão exata (candidatos, escopo, degrau 2) fica com tools/fila.mjs.
const A = args || {}
const LIMITE = A.limite ?? 3
const DEGRAU = A.degrau ?? 2 // o Caio pediu o máximo de automação: merge e deploy sem migração são automáticos
const ENSAIO = A.ensaio === true
const DATA = A.data || 'sem-data' // o script não tem relógio: a sessão passa a data

const S = (props, required = Object.keys(props)) => ({ type: 'object', properties: props, required })
const str = { type: 'string' }
const bool = { type: 'boolean' }
const int = { type: 'integer' }
const strs = { type: 'array', items: str }
const um = (...v) => ({ type: 'string', enum: v })

const PRE = S({ ok: bool, motivo: str,
  prontos: { type: 'array', items: S({ id: str, nome: str, toca: strs }) },
  bloqueados: { type: 'array', items: S({ id: str, motivo: str }) },
  em_pr: strs })
const PARECER = S({ veredito: um('segue', 'devolve'), motivo: str, achados: str, aceite_interpretado: strs })
const CODER = S({ status: um('pronto', 'precisa_decisao', 'falhou'), motivo: str, worktree: str, branch: str, commits: strs })
const ESCOPO = S({ declarado: strs, derivado: strs, nao_classificados: strs, fora_do_declarado: strs })
const REV = S({ veredito: um('aprova', 'reprova'), achados: strs,
  evidencia_por_aceite: { type: 'array', items: S({ aceite: str, evidencia: str }) },
  migracao_ensaiada: bool })
const PR = S({ numero: int, url: str, ci: um('verde', 'vermelho'), detalhe: str })
const D2 = S({ ok: bool, motivos: strs })
const ENTREGA = S({ entregue: bool, migracao_aplicada: str, deploy: str, verificacao: str })
const ARQ = S({ caminho: str })

const lista = (xs) => xs.map((x) => `- ${x}`).join('\n')
const resultados = []
const registrar = (r) => {
  resultados.push(r)
  log(`${r.id}: ${r.resultado}${r.motivo ? ' — ' + r.motivo : ''}`)
}

phase('Pré-voo')
const pre = await agent('Pré-voo da rodada da fila. Siga a seção "Pré-voo" das suas instruções.',
  { agentType: 'pm-financas', schema: PRE, label: 'pré-voo', phase: 'Pré-voo' })

let parou = null
if (!pre) parou = 'o agente do pré-voo morreu'
else if (!pre.ok) parou = `pré-voo recusou: ${pre.motivo}`

let prs = 0
if (!parou) {
  phase('Itens')
  for (const c of pre.prontos) {
    if (prs >= LIMITE) { log(`limite de ${LIMITE} atingido`); break }

    // 1. PM apura
    const par = await agent(`Apure o item ${c.id} (${c.nome}). Siga a seção "Apuração de um item" das suas instruções.`,
      { agentType: 'pm-financas', schema: PARECER, label: `${c.id} · PM`, phase: 'Itens' })
    if (!par) { parou = `${c.id}: o PM morreu`; registrar({ id: c.id, resultado: 'falha', motivo: 'PM morreu' }); break }
    if (par.veredito === 'devolve') {
      registrar({ id: c.id, resultado: 'devolvido', motivo: par.motivo, achados: par.achados })
      continue
    }
    if (ENSAIO) {
      registrar({ id: c.id, resultado: 'ensaio: seguiria', motivo: par.motivo, achados: par.achados, aceite: par.aceite_interpretado })
      prs++
      continue
    }

    const devolver = (motivo, extra = {}) => registrar({ id: c.id, resultado: 'devolvido', motivo, ...extra })
    const falha = (onde, motivo, extra = {}) => {
      parou = `${c.id}: ${onde}`
      registrar({ id: c.id, resultado: 'falha', motivo: `${onde} — ${motivo}`, ...extra })
    }

    // 2. coder implementa
    const pedidoCoder = `Implemente o item ${c.id} (${c.nome}) da fila. Toca declarado: ${JSON.stringify(c.toca)}.\n` +
      `Aceite como o PM interpretou:\n${lista(par.aceite_interpretado)}\n\nApurado pelo PM:\n${par.achados}`
    let cod = await agent(pedidoCoder, { agentType: 'coder-financas', schema: CODER, label: `${c.id} · coder`, phase: 'Itens' })
    if (!cod) { falha('coder morreu', 'sem retorno'); break }
    const wt = cod.worktree
    const br = cod.branch
    if (cod.status === 'precisa_decisao') { devolver(`coder precisa de decisão: ${cod.motivo}`, { worktree: wt }); continue }
    if (cod.status === 'falhou') { falha('coder não fechou as suítes', cod.motivo, { worktree: wt }); break }

    // 3. escopo derivado do diff, em código
    const escopo = () => agent(
      `Na raiz do repositório (não na worktree), rode exatamente:\n  node tools/fila.mjs --ref origin/master toca ${c.id} origin/master ${br}\n` +
      'e devolva o JSON que ele imprimir, campo a campo, sem interpretar.',
      { schema: ESCOPO, label: `${c.id} · escopo`, phase: 'Itens', effort: 'low' })
    let esc = await escopo()
    if (!esc) { falha('conferência de escopo morreu', 'sem retorno', { worktree: wt }); break }
    if (esc.fora_do_declarado.length) {
      devolver(`tocou fora do declarado: ${esc.fora_do_declarado.join(', ')}`, { worktree: wt })
      continue
    }

    // 4. reviewer, com uma rodada de correção
    const pedidoRev = (e) => `Revise a entrega do item ${c.id} (${c.nome}) na worktree ${wt} (branch ${br}).\n` +
      `Toca derivado do diff: ${JSON.stringify(e.derivado)}. Não classificados: ${JSON.stringify(e.nao_classificados)}.\n` +
      `Aceite:\n${lista(par.aceite_interpretado)}`
    let rev = await agent(pedidoRev(esc), { agentType: 'reviewer-financas', schema: REV, label: `${c.id} · reviewer`, phase: 'Itens' })
    const dePrimeira = rev?.veredito === 'aprova'
    if (rev && rev.veredito === 'reprova') {
      cod = await agent(`${pedidoCoder}\n\nCORREÇÃO: a worktree ${wt} já existe. O reviewer reprovou com estes achados — corrija todos:\n${lista(rev.achados)}`,
        { agentType: 'coder-financas', schema: CODER, label: `${c.id} · correção`, phase: 'Itens' })
      // Esbarrar numa escolha no meio da correção é o mesmo que na primeira
      // passada: devolução ao Caio, não falha que para a rodada.
      if (cod && cod.status === 'precisa_decisao') { devolver(`coder precisa de decisão na correção: ${cod.motivo}`, { worktree: wt }); continue }
      if (!cod || cod.status !== 'pronto') { falha('correção não fechou', cod ? cod.motivo : 'coder morreu', { worktree: wt }); break }
      esc = await escopo()
      if (!esc) { falha('conferência de escopo morreu', 'sem retorno', { worktree: wt }); break }
      if (esc.fora_do_declarado.length) {
        devolver(`a correção tocou fora do declarado: ${esc.fora_do_declarado.join(', ')}`, { worktree: wt })
        continue
      }
      rev = await agent(pedidoRev(esc), { agentType: 'reviewer-financas', schema: REV, label: `${c.id} · reviewer 2`, phase: 'Itens' })
    }
    if (!rev) { falha('reviewer morreu', 'sem retorno', { worktree: wt }); break }
    if (rev.veredito !== 'aprova') { falha('reprovado duas vezes', rev.achados.join(' | '), { worktree: wt }); break }

    // 5. PR — só depois da aprovação; o coder nunca faz push
    const temMig = esc.derivado.includes('migracao')
    const titulo = `${c.id}: ${c.nome}`
    const corpo = [
      `Item **${c.id}** da fila autônoma — ${c.nome}.`,
      '',
      '## Aceite',
      ...rev.evidencia_por_aceite.map((e) => `- [x] ${e.aceite} — ${e.evidencia}`),
      '',
      `**Toca (derivado do diff):** ${esc.derivado.join(', ') || 'nada do vocabulário'}`,
      esc.nao_classificados.length ? `**Não classificados:** ${esc.nao_classificados.join(', ')}` : null,
      temMig ? `**Tem migração** — ensaiada com rollback pelo reviewer (${rev.migracao_ensaiada ? 'sim' : 'NÃO'}); aplicar só pelo "entrega a #N".` : null,
      '',
      '## Apurado pelo PM',
      par.achados,
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ].filter((l) => l !== null).join('\n')
    const pr = await agent(
      `Publique a branch ${br} como PR. Na raiz do repositório:\n` +
      `1. git push -u origin ${br}\n` +
      // Título e corpo vão por arquivo: nome de item com aspas, crase ou $
      // quebraria a linha de comando.
      `2. Grave o TÍTULO abaixo, exatamente, em .superpowers/fila/pr-${c.id}-titulo.txt e o CORPO em .superpowers/fila/pr-${c.id}.md. Rode:\n` +
      `   gh pr create --base master --head ${br} --title "$(cat .superpowers/fila/pr-${c.id}-titulo.txt)" --body-file .superpowers/fila/pr-${c.id}.md --label fila${temMig ? ' --label "tem migração"' : ''}\n` +
      '3. gh pr checks <numero> --watch --fail-fast. Se ele responder que nenhum check apareceu ainda, espere 20 s e repita, por até 5 minutos: check que ainda não apareceu não é vermelho. ' +
      'Devolva ci "verde" se todos passaram, ou "vermelho" com o check que falhou em detalhe.\n' +
      'Nunca faça merge.\n\nTÍTULO:\n' + titulo + '\n\nCORPO:\n' + corpo,
      { schema: PR, label: `${c.id} · PR`, phase: 'Itens', effort: 'low' })
    if (!pr) { falha('abrir a PR morreu', 'sem retorno', { worktree: wt }); break }
    if (pr.ci !== 'verde') { falha(`CI vermelho na #${pr.numero}`, pr.detalhe, { pr: pr.numero, url: pr.url, worktree: wt }); break }
    prs++
    const reg = { id: c.id, resultado: 'PR verde', pr: pr.numero, url: pr.url, migracao: temMig, worktree: wt }

    // 6. degrau 2: a regra é do tools/fila.mjs, não de um agente
    if (DEGRAU === 2) {
      const ctx = JSON.stringify({ degrau: 2, derivado: esc.derivado, nao_classificados: esc.nao_classificados, aprovou_de_primeira: dePrimeira })
      const d2 = await agent(`Na raiz do repositório, grave o JSON abaixo, exatamente, em .superpowers/fila/d2-${c.id}.json e rode:\n` +
        `  node tools/fila.mjs --ref origin/master degrau2 ${c.id} < .superpowers/fila/d2-${c.id}.json\n` +
        `Devolva ok e motivos exatamente como impressos.\n\nJSON:\n${ctx}`,
        { schema: D2, label: `${c.id} · degrau 2`, phase: 'Itens', effort: 'low' })
      if (d2 && d2.ok) {
        const ent = await agent(`Veio do degrau 2: entregue a PR #${pr.numero} (item ${c.id}). Siga as suas instruções.`,
          { agentType: 'entrega-financas', schema: ENTREGA, label: `${c.id} · entrega`, phase: 'Itens' })
        if (!ent || !ent.entregue) { falha('entrega do degrau 2 parou', ent ? ent.verificacao : 'agente morreu', { pr: pr.numero, url: pr.url }); break }
        reg.resultado = 'entregue (degrau 2)'
        reg.motivo = `${ent.deploy} · ${ent.verificacao}`
      } else {
        reg.degrau2 = d2 ? d2.motivos : ['a conferência do degrau 2 morreu']
      }
    }
    registrar(reg)
  }
}

phase('Relatório')
const linhas = [`# Rodada da fila — ${DATA}`, '', `Degrau ${DEGRAU} · limite ${LIMITE}${ENSAIO ? ' · **ENSAIO**' : ''}`, '']
if (parou) linhas.push(`**Parou:** ${parou}`, '')
if (pre && pre.em_pr.length) linhas.push(`**Já em PR:** ${pre.em_pr.join(', ')}`, '')
if (pre && pre.bloqueados.length) linhas.push('**Bloqueados:**', ...pre.bloqueados.map((b) => `- ${b.id}: ${b.motivo}`), '')
for (const r of resultados) {
  linhas.push(`## ${r.id} — ${r.resultado}`)
  if (r.pr) linhas.push(`PR #${r.pr} ${r.url || ''}${r.migracao ? ' · **tem migração** (entrega a #N)' : ''}`)
  if (r.degrau2) linhas.push(`Degrau 2 não se aplicou: ${r.degrau2.join('; ')}`)
  if (r.motivo) linhas.push(`**Motivo:** ${r.motivo}`)
  if (r.worktree) linhas.push(`Worktree: \`${r.worktree}\``)
  if (r.achados) linhas.push('', '**Apurado pelo PM:**', '', r.achados)
  if (r.aceite) linhas.push('', '**Aceite como seria conferido:**', lista(r.aceite))
  linhas.push('')
}
if (!resultados.length && !parou) linhas.push('Nenhum item pronto para pegar.')
const relatorio = linhas.join('\n')
const arq = await agent(
  `Grave o texto abaixo, exatamente, em .superpowers/fila/${DATA}.md (crie a pasta se faltar; se o arquivo já existir, use ${DATA}-2.md, -3 e assim por diante). Devolva o caminho.\n\n${relatorio}`,
  { schema: ARQ, label: 'relatório', phase: 'Relatório', effort: 'low' })
return { parou, prs, resultados, relatorio, arquivo: arq ? arq.caminho : null }
```

- [ ] **Step 2: Conferir que o arquivo parseia** (`package.json` tem `"type": "module"`, então `node --check` aceita `export` e `await` de topo; `args`, `agent`, `phase`, `log` são globais do Workflow e só faltariam em execução)

Run: `node --check .claude/workflows/fila.js && echo "parse ok"`
Expected: `parse ok`.

- [ ] **Step 3: Commit**

```bash
git add .claude/workflows/fila.js
git commit -F - <<'EOF'
feat(fila): workflow fila — pré-voo, PM, coder, escopo, reviewer, PR e degrau 2 com entrega

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 8: Documentação (`CLAUDE.md`, `README.md`, `BACKLOG.md`, cópia da receita)

**Files:**
- Modify: `CLAUDE.md` (nova seção antes de "## Segurança — inegociável"; e a seção "Como rodar as verificações")
- Modify: `README.md` (seção "## Executar", ao fim)
- Modify: `BACKLOG.md` (nota no topo)
- Create: `docs/superpowers/specs/2026-09-26-fila-autonoma-receita.md` (cópia de `C:\Users\caioc\Caio\receita-fila-autonoma\RECEITA.md`)

- [ ] **Step 1: Seção no `CLAUDE.md`** — inserir imediatamente antes de `## Segurança — inegociável`:

```markdown
## A fila autônoma

A fila mora em `fila/`: um `<id>.md` por item aberto (Problema, Valor, Pronto quando,
Exemplo, Fora, Decisões, Perguntas em aberto), `ORDEM.md` com as faixas
Agora/Próximo/Depois e `feitos.js` com o histórico (escrito só pelo `concluir`). Receita
completa em `docs/superpowers/specs/2026-09-26-fila-autonoma-receita.md`; plano de
implantação em `docs/superpowers/plans/2026-09-26-fila-autonoma.md`.

- **Card novo descrito na conversa** → o assistente escolhe o id, escreve `fila/<id>.md`
  a partir do que o Caio disse e do que apurar no código, faz as perguntas daquele card,
  espera, e só então passa ao próximo. Se veio do `BACKLOG.md`, a linha sai de lá.
- **"PM, revisa o planejamento"** → `Agent` `pm-financas` com esse pedido, na branch
  `planejamento`. **"fecha o planejamento"** → o mesmo; depois push da branch e **uma** PR.
- **"roda a fila"** → `Workflow` com `name: "fila"` e
  `args: {limite: 3, degrau: 2, data: "<AAAA-MM-DD de hoje>"}` (o script não tem
  relógio). **"ensaia a fila"** → o mesmo com `ensaio: true` (só pré-voo e parecer do
  PM, sem coder). Quando terminar: mostrar o relatório e mandar `PushNotification` com
  o resumo.
- **Degrau 2 é o padrão:** PR verde com `auto_merge: true`, aprovada de primeira, sem
  `migracao` e sem código fora do vocabulário é mergeada, deployada (`wrangler deploy`)
  e conferida no ar pela `entrega-financas` sem ninguém olhar. Item com migração para na
  PR verde e espera **"entrega a #N"** → `Agent` `entrega-financas` com
  `O Caio mandou: entrega a #N` (uma PR por vez; `python tools/db.py aplicar` pede
  permissão de propósito).
- Vocabulário `toca` (escopo declarado; o diff tem que caber nele): `migracao`
  (`migrations/`, `schema.sql`), `worker` (`worker/`), `app` (`public/`), `tools`
  (`tools/*.py`). Regras dos agentes (`.claude/`, `CLAUDE.md`, `tools/fila*.mjs`,
  `tools/db.py`, `tools/app.mjs`, `tools/hooks/`) nunca são neutras e nunca vão pelo
  degrau 2.
- Devolvido **não é falha**. Falha para a rodada e deixa a worktree de pé em
  `.claude/worktrees/fila-<id>`; enquanto a branch `fila/<id>` existir sem PR, o item
  fica bloqueado (de propósito: alguém tem que olhar).
- **O master só muda por PR.** Hook `tools/hooks/pre-push`; instalar uma vez por clone:
  `git config core.hooksPath tools/hooks`. Script novo em `tools/` que os papéis
  precisem rodar entra no `allow` do `.claude/settings.json` pelo nome.
- Banco sem MCP: `python tools/db.py select` (read-only), `ensaiar` (transação +
  rollback), `aplicar` (só a entrega). App no ar: `node tools/app.mjs /api/<rota>`
  (token de `.dev.vars`, só GET). Nunca `curl` com o token.
- **O repositório é público:** nada de valor real, contraparte, chave Pix ou comprovante
  em `fila/`, teste, fixture, PR ou relatório.
```

- [ ] **Step 2: Verificações no `CLAUDE.md`** — na seção "Como rodar as verificações", trocar o bloco por:

```bash
npm test                                      # Worker + app + regras da fila (globs em package.json)
python -m pytest tests/                       # import, mapeamento e tools/db.py
node tools/fila.mjs checar                    # fila/ bem formada
```

e a frase seguinte por: `O CI (.github/workflows/ci.yml) roda os três.`

- [ ] **Step 3: `README.md`** — ao fim da seção "## Executar" (antes de "## Estrutura do projeto"), acrescentar:

```markdown
### Fila autônoma

Backlog em `fila/` e rodada conduzida por agentes do Claude Code. Uma vez por clone:

```bash
git config core.hooksPath tools/hooks    # o master só muda por PR
```

Gatilhos de conversa ("roda a fila", "entrega a #N") e regras: seção "A fila autônoma"
do `CLAUDE.md`.
```

- [ ] **Step 4: `BACKLOG.md`** — logo após o primeiro parágrafo, acrescentar:

```markdown
**Desde 26/09/2026 o que vai ser feito vira card em `fila/`** (um `.md` por item, com
DoD conferível; ver `CLAUDE.md`, "A fila autônoma"). Este arquivo segue como
reservatório de ideias ainda sem card: quando um item ganha `fila/<id>.md`, a linha sai
daqui.
```

- [ ] **Step 5: Copiar a receita**

```bash
cp "C:/Users/caioc/Caio/receita-fila-autonoma/RECEITA.md" docs/superpowers/specs/2026-09-26-fila-autonoma-receita.md
```

- [ ] **Step 6: Conferir e commitar**

Run: `npm test && python -m pytest tests/ -q && node tools/fila.mjs checar`
Expected: tudo verde.

```bash
git add CLAUDE.md README.md BACKLOG.md docs/superpowers/specs/2026-09-26-fila-autonoma-receita.md docs/superpowers/plans/2026-09-26-fila-autonoma.md
git commit -F - <<'EOF'
docs: a fila autônoma — seção no CLAUDE.md, gatilhos, hook no README, receita e plano

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 9: Integração — PR, CI verde, merge, hook instalado, ensaio

**Files:** nenhum novo.

- [ ] **Step 1: Push da branch e PR**

```bash
git push -u origin fila-autonoma
gh pr create --base master --head fila-autonoma --title "Fila autônoma: PM, coder, reviewer e entrega" --body-file - <<'EOF'
Implanta no financas a receita da fila autônoma do LM Ateliê, adaptada:

- `fila/` (formato), `tools/fila.mjs` + `fila-md.mjs` + `test-fila.mjs` (regras; vocabulário `migracao|worker|app|tools`; sem vitrine)
- `tools/hooks/pre-push` (o master só muda por PR) e `.claude/settings.json`
- `tools/db.py` (select read-only, ensaio de migração com rollback, aplicar) — sem Neon MCP
- `tools/app.mjs` (GET no app com o token de `.dev.vars`)
- CI (`npm test`, `checar`, `pytest`), etiquetas `fila` e `tem migração`
- quatro agentes em `.claude/agents/` e o workflow `.claude/workflows/fila.js` (degrau 2 padrão)
- `CLAUDE.md`, `README.md`, `BACKLOG.md`, receita e plano em `docs/superpowers/`

Plano: `docs/superpowers/plans/2026-09-26-fila-autonoma.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
gh pr checks --watch --fail-fast
```

Expected: o check `testes` verde. Vermelho → corrigir na branch (os testes locais já passaram; o suspeito é `pip install -e .` ou o glob do `npm test` no Linux) e repetir.

- [ ] **Step 2: Merge e master local**

```bash
gh pr merge --merge --delete-branch
git checkout master
git fetch origin && git merge --ff-only origin/master
```

- [ ] **Step 3: Instalar o hook e provar que ele segura**

```bash
git config core.hooksPath tools/hooks
git config core.hooksPath
printf 'refs/heads/master abc refs/heads/master def\n' | sh "$(git rev-parse --show-toplevel)/tools/hooks/pre-push" origin x; echo "exit=$?"
```

Expected: `tools/hooks` na segunda linha; na terceira, `pre-push: recusado - o master so muda por PR (gh pr merge).` e `exit=1`.

- [ ] **Step 4: CI do master verde** (o pré-voo exige)

Run: `gh run list --branch master --workflow ci.yml --limit 1 --json status,conclusion`
Expected: `completed` + `success` (esperar o run do merge terminar).

- [ ] **Step 5: Ensaio com a fila vazia** — o Caio diz **"ensaia a fila"**; a sessão principal roda `Workflow({ name: "fila", args: { ensaio: true, data: "<hoje>" } })`.

Expected: pré-voo `ok:true` (conta `CaioCatenacci`, CI verde, `prontos: []`), relatório em `.superpowers/fila/<data>.md` com `Nenhum item pronto para pegar.`, e os quatro agentes listados em "Available agent types" na sessão. Se o pré-voo travar num pedido de permissão, acrescentar **a regra exata** ao `allow` do `.claude/settings.json` (PR pequena) e repetir.

- [ ] **Step 6: Atualizar a memória do assistente** (fora do repo): em `C:\Users\caioc\.claude\projects\c--Users-caioc-Caio-financas\memory\neon-mcp-financas.md`, registrar que o Neon MCP **não** está disponível nesta máquina desde 26/09/2026 e que o acesso ao banco é por `python tools/db.py` (`.dev.vars`). Criar `fila-autonoma-financas.md` (type `project`) apontando para a seção do `CLAUDE.md` e para as decisões da tabela deste plano, e indexar em `MEMORY.md`.

**Depois deste plano** (fora dele): dois ou três cards pequenos escritos com o Caio (seção 8 da receita), "PM, revisa o planejamento", "fecha o planejamento", ensaio, e a primeira rodada real com `limite: 2`.
