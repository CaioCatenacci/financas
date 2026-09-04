# Inc 3 — Bloco 3: upload de extrato/fatura no app + tela de revisão — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingerir extrato/fatura (Itaú, PDF) pelo **app web** — upload → preview/checagem na tela → aplicar — sem terminal, reusando a lógica já validada em Python.

**Architecture:** O **navegador** extrai o texto do PDF com **pdf.js** (inclui reconstrução de linhas por posição p/ a fatura de 2 colunas) e envia o TEXTO ao Worker. O Worker roda **portes JS** dos parsers/checksum/classificação/reconciliação (espelhando `tools/*.py`, com testes espelhados) e devolve um **preview**; após revisão, um segundo endpoint **aplica**. O PDF não sobe pro servidor.

**Tech Stack:** Cloudflare Workers (JS ESM), `@neondatabase/serverless`, pdf.js (CDN cdnjs), `node --test`. Modelo por id + `computa_resumo`/`linha_hash` já existentes (migração 0006, em produção).

**Spec:** `docs/superpowers/specs/2026-09-04-inc3-upload-tela-design.md`

## Global Constraints

- **Reusar, não redesenhar:** os portes JS têm que reproduzir fielmente `tools/extrato_itau.py`, `tools/fatura_itau.py`, `tools/classificar_linha.py`, `tools/reconciliar.py` (mesma lógica, mesmos casos) — os `.py` são a fonte de verdade; testes espelhados (`node --test`) fixam a paridade.
- **`linha_hash` idêntico ao Python:** sha256 hex de `"{conta}|{data}|{descricao}|{valor_cents}|{ordinal}"` — MESMA string base do `tools/reconciliar.py`, senão a dedup contra as linhas já importadas por Python não bate. Confirmar byte-a-byte.
- Dinheiro em **centavos inteiros**; agregação em SQL. Parsers/classificador/reconciliador **puros** (sem rede/DOM). Comentários/testes em **português**.
- Grava por `categoria_id`/`subcategoria_id`; `fonte='extrato'|'fatura'`; não-gasto = `computa_resumo=false` + categoria org; idempotência por `linha_hash`; ambíguos nunca aplicados sem decisão.
- **Checksum aborta:** preview com checksum que não fecha não deixa aplicar.
- Endpoints atrás do token (`tokenValido`). ES modules. `npm test` + `python -m pytest tests/` verdes antes de cada commit (o pytest não deve regredir — os `.py` ficam).
- pdf.js só do CDN **cdnjs** (`<script>` com versão pinada). O PDF é lido no browser; só o texto extraído vai ao Worker.

---

## Estrutura de arquivos

```
worker/extrato.js         NOVO — porte de tools/extrato_itau.py (parse_extrato + conferirChecksum)
worker/fatura.js          NOVO — porte de tools/fatura_itau.py (parseFatura)
worker/classificar.js     NOVO — porte de tools/classificar_linha.py (normalizarDescritor, reconhecerNaoGasto, classificar)
worker/reconciliar.js     NOVO — porte de tools/reconciliar.py (linhaHash, reconciliarLinha)
worker/importar.js        NOVO — orquestra preview/aplicar (db injetado; puro-ish)
worker/*.test.mjs         NOVO — testes espelhados dos portes + importar
worker/db.js              MOD  — transacoesNaJanela(de,ate) [linha_hash null] + hashesNaJanela(de,ate)
worker/index.js           MOD  — POST /api/importar/preview e /api/importar/aplicar
public/pdf_extrair.js     NOVO — carrega pdf.js + reconstruirTexto(itens, modo) (browser; parte pura testável)
public/index.html         MOD  — aba "Importar" + pdf.js CDN
public/app.js             MOD  — lógica da aba Importar (upload→extrai→preview→revisa→aplica)
public/app.test.mjs       MOD  — testes das funções puras da tela (montarPreview, reconstruirTexto)
```

**Nota de reconciliação (importante):** hoje `carregar_existentes`/`linha_hash` já existem em Python; os portes JS espelham. O `worker/importar.js` faz o mesmo que `tools/importar_extrato.py` main: exclui já-conciliadas, consome match no lote, idempotência por hash.

---

# FASE 1 — Backend (portes + endpoints)

## Task 1: `worker/reconciliar.js` — porte (linhaHash idêntico ao Python)

