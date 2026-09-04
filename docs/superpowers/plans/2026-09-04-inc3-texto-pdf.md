# Inc 3 — Bloco 1: lançamento por texto + PDF de comprovante — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aceitar no bot do Telegram (a) lançamento por **texto estruturado** e (b) **PDF de comprovante único**, virando 1 transação cada, reusando o modelo por id (Inc 2.5).

**Architecture:** Texto = parser **determinístico puro** (`worker/texto.js`), sem IA; resolve categoria/pessoa por nome → id no `index.js`. PDF = mesma máquina da imagem (`extrair.js` passa a aceitar `application/pdf`; Claude usa bloco `document`, Gemini usa `inline_data`). `parseUpdate` passa a carregar o texto e o fileId do PDF.

**Tech Stack:** Cloudflare Workers (JS ESM), `node --test` (auto-discovery), Neon (`@neondatabase/serverless`), Gemini + Claude (vision/PDF).

**Spec:** `docs/superpowers/specs/2026-09-03-inc3-texto-pdf-design.md`

## Global Constraints

- Dinheiro em **centavos inteiros**; `parseBRtoCents` (BR: vírgula decimal, ponto milhar) p/ string→cents; agregação em SQL. Nada de float acumulado.
- `extrair.js`/`money.js`/`texto.js` são **puros**: sem banco/rede/I/O; tudo entra por parâmetro.
- Comentários e testes **em português**, explicando o *porquê*.
- Vocabulário fixo inalterado: `fonte ∈ {imagem,manual,extrato,fatura,importacao}`; `origem_categoria ∈ {modelo,manual,regra}`; `natureza ∈ {despesa,receita}`.
- Texto: `fonte='manual'`, `origem_categoria='manual'`. PDF de comprovante: `fonte='imagem'`.
- Modelo por id (Inc 2.5): grava `categoria_id`/`subcategoria_id`; nomes→id via `resolverCategoria` (fallback `Outros`). Nunca reintroduzir colunas string macro/sub.
- ES modules. `npm test` verde antes de cada commit.

---

## Estrutura de arquivos

```
worker/texto.js            NOVO — parseLancamentoTexto (puro) + helpers de data
worker/texto.test.mjs      NOVO — testes do parser
worker/telegram.js         MOD  — parseUpdate carrega texto (branch texto) e fileId/mime (branch pdf)
worker/db.js               MOD  — pessoaPorNome(nome)
worker/db.test.mjs         MOD  — teste de pessoaPorNome
worker/extrair.js          MOD  — aceitar application/pdf (PROMPT + bloco Claude document/image)
worker/extrair.test.mjs    MOD  — teste do seletor de bloco (image vs document)
worker/index.js            MOD  — branch texto (parse→resolve→insert→confirma) e branch pdf (reusa imagem)
worker/index.test.mjs      MOD  — testes dos dois branches
worker/dropbox_nome.js     (já aceita ext; usar 'pdf')
```

---

## Task 1: `worker/texto.js` — parser determinístico do lançamento por texto

**Files:**
- Create: `worker/texto.js`
- Test: `worker/texto.test.mjs`

**Interfaces:**
- Consumes: `parseBRtoCents` de `worker/money.js`.
- Produces: `parseLancamentoTexto(texto) -> { ok:true, dados } | { ok:false, erro }` onde
  `dados = { valorCents:int, dataISO:"AAAA-MM-DD", descricao:string, natureza:"despesa"|"receita",
  pessoa:string|null, categoria:string|null, subcategoria:string|null }`.