**Files:** Create `worker/reconciliar.js`, `worker/reconciliar.test.mjs`.
**Interfaces:** Produces `linhaHash(conta, data, descricao, valorCents, ordinal) -> string` (sha256 hex, MESMA base do Python); `reconciliarLinha(linha, existentes) -> {status:"casado"|"ambiguo"|"novo", matchId:string|null}` (match por `valorCents` igual e `|dias(data, e.data)| <= 3`).

- [ ] **Step 1 (RED)** — `worker/reconciliar.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linhaHash, reconciliarLinha } from "./reconciliar.js";

test("linhaHash bate byte-a-byte com o sha256 da base do Python", () => {
  const esperado = createHash("sha256").update("011638-2|2025-12-10|PIX X|19478|0").digest("hex");
  assert.equal(linhaHash("011638-2", "2025-12-10", "PIX X", 19478, 0), esperado);
});

test("linhaHash muda com o ordinal", () => {
  assert.notEqual(linhaHash("c","2025-12-10","X",100,0), linhaHash("c","2025-12-10","X",100,1));
});

test("reconciliarLinha: 1 candidato na janela ±3d → casado", () => {
  const r = reconciliarLinha({ data:"2025-12-10", valorCents:19478 },
    [{ id:"t1", data:"2025-12-11", valorCents:19478 }]);
  assert.deepEqual(r, { status:"casado", matchId:"t1" });
});

test("reconciliarLinha: >1 → ambiguo; 0/valor≠/fora da janela → novo", () => {
  assert.equal(reconciliarLinha({data:"2025-12-10",valorCents:5000},
    [{id:"a",data:"2025-12-10",valorCents:5000},{id:"b",data:"2025-12-12",valorCents:5000}]).status, "ambiguo");
  assert.equal(reconciliarLinha({data:"2025-12-10",valorCents:5000},
    [{id:"a",data:"2025-12-20",valorCents:5000},{id:"b",data:"2025-12-10",valorCents:9999}]).status, "novo");
});
```

- [ ] **Step 2** — `node --test worker/reconciliar.test.mjs` → FAIL.
- [ ] **Step 3 (GREEN)** — `worker/reconciliar.js` (porte de `tools/reconciliar.py`; use `node:crypto`):

```js
// Porte de tools/reconciliar.py. linhaHash: sha256 hex da MESMA base do Python.
import { createHash } from "node:crypto";

export function linhaHash(conta, data, descricao, valorCents, ordinal) {
  const base = `${conta}|${data}|${descricao}|${valorCents}|${ordinal}`;
  return createHash("sha256").update(base).digest("hex");
}

function dias(a, b) {
  const da = new Date(a + "T00:00:00Z"), db = new Date(b + "T00:00:00Z");
  return Math.abs((da - db) / 86400000);
}

export function reconciliarLinha(linha, existentes) {
  const cand = existentes.filter(e => e.valorCents === linha.valorCents && dias(linha.data, e.data) <= 3);
  if (cand.length === 1) return { status: "casado", matchId: cand[0].id };
  if (cand.length > 1) return { status: "ambiguo", matchId: null };
  return { status: "novo", matchId: null };
}
```

- [ ] **Step 4** — `node --test worker/reconciliar.test.mjs` e `npm test` PASS.
- [ ] **Step 5** — commit:
```bash
git add worker/reconciliar.js worker/reconciliar.test.mjs
git commit -m "feat: worker/reconciliar.js — porte JS (linhaHash idêntico ao Python + match ±3d)"
```

---

## Task 2: `worker/extrato.js` — porte do parser + checksum

**Files:** Create `worker/extrato.js`, `worker/extrato.test.mjs`.
**Interfaces:** Produces `parseExtrato(texto) -> { linhas:[{data,descricao,valorCents,natureza,ordinal}], saldos:[{data,saldoCents}] }`; `conferirChecksum(linhas, saldos) -> { ok:boolean, diferencaCents:number }`. Porte fiel de `tools/extrato_itau.py` — **incluindo** o checksum corrigido (atribui por intervalo `(prev,cur]` e descarta saldos após o último lançamento).

- [ ] **Step 1 (RED)** — `worker/extrato.test.mjs` (espelha `tests/test_extrato_itau.py`):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExtrato, conferirChecksum } from "./extrato.js";