- [ ] **Step 1: Write the failing test** — `worker/texto.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLancamentoTexto } from "./texto.js";

test("parse básico: descrição + valor + data (ordem livre)", () => {
  const r = parseLancamentoTexto("padaria 57,50 29/03/2026");
  assert.equal(r.ok, true);
  assert.equal(r.dados.valorCents, 5750);
  assert.equal(r.dados.dataISO, "2026-03-29");
  assert.equal(r.dados.descricao, "padaria");
  assert.equal(r.dados.natureza, "despesa");
  assert.equal(r.dados.categoria, null);
});

test("ordem trocada e descrição com várias palavras", () => {
  const r = parseLancamentoTexto("57,50 conta de luz 29/03/2026");
  assert.equal(r.dados.descricao, "conta de luz");
  assert.equal(r.dados.valorCents, 5750);
});

test("data dd/mm usa o ano atual", () => {
  const ano = new Date().getUTCFullYear();
  const r = parseLancamentoTexto("padaria 10,00 05/01");
  assert.equal(r.dados.dataISO, `${ano}-01-05`);
});

test("pares chave=valor, com nome de categoria com espaço", () => {
  const r = parseLancamentoTexto("consulta 200,00 02/02/2026 categoria=Plano de saúde pessoa=Caio subcategoria=Amil");
  assert.equal(r.dados.categoria, "Plano de saúde");
  assert.equal(r.dados.pessoa, "Caio");
  assert.equal(r.dados.subcategoria, "Amil");
  assert.equal(r.dados.descricao, "consulta");
});

test("natureza=receita", () => {
  const r = parseLancamentoTexto("salário 5000,00 05/03/2026 natureza=receita");
  assert.equal(r.dados.natureza, "receita");
});

test("valor com milhar e centavos", () => {
  const r = parseLancamentoTexto("aluguel 1.234,56 10/03/2026");
  assert.equal(r.dados.valorCents, 123456);
});

test("faltando valor → ok:false", () => {
  const r = parseLancamentoTexto("padaria 29/03/2026");
  assert.equal(r.ok, false);
  assert.match(r.erro, /valor|obrigat/i);
});

test("faltando data → ok:false", () => {
  assert.equal(parseLancamentoTexto("padaria 57,50").ok, false);
});

test("faltando descrição → ok:false", () => {
  assert.equal(parseLancamentoTexto("57,50 29/03/2026").ok, false);
});

test("texto vazio → ok:false", () => {
  assert.equal(parseLancamentoTexto("").ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test worker/texto.test.mjs`
Expected: FAIL (`parseLancamentoTexto` não existe).

- [ ] **Step 3: Write minimal implementation** — `worker/texto.js`:

```js
// Inc 3: parser determinístico do lançamento por texto. Puro (sem rede/banco/IA).
// Formato: <descrição> <valor> <data> [pessoa=] [categoria=] [subcategoria=] [natureza=]
// Obrigatórios: descrição, valor, data. Opcionais: os pares chave=valor.
import { parseBRtoCents } from "./money.js";

const CHAVES = ["pessoa", "categoria", "subcategoria", "natureza"];
const reData = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/;

const pad = (n) => String(n).padStart(2, "0");

// token de data dd/mm[/aaaa] → ISO; ano omitido = ano atual; aaaa de 2 dígitos → 20aa.
function parseData(tok) {
  const m = tok.match(reData);
  if (!m) return null;
  const dd = +m[1], mm = +m[2];
  let yyyy = m[3] ? +m[3] : new Date().getUTCFullYear();
  if (m[3] && m[3].length === 2) yyyy = 2000 + yyyy;
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  return `${yyyy}-${pad(mm)}-${pad(dd)}`;
}

export function parseLancamentoTexto(texto) {
  const t = String(texto ?? "").trim();
  if (!t) return { ok: false, erro: "texto vazio" };

  // 1) separa a parte livre dos pares chave=valor (1ª chave conhecida marca o corte)
  const reCorte = new RegExp(`(?:^|\\s)(?:${CHAVES.join("|")})\\s*=`, "i");
  const corte = t.search(reCorte);
  const livre = (corte >= 0 ? t.slice(0, corte) : t).trim();
  const paresStr = corte >= 0 ? t.slice(corte) : "";

  // 2) pares: cada valor vai até o próximo chave= conhecido (permite espaço no valor)
  const pares = {};
  if (paresStr) {
    const re = new RegExp(`(${CHAVES.join("|")})\\s*=\\s*(.*?)(?=\\s+(?:${CHAVES.join("|")})\\s*=|$)`, "gi");
    let m;
    while ((m = re.exec(paresStr))) pares[m[1].toLowerCase()] = m[2].trim();
  }

  // 3) parte livre → data (por forma), valor (formato BR), descrição (o resto)
  const tokens = livre.split(/\s+/).filter(Boolean);
  let dataISO = null;
  const semData = [];
  for (const tok of tokens) {
    if (dataISO === null && reData.test(tok)) { const d = parseData(tok); if (d) { dataISO = d; continue; } }
    semData.push(tok);
  }
  // valor: prefere token com centavos (vírgula); senão inteiro puro
  let valorCents = null, idxValor = -1;
  for (let i = 0; i < semData.length; i++) {
    if (/,\d{2}$/.test(semData[i])) { const c = parseBRtoCents(semData[i]); if (c !== null) { valorCents = c; idxValor = i; break; } }
  }
  if (valorCents === null) {
    for (let i = 0; i < semData.length; i++) {
      if (/^\d+$/.test(semData[i])) { valorCents = parseBRtoCents(semData[i]); idxValor = i; break; }
    }
  }
  const descricao = semData.filter((_, i) => i !== idxValor).join(" ").trim();

  if (!descricao || valorCents === null || dataISO === null)
    return { ok: false, erro: "faltam obrigatórios (descrição, valor e data)" };

  const natureza = (pares.natureza || "").toLowerCase() === "receita" ? "receita" : "despesa";
  return { ok: true, dados: {
    valorCents, dataISO, descricao, natureza,
    pessoa: pares.pessoa || null, categoria: pares.categoria || null, subcategoria: pares.subcategoria || null,
  } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test worker/texto.test.mjs`