const TXT = `10/12/2025 SALDO DO DIA 38.681,68
10/12/2025 PIX QRS MAGALUPAY10/12 -194,78
10/12/2025 PIX TRANSF CAIO CA10/12 30.000,00
09/12/2025 SALDO DO DIA 8.876,46
09/12/2025 PIX TRANSF QUINTOA09/12 0,01`;

test("ignora SALDO DO DIA e parseia linhas", () => {
  const r = parseExtrato(TXT);
  assert.equal(r.linhas.length, 3);
  assert.ok(!r.linhas.some(l => l.descricao === "SALDO DO DIA"));
});
test("sinal define natureza e cents", () => {
  const r = parseExtrato(TXT);
  const saida = r.linhas.find(l => l.descricao.includes("MAGALUPAY"));
  assert.equal(saida.valorCents, 19478); assert.equal(saida.natureza, "despesa");
  const ent = r.linhas.find(l => l.descricao.includes("CAIO CA"));
  assert.equal(ent.valorCents, 3000000); assert.equal(ent.natureza, "receita");
});
test("ordinal por dia", () => {
  const d10 = parseExtrato(TXT).linhas.filter(l => l.data === "2025-12-10");
  assert.deepEqual(d10.map(l => l.ordinal), [0, 1]);
});
test("checksum bate (atribuição por intervalo)", () => {
  const r = parseExtrato(TXT);
  assert.equal(conferirChecksum(r.linhas, r.saldos).ok, true);
});
test("checksum detecta diferença", () => {
  const r = parseExtrato(TXT); r.linhas[0].valorCents += 100;
  assert.equal(conferirChecksum(r.linhas, r.saldos).ok, false);
});
test("checksum ignora saldo após o último lançamento (data de emissão)", () => {
  const r = parseExtrato(TXT); r.saldos.push({ data: "2026-09-03", saldoCents: 4538422 });
  assert.equal(conferirChecksum(r.linhas, r.saldos).ok, true);
});
test("checksum atribui por intervalo (lançamento em dia sem SALDO DO DIA)", () => {
  const linhas = [
    { data:"2025-01-02", descricao:"A", valorCents:2000, natureza:"despesa", ordinal:0 },
    { data:"2025-01-03", descricao:"B", valorCents:1000, natureza:"despesa", ordinal:0 },
  ];
  const saldos = [{ data:"2025-01-01", saldoCents:10000 }, { data:"2025-01-03", saldoCents:7000 }];
  assert.equal(conferirChecksum(linhas, saldos).ok, true);
});
```

- [ ] **Step 2** — rodar → FAIL.
- [ ] **Step 3 (GREEN)** — `worker/extrato.js`, portando `tools/extrato_itau.py` fielmente (regex de linha `^(\d{2})/(\d{2})/(\d{4})\s+(.+?)\s+(-?[\d.]+,\d{2})$`; `_cents` BR→int; `parseExtrato` monta linhas/saldos + ordinal por data; `conferirChecksum` = versão corrigida: descarta `saldos` com `data > max(linha.data)`, ordena, e para cada par consecutivo soma os lançamentos com `de < l.data <= ate`). **Leia `tools/extrato_itau.py` e traduza 1:1** — os testes acima fixam o comportamento.

- [ ] **Step 4** — `node --test worker/extrato.test.mjs` e `npm test` PASS.
- [ ] **Step 5** — commit `feat: worker/extrato.js — porte JS (parse + checksum por intervalo)`.

---

## Task 3: `worker/fatura.js` — porte do parser da fatura

**Files:** Create `worker/fatura.js`, `worker/fatura.test.mjs`.
**Interfaces:** `parseFatura(texto, ano) -> { itens:[{data,descricao,valorCents,parcela}], totalCents }`. Porte fiel de `tools/fatura_itau.py` (**versão layout**: linha com data → valor = 1º token de dinheiro após a data; estabelecimento entre; pula subtotal/header; total; parcela `x/y`).

- [ ] **Step 1 (RED)** — `worker/fatura.test.mjs` (espelha `tests/test_fatura_itau.py`, formato layout):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFatura } from "./fatura.js";

const TXT = `                DATA       ESTABELECIMENTO                       VALOR EM R$
                29/05      PARK E CO ESTACIONAME                          17,00        Juros 10,50
                03/05      LOJA XPTO PARCELA 03/10                        150,00
                Lançamentos no cartão (final 7857)                       167,00
                Total dos lançamentos atuais                             167,00`;

test("parseia itens com ano do período; ignora subtotal/header/total", () => {
  const r = parseFatura(TXT, 2025);
  assert.equal(r.itens.length, 2);
  assert.equal(r.itens[0].data, "2025-05-29");
  assert.equal(r.itens[0].valorCents, 1700);              // 1º money após a data (não o 10,50 do juros)
});
test("captura parcela e não confunde x/y com dinheiro", () => {
  const p = parseFatura(TXT, 2025).itens.find(i => i.descricao.includes("XPTO"));
  assert.equal(p.parcela, "03/10"); assert.equal(p.valorCents, 15000);
});
test("total e checksum itens==total", () => {
  const r = parseFatura(TXT, 2025);
  assert.equal(r.totalCents, 16700);
  assert.equal(r.itens.reduce((a,i)=>a+i.valorCents,0), r.totalCents);
});
```

- [ ] **Step 2** — rodar → FAIL.
- [ ] **Step 3 (GREEN)** — `worker/fatura.js` portando `tools/fatura_itau.py` (linha começa com `DD/MM` → valor = 1º `\d{1,3}(?:\.\d{3})*,\d{2}` após a data; estab = entre; pula `Lançamentos no cartão`/header/título; total de "Total dos lançamentos atuais"; parcela `PARCELA (\d{2}/\d{2})`). **Ler o `.py` e traduzir.**
- [ ] **Step 4** — PASS. **Step 5** — commit `feat: worker/fatura.js — porte JS (parser layout)`.

---

## Task 4: `worker/classificar.js` — porte (descritor/não-gasto/associação)

**Files:** Create `worker/classificar.js`, `worker/classificar.test.mjs`.
**Interfaces:** `normalizarDescritor(descricao)->str`; `reconhecerNaoGasto(descricao)->str|null`; `classificar(descricao, associacoes)->{contraparteNome, categoriaNome|null, subNome|null, computaResumo, categoriaOrg|null}`. Usa `normalizarNome` de `worker/contraparte.js` (já existe). `associacoes` = objeto `{ chaveNormalizada: {categoriaNome, subNome} }`. **A chave é `normalizarNome(descritor)`** (paridade com o Python já corrigido).

- [ ] **Step 1 (RED)** — `worker/classificar.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizarDescritor, reconhecerNaoGasto, classificar } from "./classificar.js";
import { normalizarNome } from "./contraparte.js";

test("normalizarDescritor colapsa o mesmo estabelecimento entre meses", () => {
  assert.equal(normalizarDescritor("PIX QRS AMAZON.COM.30/12"), normalizarDescritor("PIX QRS AMAZON.COM.28/11"));
});
test("reconhece não-gasto", () => {
  assert.equal(reconhecerNaoGasto("PIX TRANSF CAIO CA10/12"), "Transferências");
  assert.equal(reconhecerNaoGasto("APLICACAO PERSONDIF INT"), "Investimentos");
  assert.equal(reconhecerNaoGasto("PIX QRS MAGALUPAY10/12"), null);
});
test("classificar não-gasto marca flag+categoria org", () => {
  const r = classificar("PIX TRANSF CAIO CA10/12", {});
  assert.equal(r.computaResumo, false); assert.equal(r.categoriaOrg, "Transferências");
});
test("classificar gasto usa associação por normalizarNome(descritor)", () => {
  const chave = normalizarNome(normalizarDescritor("PIX QRS MAGALUPAY10/12"));
  const r = classificar("PIX QRS MAGALUPAY10/12", { [chave]: { categoriaNome:"Casa", subNome:"Mercado" } });
  assert.equal(r.categoriaNome, "Casa"); assert.equal(r.subNome, "Mercado"); assert.equal(r.computaResumo, true);
});
test("gasto sem associação → categoria null", () => {
  assert.equal(classificar("PIX QRS DESCONHECIDO01/01", {}).categoriaNome, null);
});
```