Expected: PASS (10 testes).

- [ ] **Step 5: Commit**

```bash
git add worker/texto.js worker/texto.test.mjs
git commit -m "feat: texto.js — parseLancamentoTexto (parser determinístico do lançamento por texto)"
```

---

## Task 2: `worker/db.js` — `pessoaPorNome`

**Files:**
- Modify: `worker/db.js` (adicionar método ao objeto de `criarDb`, junto de `listarPessoas`)
- Test: `worker/db.test.mjs`

**Interfaces:**
- Produces: `pessoaPorNome(nome) -> { id, nome } | null` (case-insensitive, só ativas).

- [ ] **Step 1: Write the failing test** — adicionar em `worker/db.test.mjs`:

```js
test("pessoaPorNome casa nome case-insensitive só entre ativas", async () => {
  const sql = fakeSql([{ id: "p1", nome: "Caio" }]);
  const db = criarDb(sql);
  const r = await db.pessoaPorNome("caio");
  assert.equal(r.id, "p1");
  assert.match(sql.chamadas[0].text, /from pessoas/i);
  assert.match(sql.chamadas[0].text, /where ativa/i);
  assert.match(sql.chamadas[0].text, /lower\(nome\)\s*=\s*lower/i);
  assert.deepEqual(sql.chamadas[0].values, ["caio"]);
});

test("pessoaPorNome retorna null quando não acha", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  assert.equal(await db.pessoaPorNome("Xuxa"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test worker/db.test.mjs`
Expected: FAIL (`db.pessoaPorNome is not a function`).

- [ ] **Step 3: Write minimal implementation** — em `worker/db.js`, logo após `listarPessoas`:

```js
    async pessoaPorNome(nome) {
      const rows = await sql`select id, nome from pessoas where ativa and lower(nome) = lower(${nome}) limit 1`;
      return rows[0] ?? null;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test worker/db.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/db.js worker/db.test.mjs
git commit -m "feat: db.pessoaPorNome (lookup case-insensitive p/ lançamento por texto)"
```

---

## Task 3: `worker/telegram.js` + `worker/index.js` — branch de texto

**Files:**
- Modify: `worker/telegram.js:19` (parseUpdate carrega o texto)
- Modify: `worker/index.js` (branch `ev.tipo === "texto"`; import de `parseLancamentoTexto`)
- Test: `worker/index.test.mjs`

**Interfaces:**
- Consumes: `parseLancamentoTexto` (Task 1), `db.pessoaPorNome` (Task 2), `resolverCategoria`/`nomesDeCategoria` (Inc 2.5), `db.catalogo`, `db.inserirTransacao`.
- Produces: transação com `fonte='manual'`, `origem_categoria='manual'`, `categoria_id`/`subcategoria_id`/`pessoa_id` resolvidos.

- [ ] **Step 1: Write the failing test** — adicionar em `worker/index.test.mjs` (usa o `dbFake` existente, que já tem `catalogo`):