- [ ] **Step 2** — FAIL. **Step 3 (GREEN)** — portar `tools/classificar_linha.py` (mesmos padrões de não-gasto; `normalizarDescritor` = remove data-sufixo/prefixos/números/pontuação, minúsculo; lookup por `normalizarNome(descritor)`). **Step 4** — PASS. **Step 5** — commit `feat: worker/classificar.js — porte JS (descritor/não-gasto/associação)`.

---

## Task 5: `worker/db.js` — consultas de apoio da importação

**Files:** Modify `worker/db.js`, `worker/db.test.mjs`.
**Interfaces:** `transacoesNaJanela(de, ate) -> [{id, data, valorCents}]` (só `linha_hash is null` — candidatas à reconciliação; `valorCents = round(valor_final*100)`); `hashesNaJanela(de, ate) -> [string]` (linha_hash não-nulos no intervalo, p/ idempotência).

- [ ] **Step 1 (RED)** — em `worker/db.test.mjs`:

```js
test("transacoesNaJanela traz só linha_hash null com valor em cents", async () => {
  const sql = fakeSql([{ id:"t1", data:"2025-12-10", valor_cents: 19478 }]);
  const db = criarDb(sql);
  const r = await db.transacoesNaJanela("2025-12-01","2025-12-31");
  assert.equal(r[0].valorCents, 19478);
  assert.match(sql.chamadas[0].text, /linha_hash is null/i);
  assert.match(sql.chamadas[0].text, /round\(valor_final\*100\)/i);
});
test("hashesNaJanela devolve os hashes não-nulos", async () => {
  const sql = fakeSql([{ linha_hash:"abc" }]);
  const db = criarDb(sql);
  const r = await db.hashesNaJanela("2025-12-01","2025-12-31");
  assert.deepEqual(r, ["abc"]);
  assert.match(sql.chamadas[0].text, /linha_hash is not null/i);
});
```

- [ ] **Step 2** — FAIL. **Step 3 (GREEN)** — adicionar em `worker/db.js`:

```js
    async transacoesNaJanela(de, ate) {
      const rows = await sql`select id, to_char(data,'YYYY-MM-DD') as data,
        (round(valor_final*100))::bigint as valor_cents
        from transacoes where data between ${de} and ${ate} and linha_hash is null`;
      return rows.map(r => ({ id: String(r.id), data: r.data, valorCents: Number(r.valor_cents) }));
    },
    async hashesNaJanela(de, ate) {
      const rows = await sql`select linha_hash from transacoes
        where data between ${de} and ${ate} and linha_hash is not null`;
      return rows.map(r => r.linha_hash);
    },
```

- [ ] **Step 4** — PASS. **Step 5** — commit `feat: db — transacoesNaJanela/hashesNaJanela (apoio à importação)`.

---

## Task 6: `worker/importar.js` — orquestração preview/aplicar

**Files:** Create `worker/importar.js`, `worker/importar.test.mjs`.
**Interfaces:**
- `montarPreviewExtrato(texto, conta, { catalogo, associacoes, existentes, hashes }) -> { checksum, itens:[{...,linhaHash,status,matchId,computaResumo,categoriaNome,subNome,categoriaOrg}], resumo:{novos,casados,naoGasto,ambiguos,jaTem} }` — **puro** (recebe os dados do banco por parâmetro). Usa extrato/classificar/reconciliar; exclui já-conciliadas (via `existentes` já filtrado por linha_hash null) e **consome** o match no lote.
- `montarPreviewFatura(texto, ano, mes, { catalogo, associacoes, hashes }) -> { checksum, itens, resumo }` — idem, itens sempre gasto, dedup por hash.
- `aplicar(db, decisao) -> { gravados, conciliados, naoGasto }` — grava a decisão revisada (novos+não-gasto via `inserirTransacao`; casados via carimbo de `linha_hash`).

- [ ] **Step 1 (RED)** — `worker/importar.test.mjs` cobrindo: checksum inválido → `resumo` sinaliza e itens não-aplicáveis; um lançamento novo vs um que casa `existentes` (status casado, não duplica); não-gasto marcado; ambíguo listado; idempotência (hash em `hashes` → jaTem). (Escrever asserts sobre o objeto retornado, com `catalogo/associacoes/existentes/hashes` fake.)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { montarPreviewExtrato } from "./importar.js";

const catalogo = { categorias:[{id:"cO",nome:"Outros"},{id:"cT",nome:"Transferências"}], subcategorias:[] };
const TXT = `10/12/2025 SALDO DO DIA 8.876,46
10/12/2025 PIX QRS LOJA X10/12 -100,00
09/12/2025 SALDO DO DIA 8.976,46`;

test("preview extrato: novo + checksum ok", () => {
  const p = montarPreviewExtrato(TXT, "c1", { catalogo, associacoes:{}, existentes:[], hashes:[] });
  assert.equal(p.checksum.ok, true);
  assert.equal(p.resumo.novos, 1);
});
test("preview extrato: casa existente (não duplica)", () => {
  const p = montarPreviewExtrato(TXT, "c1", { catalogo, associacoes:{},
    existentes:[{ id:"t9", data:"2025-12-10", valorCents:10000 }], hashes:[] });
  assert.equal(p.resumo.casados, 1); assert.equal(p.resumo.novos, 0);
  assert.equal(p.itens.find(i=>i.status==="casado").matchId, "t9");
});
```

- [ ] **Step 2** — FAIL. **Step 3 (GREEN)** — implementar `worker/importar.js` espelhando a lógica do `tools/importar_extrato.py`/`importar_fatura.py` main, mas **pura** (dados por parâmetro): parse → checksum → p/ cada linha: hash; se hash ∈ hashes → jaTem; classifica; se computaResumo, reconciliarLinha(existentes) e **remove o match de `existentes`** ao casar; monta itens+resumo. `aplicar(db, decisao)` percorre a decisão e chama `db.inserirTransacao`/carimbo. **Step 4** — PASS. **Step 5** — commit `feat: worker/importar.js — preview/aplicar (puro, dados por parâmetro)`.

---

## Task 7: `worker/index.js` — endpoints /api/importar/preview e /aplicar

**Files:** Modify `worker/index.js`, `worker/index.test.mjs`.
**Interfaces:** `POST /api/importar/preview { tipo:"extrato"|"fatura", texto, conta?, ano?, mes? }` → carrega catalogo/associacoes/existentes/hashes do db, chama `montarPreview*`, devolve o preview. `POST /api/importar/aplicar { decisao }` → `importar.aplicar(db, decisao)`. Ambos atrás de `tokenValido`.

- [ ] **Step 1 (RED)** — em `worker/index.test.mjs`, com `db` fake, um POST /api/importar/preview (tipo extrato, texto simples) devolve `{checksum, resumo}`; um /aplicar chama os inserts. (Usar `handleApi(request, env, url, dbFake)`.)
- [ ] **Step 2** — FAIL. **Step 3 (GREEN)** — em `handleApi`: rotas novas; carregar `catalogo`, associacoes (via um `db.associacoesPorNome()` — se não existir, reusar a consulta do preview montando o objeto), `transacoesNaJanela`/`hashesNaJanela` no intervalo do texto (min/max das datas parseadas). Chamar `montarPreview*` / `aplicar`. **Step 4** — PASS (`npm test`). **Step 5** — commit `feat: /api/importar/preview + /aplicar`.

> Nota: se precisar de `db.associacoesPorNome()` (dict chaveNormalizada→{categoriaNome,subNome}), adicionar em `worker/db.js` nesta task (espelha o `carregar_associacoes` do Python) com teste.

---

# FASE 2 — Frontend (pdf.js + tela)

## Task 8: `public/pdf_extrair.js` — pdf.js + reconstrução de linhas (spike-verificado)

**Files:** Create `public/pdf_extrair.js`, add to `public/app.test.mjs`.
**Interfaces:** `reconstruirTexto(itens, modo) -> string` (**puro**, testável): `itens` = `[{str, x, y}]` (o que o pdf.js `getTextContent` dá, normalizado); agrupa por linha (mesma `y`, tolerância), ordena por `x`, e — no `modo="layout"` (fatura) — insere espaçamento proporcional ao gap de `x` p/ manter colunas; no `modo="simples"` (extrato) junta por espaço. E `extrairTextoPDF(arrayBuffer, modo) -> Promise<string>` (carrega pdf.js do CDN, itera páginas, chama reconstruirTexto).

- [ ] **Step 1 — SPIKE (de-risco, controller/dev):** rodar pdf.js (build node `pdfjs-dist/legacy`) sobre os PDFs reais (extrato e **fatura**) e conferir que `reconstruirTexto` produz linhas que `parseExtrato`/`parseFatura` aceitam (esp. a fatura: `29/05  PARK...  17,00` numa linha). Se o gap-espaçamento não bastar, ajustar a heurística. **Saída:** confirmação de viabilidade + fixtures de `itens` capturadas dos PDFs reais p/ os testes.
- [ ] **Step 2 (RED)** — `public/app.test.mjs`: `reconstruirTexto` com uma fixture sintética de `itens` de 2 colunas devolve a linha com a data, estabelecimento e valor na ordem certa (e o valor antes do ruído da direita). E o modo simples junta "DD/MM/AAAA desc valor".
- [ ] **Step 3 (GREEN)** — implementar `reconstruirTexto` (puro) + `extrairTextoPDF` (usa `window.pdfjsLib` do CDN). **Step 4** — `node --test public/app.test.mjs` PASS. **Step 5** — commit `feat: pdf_extrair.js — pdf.js + reconstrução de linhas (extrato simples / fatura layout)`.

---

## Task 9: `public/` — aba "Importar" (upload → preview → revisão → aplicar)

**Files:** Modify `public/index.html`, `public/app.js`, `public/shell.css`, `public/app.test.mjs`.
**Interfaces:** função pura `resumoTexto(preview) -> string` (rótulo das contagens) testável; UI: aba Importar, `<input type=file>`, selects tipo/conta/ano/mês, botão "Pré-visualizar" → `extrairTextoPDF` → `POST /api/importar/preview` → render dos grupos (novos/casados/não-gasto/ambíguos/checksum) + resolver ambíguos (aceitar sugestão / marcar novo) → botão "Aplicar" (habilitado só se checksum ok) → `POST /api/importar/aplicar`.

- [ ] **Step 1 (RED)** — `public/app.test.mjs`: `resumoTexto` formata as contagens; e um teste de que "Aplicar" fica desabilitado quando `preview.checksum.ok===false` (função pura `podeAplicar(preview)`).
- [ ] **Step 2** — FAIL. **Step 3 (GREEN)** — `index.html`: `<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/<versão>/pdf.min.js">` + aba/section Importar; `app.js`: fluxo acima (reusa `apiGet`/novo `apiPost`); `shell.css`: estilo dos grupos. Verificação visual (controller, harness com mock dos endpoints). **Step 4** — `npm test` PASS. **Step 5** — commit `feat: app — aba Importar (upload + preview + revisão + aplicar)`.