```js
test("texto estruturado vira transação manual, resolvendo categoria e pessoa", async () => {
  const enviados = [];
  const db = dbFake();
  db.pessoaPorNome = async (n) => (n.toLowerCase() === "casa" ? { id: "p2", nome: "Casa" } : null);
  const deps = {
    db,
    confirmar: async (chat, texto, id) => enviados.push(texto),
    responderImpl: async () => {},
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "padaria 57,50 29/03/2026 categoria=Casa pessoa=Casa" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  const ins = db.estado.inseridos[0];
  assert.equal(ins.fonte, "manual");
  assert.equal(ins.origem_categoria, "manual");
  assert.equal(ins.categoria_id, "cCasa");   // resolvido do catálogo do dbFake
  assert.equal(ins.pessoa_id, "p2");
  assert.equal(ins.valorCents, 5750);
  assert.ok(enviados.some((t) => /57,50/.test(t)));
});

test("texto sem categoria cai em Outros e avisa pessoa inexistente", async () => {
  const enviados = [];
  const db = dbFake();
  db.pessoaPorNome = async () => null; // ninguém casa
  const deps = { db, confirmar: async (c, t) => enviados.push(t), responderImpl: async () => {} };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "mercado 30,00 01/03/2026 pessoa=Xuxa" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  const ins = db.estado.inseridos[0];
  assert.equal(ins.categoria_id, "cOut");    // Outros (fallback do resolverCategoria)
  assert.equal(ins.pessoa_id, null);
  assert.ok(enviados.some((t) => /Xuxa/.test(t)));  // avisou o não-encontrado
});

test("texto inválido responde com o formato e não grava", async () => {
  const respostas = [];
  const db = dbFake();
  const deps = { db, confirmar: async () => {}, responderImpl: async (c, t) => respostas.push(t) };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "só uma descrição sem valor nem data" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.estado.inseridos.length, 0);
  assert.ok(respostas.some((t) => /ex\.:/i.test(t)));
});
```

> Nota: o `dbFake` do arquivo já expõe `catalogo()` com `cCasa`/`cEdu`/`cOut` e subs `sLimp`/`sIng`.
> O branch de texto deve usar `resolverCategoria` (fallback `Outros` = `cOut`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test worker/index.test.mjs`
Expected: FAIL (branch de texto ainda é o stub "em breve"; nada é inserido).

- [ ] **Step 3a: `worker/telegram.js`** — o branch de texto passa a carregar o texto:

Trocar a linha `if (m.text) return { tipo: "texto", chatId };` por:

```js
  if (m.text) return { tipo: "texto", chatId, texto: m.text, messageId: m.message_id };
```

- [ ] **Step 3b: `worker/index.js`** — import (junto dos outros de categorias.js):

```js
import { resolverCategoria, catalogoParaLista, nomesDeCategoria } from "./categorias.js";
```
(`resolverCategoria`/`nomesDeCategoria` já são usados; garantir que estão no import.)

- [ ] **Step 3c: `worker/index.js`** — trocar o stub de texto. Localizar:

```js
  if (ev.tipo === "texto") { await deps.responderImpl(ev.chatId, "Lançamento por texto vem logo. Por enquanto, mande a foto do comprovante.", env); return; }
```
e substituir por:

```js
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
```

- [ ] **Step 3d: `worker/index.js`** — adicionar o import no topo:

```js
import { parseLancamentoTexto } from "./texto.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test worker/index.test.mjs` (e depois `npm test`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/telegram.js worker/index.js worker/index.test.mjs
git commit -m "feat: lançamento por texto no Telegram (parse determinístico + resolve categoria/pessoa)"
```

---

## Task 4: `worker/extrair.js` — aceitar `application/pdf`

**Files:**
- Modify: `worker/extrair.js` (PROMPT genérico + seletor de bloco do Claude)
- Test: `worker/extrair.test.mjs`

**Interfaces:**
- Produces: `blocoConteudoClaude(mime, dataB64) -> objeto de content block` (puro) — `document` p/ `application/pdf`, `image` p/ o resto. `callClaudeHTTP` passa a usá-lo. `callGeminiHTTP` não muda (o `inline_data` já aceita o mime do PDF).

- [ ] **Step 1: Write the failing test** — adicionar em `worker/extrair.test.mjs`:

```js
import { blocoConteudoClaude } from "./extrair.js";

test("blocoConteudoClaude: imagem usa bloco image", () => {
  const b = blocoConteudoClaude("image/jpeg", "AAAA");
  assert.equal(b.type, "image");
  assert.equal(b.source.media_type, "image/jpeg");
  assert.equal(b.source.data, "AAAA");
});

test("blocoConteudoClaude: pdf usa bloco document", () => {
  const b = blocoConteudoClaude("application/pdf", "AAAA");
  assert.equal(b.type, "document");
  assert.equal(b.source.type, "base64");
  assert.equal(b.source.media_type, "application/pdf");
  assert.equal(b.source.data, "AAAA");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test worker/extrair.test.mjs`
Expected: FAIL (`blocoConteudoClaude` não exportado).

- [ ] **Step 3a:** em `worker/extrair.js`, generalizar o PROMPT (linha 8): trocar
`"Você lê um comprovante de pagamento (pix/transferência) em imagem."` por
`"Você lê um comprovante de pagamento (pix/transferência) em imagem ou PDF."`

- [ ] **Step 3b:** adicionar o helper puro (perto dos adaptadores HTTP):

```js
// Claude usa bloco `document` p/ PDF e `image` p/ imagem (o Gemini aceita o mime direto no inline_data).
export function blocoConteudoClaude(mime, dataB64) {
  if (mime === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: mime, data: dataB64 } };
  }
  return { type: "image", source: { type: "base64", media_type: mime, data: dataB64 } };
}
```

- [ ] **Step 3c:** em `callClaudeHTTP`, trocar o bloco de imagem hardcoded pelo helper. Localizar:

```js
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime, data: b64(bytes) } },
        { type: "text", text: PROMPT(categorias) + "\nResponda só o JSON." },
      ] }],