---

## Checkpoint de infra

Sem migração nova (0006 já em produção). Após Fase 1: `npm test`+`pytest` verdes → **deploy** (endpoints novos). Após Fase 2: deploy do app → **smoke ao vivo**: subir o extrato e a fatura reais pela tela, conferir que o preview bate com o que o CLI deu (mesmos números) e aplicar num período controlado. A paridade JS↔Python é a rede; o smoke confirma o pdf.js.

---

## Self-Review

- **Cobertura da spec:** §3 pdf.js no browser + parse no worker (T8,T1-T7) ✓; §4 fluxo upload→preview→revisão→aplicar (T7,T9) ✓; §5 portes + endpoints + db helpers (T1-T7) ✓; reuso/paridade com Python (testes espelhados) ✓; checksum aborta (T2,T6,T9) ✓; não-gasto/idempotência/ambíguos (T6) ✓; `linha_hash` idêntico (T1) ✓; token nos endpoints (T7) ✓.
- **Placeholders:** os portes (T2,T3,T4) apontam o `.py` fonte + trazem os testes espelhados como contrato (não é placeholder — é "traduza este arquivo até estes testes passarem"); T1/T5/T6/T7 trazem código real.
- **Consistência de tipos:** camelCase no JS (`valorCents`, `linhaHash`, `computaResumo`, `categoriaNome`) — nomes usados igual em T1-T9. `montarPreview*`/`aplicar` (T6) consumidos por T7; `reconstruirTexto`/`extrairTextoPDF` (T8) por T9.
- **Notas:** T5/T7 tocam `worker/db.js`+`worker/index.js` (mesmos arquivos entre si em T7) — série. T8 tem um **spike** inicial (viabilidade do pdf.js) — se falhar, reavaliar a reconstrução antes de T9. O smoke ao vivo é a validação final (pdf.js real).