```
e trocar a 1ª entrada do `content` por `blocoConteudoClaude(mime, b64(bytes))`:

```js
      messages: [{ role: "user", content: [
        blocoConteudoClaude(mime, b64(bytes)),
        { type: "text", text: PROMPT(categorias) + "\nResponda só o JSON." },
      ] }],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test worker/extrair.test.mjs` (e `npm test`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/extrair.js worker/extrair.test.mjs
git commit -m "feat: extrair.js aceita application/pdf (Claude document block; Gemini inline_data)"
```

---

## Task 5: `worker/telegram.js` + `worker/index.js` — branch de PDF de comprovante

**Files:**
- Modify: `worker/telegram.js:16` (parseUpdate do pdf carrega fileId/mime/caption)
- Modify: `worker/index.js` (branch `ev.tipo === "pdf"` reusa o fluxo de imagem)
- Test: `worker/index.test.mjs`

**Interfaces:**
- Consumes: `deps.baixar`, `deps.hashBytes`, `deps.db.documentoPorHash`, `deps.db.catalogo`, `deps.extrairImpl`, `resolverCategoria`, `deps.subir`, `deps.db.inserirDocumento`, `deps.db.inserirTransacao`, `nomeArquivo`/`caminhoDropbox`.
- Produces: transação `fonte='imagem'` a partir de um PDF de comprovante; arquivo no Dropbox com `ext='pdf'`.

- [ ] **Step 1: Write the failing test** — adicionar em `worker/index.test.mjs`:

```js
test("PDF de comprovante vira transação (reusa fluxo de imagem, fonte=imagem)", async () => {
  const enviados = [];
  const db = dbFake();
  const subidos = [];
  const deps = {
    db,
    baixar: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "application/pdf" }),
    hashBytes: async () => "hpdf",
    extrairImpl: async (bytes, mime) => {
      assert.equal(mime, "application/pdf");   // o mime do PDF chega ao extrator
      return { ok: true, extraido_por: "gemini", confianca: 0.9,
        normalizado: { dataISO: "2026-03-29", valorCents: 4200, natureza: "despesa",
          macro: "Casa", sub: "Limpeza", descricao: "Recibo", contraparte_nome: null, contraparte_chave: null } };
    },
    subir: async (e, caminho) => { subidos.push(caminho); return caminho; },
    confirmar: async (chat, texto, id) => enviados.push(texto),
    responderImpl: async () => {},
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, document: { file_id: "fpdf", mime_type: "application/pdf" } } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  const ins = db.estado.inseridos[0];
  assert.equal(ins.fonte, "imagem");
  assert.equal(ins.categoria_id, "cCasa");
  assert.equal(ins.subcategoria_id, "sLimp");
  assert.ok(subidos[0].endsWith(".pdf"));       // arquivo salvo como .pdf
  assert.ok(enviados.length === 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test worker/index.test.mjs`
Expected: FAIL (branch pdf ainda é stub; nada inserido).

- [ ] **Step 3a: `worker/telegram.js`** — trocar `if (mime === "application/pdf") return { tipo: "pdf", chatId };` por:

```js
    if (mime === "application/pdf") return { tipo: "pdf", chatId, fileId: m.document.file_id, mime, messageId: m.message_id, caption: m.caption || null };
```

- [ ] **Step 3b: `worker/index.js`** — trocar o stub de pdf. Localizar:

```js
  if (ev.tipo === "pdf") { await deps.responderImpl(ev.chatId, "PDF de extrato/fatura é do próximo incremento — por ora, mande foto de comprovante.", env); return; }
```
e substituir por um fluxo que reusa a imagem. Como o corpo do fluxo de imagem é grande, extrair a parte comum não é objetivo desta task; então o branch pdf replica o fluxo de captura (é o mesmo do `ev.tipo === "imagem"`, trocando só o `ext`):

```js
  if (ev.tipo === "imagem" || ev.tipo === "pdf") {
    const { bytes, mime } = await deps.baixar(ev.fileId);
    const ehPdf = ev.tipo === "pdf";
    // (o restante do fluxo de captura já existente segue aqui — ver Step 3c)
    ...
    const ext = ehPdf ? "pdf" : (mime === "image/png" ? "png" : "jpg");
    ...
  }
```

> **Implementação concreta:** hoje o fluxo de captura vive sob `if (ev.tipo !== "imagem") return;` seguido do corpo. Ajustar assim:
> 1. **Remover** a linha stub do pdf (a de "PDF de extrato/fatura...").
> 2. Trocar `if (ev.tipo !== "imagem") return;` por `if (ev.tipo !== "imagem" && ev.tipo !== "pdf") return;`.
> 3. Na linha `const ext = mime === "image/png" ? "png" : "jpg";` trocar por:
>    `const ext = ev.tipo === "pdf" ? "pdf" : (mime === "image/png" ? "png" : "jpg");`
>
> O resto do corpo (dedup, catalogo, extrairImpl, resolverCategoria, regra por contraparte, subir, inserir) **não muda** — o `mime` vindo de `deps.baixar` já é `application/pdf` e chega ao `extrairImpl`. O modo ensino (`/aprender`) continua valendo só p/ imagem porque PDF não traz `caption` de ensino no fluxo típico; se quiser ensino por PDF depois, é outro incremento.

- [ ] **Step 3c:** garantir que o branch de ensino (`parseAprender(ev.caption)`) não quebre com pdf: como `ev.caption` de pdf pode ser `null`, `parseAprender(null)` já retorna null (sem match) — sem mudança necessária. Confirmar lendo `worker/teach.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test worker/index.test.mjs` (e `npm test` + `python -m pytest tests/`)
Expected: PASS. Todos os testes existentes de imagem seguem verdes (o corpo é o mesmo).

- [ ] **Step 5: Commit**

```bash
git add worker/telegram.js worker/index.js worker/index.test.mjs
git commit -m "feat: PDF de comprovante único vira transação (reusa fluxo de imagem, ext=pdf)"
```

---

## Checkpoint de infra (controller)

Após as 5 tasks: `npm test` + `python -m pytest tests/` verdes → **deploy** (`npx wrangler deploy`) → **spike ao vivo do PDF** (controller): mandar 1 PDF de recibo real pelo Telegram e conferir que virou transação. Se **Gemini ou Claude recusar o PDF** (erro 4xx no log), acrescentar fallback: converter a 1ª página do PDF em imagem antes de chamar aquele provedor (decidir a lib no momento; registrar no ledger). Testar também 1 lançamento por texto real (`padaria 57,50 …`).

---

## Self-Review

- **Cobertura da spec:** texto estruturado (Task 1) ✓; parser determinístico sem IA (Task 1) ✓; `chave=valor` com nome com espaço (Task 1) ✓; obrigatórios/erro (Task 1) ✓; `pessoaPorNome` (Task 2) ✓; branch texto resolve categoria/pessoa + fonte='manual'/origem='manual' + avisos (Task 3) ✓; parseUpdate carrega texto (Task 3) e pdf fileId (Task 5) ✓; PDF aceito no extrator (Task 4) ✓; branch pdf reusa imagem com fonte='imagem'/ext=pdf (Task 5) ✓; spike de viabilidade + fallback (checkpoint) ✓; vocabulário fixo inalterado ✓.
- **Sem placeholders:** todos os steps têm código real.
- **Consistência de tipos:** `parseLancamentoTexto` retorna `{ok, dados}`/`{ok, erro}` — usado assim no index (Task 3). `blocoConteudoClaude(mime, dataB64)` — usado em `callClaudeHTTP` (Task 4). `pessoaPorNome` → `{id,nome}|null` — usado no index (Task 3). `resolverCategoria(macroNome, subNome, catalogo)` — assinatura do Inc 2.5.
- **Nota:** Tasks 3 e 5 tocam `index.js`+`telegram.js`+`index.test.mjs` (mesmos arquivos) — executar em série (nunca em paralelo).
