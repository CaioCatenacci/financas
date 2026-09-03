# Classificador que aprende (Incremento 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capturar a contraparte (destinatário) de cada comprovante e aprender com as correções do Caio, de modo que capturas futuras da mesma contraparte sejam auto-classificadas na categoria certa.

**Architecture:** A extração passa a devolver `contraparte`/`contraparte_chave`. Uma tabela `associacoes` guarda `(chave → macro/sub)`, alimentada quando o Caio corrige a categoria no app (dentro do `atualizarTransacao`). Na captura, antes de gravar, busca-se a associação (chave Pix/CPF primeiro, nome depois) e, se houver, aplica-se a categoria aprendida (`origem_categoria='regra'`). O front ganha descrição editável, subcategoria combobox aninhada à categoria, rótulo "Categoria" e tabela redimensionada.

**Tech Stack:** Cloudflare Workers (JS ESM), `@neondatabase/serverless`, Neon Postgres, Gemini/Claude (visão), HTML+JS vanilla. Testes: `node --test` (worker+app), `pytest` (import, inalterado).

**Spec:** `docs/superpowers/specs/2026-09-03-classificador-aprende-design.md`

## Global Constraints

- Repo `C:\Users\caioc\Caio\financas`; branch novo `inc2-classificador` (não trabalhar no master direto).
- Dinheiro em centavos/`numeric`; agregação em SQL. ES modules. Comentários/testes em português explicando o *porquê*.
- Vocabulário fixo: `origem_categoria ∈ {modelo, manual, regra}` (novo: `regra`). `natureza ∈ {despesa,receita}`; `esfera ∈ {pessoal,empresa}`.
- **Rótulo UI:** "Categoria"/"Subcategoria"; **colunas do banco continuam `macro`/`sub`** (não renomear coluna).
- `npm test` = `node --test` (auto-discovery). Testes novos `*.test.mjs`. Rodar a suíte antes de cada commit.
- Chave de aprendizado: **pix/cpf quando houver, senão nome normalizado**. Aplicação: **auto-aplica**.
- Segredos nunca no código. Migração aplicada no Neon no checkpoint de infra (mesmo padrão do Inc 1).

## Estrutura de arquivos

```
migrations/0002_associacoes.sql   NOVO — colunas contraparte + tabela associacoes + check origem
schema.sql                        MOD  — reflete o 0002 (referência legível)
worker/contraparte.js             NOVO — normalizarChave, normalizarNome, derivarChave (puro)
worker/contraparte.test.mjs       NOVO
worker/validar.js                 MOD  — normalizado carrega contraparte_nome/chave
worker/validar.test.mjs           MOD  — assert dos campos novos
worker/extrair.js                 MOD  — PROMPT pede contraparte/chave
worker/db.js                      MOD  — inserirTransacao(contraparte); atualizarTransacao(descricao + upsert regra); upsertAssociacao; buscarAssociacao
worker/db.test.mjs                MOD  — testes novos
worker/index.js                   MOD  — aplica regra na captura; grava contraparte; confirmação "aprendido"
worker/index.test.mjs             MOD  — regra aplicada sobrepõe modelo
public/app.js                     MOD  — subsPorCategoria; descrição editável; sub combobox; PATCH; rótulos
public/app.test.mjs               MOD  — subsPorCategoria
public/index.html                 MOD  — cabeçalho "Categoria"; datalist
public/shell.css                  MOD  — larguras da tabela; combobox
CLAUDE.md / CONTEXTO.md           MOD  — vocabulário e decisões do Inc 2
worker/teach.js                   NOVO — parseAprender(caption) (puro)
worker/teach.test.mjs             NOVO
worker/telegram.js                MOD  — parseUpdate captura caption
worker/index.js                   MOD  — ramo "teach" (dry-run, sem transação)
tools/contraparte.py              NOVO — port py de normalizar/derivar (casa com o JS)
tools/ensino_extrair.py           NOVO — varre Dropbox, extrai contraparte, agrupa, gera CSV
tools/ensino_aplicar.py           NOVO — upsert das associações a partir do CSV
tests/test_contraparte.py         NOVO — paridade com o contraparte.js
tests/test_ensino.py              NOVO — agrupamento por contraparte
```
(Tasks 8–9 abaixo são o **modo ensino** — §12 da spec — aditivas ao núcleo.)

---

### Task 1: Migração 0002 (contraparte + associacoes)

**Files:**
- Create: `migrations/0002_associacoes.sql`
- Modify: `schema.sql`

**Interfaces:**
- Produces: `transacoes.contraparte_nome`, `transacoes.contraparte_chave`; `origem_categoria` aceita `'regra'`; tabela `associacoes(chave, tipo_chave, macro, sub, n, atualizado_em)`. Tasks 4/5 dependem desses nomes.

- [ ] **Step 1: Escrever `migrations/0002_associacoes.sql`**

```sql
alter table transacoes add column if not exists contraparte_nome  text;
alter table transacoes add column if not exists contraparte_chave text;

alter table transacoes drop constraint if exists transacoes_origem_categoria_check;
alter table transacoes add constraint transacoes_origem_categoria_check
  check (origem_categoria in ('modelo','manual','regra'));

create table if not exists associacoes (
  chave         text not null,
  tipo_chave    text not null check (tipo_chave in ('pix_cpf','nome')),
  macro         text not null,
  sub           text,
  n             integer not null default 1,
  atualizado_em timestamptz not null default now(),
  primary key (chave, tipo_chave)
);
```

- [ ] **Step 2: Refletir no `schema.sql`** — adicionar as duas colunas em `transacoes`, atualizar o check de `origem_categoria` para incluir `'regra'`, e acrescentar o bloco `create table associacoes` (idêntico ao acima, sem `if not exists`).

- [ ] **Step 3: Aplicar no Neon** (checkpoint de infra; usa `DATABASE_URL` do `.dev.vars`, sem exibir)

Run (bash): `DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .dev.vars | tr -d '"')" psql "$DATABASE_URL" -f migrations/0002_associacoes.sql`
(Se `psql` ausente, aplicar via script Python psycopg lendo o arquivo, como no Inc 1.)
Expected: sem erro.

- [ ] **Step 4: Verificar**

Run: consulta `select column_name from information_schema.columns where table_name='transacoes' and column_name like 'contraparte%'` → 2 linhas; e `select to_regclass('public.associacoes')` → não nulo.

- [ ] **Step 5: Commit**

```bash
git add migrations/0002_associacoes.sql schema.sql
git commit -m "feat: migração 0002 (contraparte em transacoes + tabela associacoes)"
```

---

### Task 2: Módulo `contraparte.js` (normalização + derivação de chave)

**Files:**
- Create: `worker/contraparte.js`, `worker/contraparte.test.mjs`

**Interfaces:**
- Produces:
  - `normalizarNome(s) -> string | null` — maiúsculas, sem acento, espaços colapsados; vazio → null.
  - `normalizarChave(s) -> string | null` — e-mail: minúsculas/trim; contém dígitos (telefone/CPF): só dígitos; aleatória: trim minúsculas; vazio → null.
  - `derivarChave({ contraparte_nome, contraparte_chave }) -> { chave, tipo } | null` — se `contraparte_chave` normaliza → `{chave, tipo:'pix_cpf'}`; senão se nome → `{chave, tipo:'nome'}`; senão null.

- [ ] **Step 1: Escrever `worker/contraparte.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizarNome, normalizarChave, derivarChave } from "./contraparte.js";

test("normalizarNome: maiúsculas, sem acento, espaços colapsados", () => {
  assert.equal(normalizarNome("  Viviane   Ferrer  Borgato "), "VIVIANE FERRER BORGATO");
  assert.equal(normalizarNome("Educação"), "EDUCACAO");
  assert.equal(normalizarNome(""), null);
  assert.equal(normalizarNome(null), null);
});

test("normalizarChave: telefone/CPF viram só dígitos; e-mail minúsculo", () => {
  assert.equal(normalizarChave("+55 (19) 99578-3408"), "5519995783408");
  assert.equal(normalizarChave("***.923.318-**"), "923318");
  assert.equal(normalizarChave("  Fulano@Email.COM "), "fulano@email.com");
  assert.equal(normalizarChave(""), null);
});

test("derivarChave prioriza chave pix/cpf; cai pro nome", () => {
  assert.deepEqual(derivarChave({ contraparte_chave: "+5519995783408", contraparte_nome: "X" }),
    { chave: "5519995783408", tipo: "pix_cpf" });
  assert.deepEqual(derivarChave({ contraparte_chave: null, contraparte_nome: "Viviane Ferrer" }),
    { chave: "VIVIANE FERRER", tipo: "nome" });
  assert.equal(derivarChave({ contraparte_chave: null, contraparte_nome: null }), null);
});
```

- [ ] **Step 2: Rodar e ver falhar** — `node --test worker/contraparte.test.mjs` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar `worker/contraparte.js`**

```javascript
// Normalização da contraparte p/ servir de chave de aprendizado.
// Por quê: a mesma pessoa aparece com grafias/formatos diferentes; normalizar
// evita criar regras duplicadas e faz o lookup casar.

export function normalizarNome(s) {
  if (!s || typeof s !== "string") return null;
  const n = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "") // tira acento
    .toUpperCase().replace(/\s+/g, " ").trim();
  return n || null;
}

export function normalizarChave(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  if (t.includes("@")) return t.toLowerCase();          // e-mail
  if (/\d/.test(t)) { const d = t.replace(/\D/g, ""); return d || null; } // telefone/CPF
  return t.toLowerCase();                                 // chave aleatória
}

export function derivarChave({ contraparte_nome, contraparte_chave } = {}) {
  const ch = normalizarChave(contraparte_chave);
  if (ch) return { chave: ch, tipo: "pix_cpf" };
  const nm = normalizarNome(contraparte_nome);
  if (nm) return { chave: nm, tipo: "nome" };
  return null;
}
```

- [ ] **Step 4: Rodar e ver passar** — `node --test worker/contraparte.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/contraparte.js worker/contraparte.test.mjs
git commit -m "feat: contraparte.js (normalização + derivação da chave de aprendizado)"
```

---

### Task 3: Extração captura a contraparte

**Files:**
- Modify: `worker/extrair.js` (a função `PROMPT`), `worker/validar.js`, `worker/validar.test.mjs`

**Interfaces:**
- Consumes: nada novo.
- Produces: o `normalizado` de `validarExtracao` passa a conter `contraparte_nome` (string|null) e `contraparte_chave` (string|null), repassados crus (sem normalizar — a normalização é no uso). O `PROMPT` pede esses campos.

- [ ] **Step 1: Estender o teste `worker/validar.test.mjs`** — adicionar:

```javascript
test("normalizado repassa contraparte quando presente", () => {
  const r = validarExtracao(
    { data: "2026-08-28", valor: "916,00", macro: "Casa",
      contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "+5519995783408" },
    ["Casa"]
  );
  assert.equal(r.ok, true);
  assert.equal(r.normalizado.contraparte_nome, "VIVIANE FERRER BORGATO");
  assert.equal(r.normalizado.contraparte_chave, "+5519995783408");
});

test("contraparte ausente vira null no normalizado", () => {
  const r = validarExtracao({ data: "2026-08-28", valor: "10", macro: "Casa" }, ["Casa"]);
  assert.equal(r.normalizado.contraparte_nome, null);
  assert.equal(r.normalizado.contraparte_chave, null);
});
```

- [ ] **Step 2: Rodar e ver falhar** — `node --test worker/validar.test.mjs` → FAIL (campos ausentes no normalizado).

- [ ] **Step 3: Implementar em `worker/validar.js`** — no objeto `normalizado` do retorno de sucesso, acrescentar:

```javascript
    normalizado: {
      dataISO, valorCents, natureza, macro,
      sub: campos.sub || null,
      descricao: campos.descricao || null,
      contraparte_nome: campos.contraparte_nome || null,
      contraparte_chave: campos.contraparte_chave || null,
    },
```

- [ ] **Step 4: Atualizar o `PROMPT` em `worker/extrair.js`** — trocar o bloco de chaves pedidas para incluir a contraparte (mantendo o resto):

```javascript
  return [
    "Você lê um comprovante de pagamento (pix/transferência) em imagem.",
    "Responda SOMENTE um JSON com as chaves:",
    '{ "data": "AAAA-MM-DD", "valor": número, "descricao": string,',
    '  "natureza": "despesa"|"receita", "macro": string, "sub": string|null,',
    '  "contraparte_nome": string|null, "contraparte_chave": string|null,',
    '  "confianca": número entre 0 e 1 }.',
    "contraparte_nome = quem RECEBE (despesa) ou quem PAGA (receita) — o outro lado.",
    "contraparte_chave = chave Pix, CPF/CNPJ ou agência/conta do outro lado, se houver; senão null.",
    "Escolha macro e sub EXCLUSIVAMENTE desta lista (não invente rótulo):",
    lista,
    "Se não tiver certeza do sub, use null. 'confianca' é sua certeza global na leitura.",
  ].join("\n");
```

- [ ] **Step 5: Rodar a suíte e ver passar** — `npm test` → todas PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/validar.js worker/validar.test.mjs worker/extrair.js
git commit -m "feat: extração captura contraparte (nome + chave)"
```

---

### Task 4: `db.js` — contraparte, descrição editável e associações

**Files:**
- Modify: `worker/db.js`, `worker/db.test.mjs`

**Interfaces:**
- Consumes: `derivarChave` de `contraparte.js`.
- Produces:
  - `inserirTransacao(t)` grava também `t.contraparte_nome`, `t.contraparte_chave`.
  - `atualizarTransacao(id, c)` aceita `c.descricao`; e, quando `c.macro !== undefined || c.sub !== undefined` e a linha tem contraparte, faz `upsert` em `associacoes`.
  - `upsertAssociacao({ chave, tipo, macro, sub })` — insert ou incremento de `n`.
  - `buscarAssociacao(chave, tipo) -> row | null`.

- [ ] **Step 1: Estender `worker/db.test.mjs`** — adicionar (o helper `fakeSql` já existe):

```javascript
test("inserirTransacao grava contraparte", async () => {
  const sql = fakeSql([{ id: "t1" }]);
  const db = criarDb(sql);
  await db.inserirTransacao({
    dataISO: "2026-08-28", natureza: "despesa", esfera: "pessoal", valorCents: 91600,
    reembolsoCents: 0, macro: "Educação", sub: "Inglês Particular", descricao: "Pix",
    pessoa: null, fonte: "imagem", origem_categoria: "regra", extraido_por: "claude",
    confianca: 0.85, documento_id: "d1",
    contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "5519995783408",
  });
  assert.ok(sql.chamadas[0].values.includes("VIVIANE FERRER BORGATO"));
  assert.ok(sql.chamadas[0].values.includes("5519995783408"));
});

test("buscarAssociacao consulta por chave e tipo", async () => {
  const sql = fakeSql([{ chave: "5519995783408", tipo_chave: "pix_cpf", macro: "Educação", sub: "Inglês Particular" }]);
  const db = criarDb(sql);
  const r = await db.buscarAssociacao("5519995783408", "pix_cpf");
  assert.equal(r.macro, "Educação");
  assert.deepEqual(sql.chamadas[0].values, ["5519995783408", "pix_cpf"]);
});

test("upsertAssociacao insere e incrementa n", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.upsertAssociacao({ chave: "5519995783408", tipo: "pix_cpf", macro: "Educação", sub: "Inglês Particular" });
  assert.match(sql.chamadas[0].text, /insert into associacoes/i);
  assert.match(sql.chamadas[0].text, /on conflict/i);
});

test("atualizarTransacao aceita descricao e aprende associação quando muda categoria", async () => {
  const existente = { id: "t1", data: "2026-08-28", macro: "Pessoal", sub: "Fatura",
    valor_total: "916.00", valor_reembolso: "0.00", pessoa: null, descricao: "Pix",
    natureza: "despesa", esfera: "pessoal",
    contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "5519995783408" };
  const sql = fakeSql([existente]);
  const db = criarDb(sql);
  await db.atualizarTransacao("t1", { macro: "Educação", sub: "Inglês Particular", descricao: "Aula de inglês" });
  // 3 chamadas: SELECT, UPDATE, UPSERT associacao
  assert.equal(sql.chamadas.length, 3);
  assert.match(sql.chamadas[1].text, /update transacoes/i);
  assert.ok(sql.chamadas[1].values.includes("Aula de inglês")); // descricao editada
  assert.match(sql.chamadas[2].text, /insert into associacoes/i);
  assert.ok(sql.chamadas[2].values.includes("5519995783408")); // chave pix/cpf
  assert.ok(sql.chamadas[2].values.includes("Educação"));
});
```

- [ ] **Step 2: Rodar e ver falhar** — `node --test worker/db.test.mjs` → FAIL.

- [ ] **Step 3: Implementar em `worker/db.js`** — no topo, importar `derivarChave`:

```javascript
import { centsToNumeric } from "./money.js";
import { derivarChave } from "./contraparte.js";
```

Em `inserirTransacao`, incluir as colunas de contraparte no INSERT (acrescentar ao final da lista de colunas e dos valores):

```javascript
    async inserirTransacao(t) {
      const rows = await sql`
        insert into transacoes
          (data, natureza, esfera, valor_total, valor_reembolso, macro, sub, descricao,
           pessoa, fonte, origem_categoria, extraido_por, confianca, documento_id,
           contraparte_nome, contraparte_chave)
        values
          (${t.dataISO}, ${t.natureza}, ${t.esfera}, ${centsToNumeric(t.valorCents)},
           ${centsToNumeric(t.reembolsoCents ?? 0)}, ${t.macro}, ${t.sub}, ${t.descricao},
           ${t.pessoa ?? null}, ${t.fonte}, ${t.origem_categoria}, ${t.extraido_por ?? null},
           ${t.confianca ?? null}, ${t.documento_id ?? null},
           ${t.contraparte_nome ?? null}, ${t.contraparte_chave ?? null})
        returning id`;
      return { id: rows[0].id };
    },
```

Substituir `atualizarTransacao` para aceitar `descricao` e aprender:

```javascript
    async atualizarTransacao(id, c) {
      const rows = await sql`select * from transacoes where id = ${id}`;
      const t = rows[0];
      if (!t) return;
      const data = c.dataISO ?? t.data;
      const macro = c.macro ?? t.macro;
      const sub = c.sub === undefined ? t.sub : (c.sub || null);
      const pessoa = c.pessoa === undefined ? t.pessoa : (c.pessoa || null);
      const descricao = c.descricao === undefined ? t.descricao : (c.descricao || null);
      const natureza = c.natureza ?? t.natureza;
      const esfera = c.esfera ?? t.esfera;
      const valor_total = c.valorCents != null ? centsToNumeric(c.valorCents) : t.valor_total;
      const valor_reembolso = c.reembolsoCents != null ? centsToNumeric(c.reembolsoCents) : t.valor_reembolso;
      await sql`
        update transacoes set
          data = ${data}, macro = ${macro}, sub = ${sub}, pessoa = ${pessoa},
          descricao = ${descricao}, natureza = ${natureza}, esfera = ${esfera},
          valor_total = ${valor_total}, valor_reembolso = ${valor_reembolso},
          origem_categoria = 'manual'
        where id = ${id}`;
      // aprende: correção de categoria vira regra pra aquela contraparte
      if (c.macro !== undefined || c.sub !== undefined) {
        const d = derivarChave({ contraparte_nome: t.contraparte_nome, contraparte_chave: t.contraparte_chave });
        if (d) await this.upsertAssociacao({ chave: d.chave, tipo: d.tipo, macro, sub });
      }
    },
```

Adicionar os dois métodos novos (antes do `resumoPorCategoria`, por exemplo):

```javascript
    async buscarAssociacao(chave, tipo) {
      const rows = await sql`select * from associacoes where chave = ${chave} and tipo_chave = ${tipo} limit 1`;
      return rows[0] ?? null;
    },

    async upsertAssociacao({ chave, tipo, macro, sub }) {
      await sql`
        insert into associacoes (chave, tipo_chave, macro, sub, n, atualizado_em)
        values (${chave}, ${tipo}, ${macro}, ${sub ?? null}, 1, now())
        on conflict (chave, tipo_chave) do update
          set macro = excluded.macro, sub = excluded.sub,
              n = associacoes.n + 1, atualizado_em = now()`;
    },
```

Nota: `atualizarTransacao` usa `this.upsertAssociacao`, então o objeto retornado por `criarDb` deve ser referenciável — como os métodos são propriedades do mesmo objeto literal retornado, `this` dentro de `atualizarTransacao` aponta pra ele quando chamado como `db.atualizarTransacao(...)`. (Os testes chamam `db.atualizarTransacao`, mantendo o `this` correto.)

- [ ] **Step 4: Rodar e ver passar** — `node --test worker/db.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/db.js worker/db.test.mjs
git commit -m "feat: db aprende associações (contraparte no insert, descricao editável, upsert/busca)"
```

---

### Task 5: `index.js` — aplica a regra aprendida na captura

**Files:**
- Modify: `worker/index.js`, `worker/index.test.mjs`

**Interfaces:**
- Consumes: `normalizarChave`, `normalizarNome` de `contraparte.js`; `db.buscarAssociacao`; `normalizado.contraparte_*` (Task 3).
- Produces: na captura, se há associação pra contraparte, `macro`/`sub` vêm da regra e `origem_categoria='regra'`; a transação grava `contraparte_nome`/`contraparte_chave`; a confirmação sinaliza "aprendido".

- [ ] **Step 1: Estender `worker/index.test.mjs`** — o `dbFake` ganha `buscarAssociacao`; adicionar teste:

```javascript
test("regra aprendida sobrepõe o chute do modelo", async () => {
  const enviados = [];
  const db = dbFake();
  db.buscarAssociacao = async (chave, tipo) =>
    (chave === "5519995783408" && tipo === "pix_cpf")
      ? { macro: "Educação", sub: "Inglês Particular" } : null;
  const deps = {
    db,
    baixar: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg" }),
    hashBytes: async () => "h9",
    extrairImpl: async () => ({ ok: true, extraido_por: "claude", confianca: 0.85,
      normalizado: { dataISO: "2026-08-28", valorCents: 91600, natureza: "despesa",
        macro: "Pessoal", sub: "Fatura", descricao: "Pix",
        contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "+5519995783408" } }),
    subir: async () => "/x.jpg",
    confirmar: async (chat, texto, id) => enviados.push(texto),
    responderImpl: async () => {},
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, photo: [{ file_id: "b", width: 800 }] } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  const ins = db.estado.inseridos[0];
  assert.equal(ins.macro, "Educação");           // veio da regra, não "Pessoal"
  assert.equal(ins.sub, "Inglês Particular");
  assert.equal(ins.origem_categoria, "regra");
  assert.equal(ins.contraparte_chave, "+5519995783408"); // guarda a contraparte
  assert.ok(enviados.some(t => /aprendido/i.test(t)));
});
```

(No `dbFake` existente, garantir `buscarAssociacao: async () => null` por padrão para os outros testes não quebrarem.)

- [ ] **Step 2: Rodar e ver falhar** — `node --test worker/index.test.mjs` → FAIL.

- [ ] **Step 3: Implementar em `worker/index.js`** — importar as normalizações:

```javascript
import { normalizarChave, normalizarNome } from "./contraparte.js";
```

Em `tratarUpdate`, logo após obter `const n = ex.normalizado;` e antes de montar o caminho do Dropbox, inserir a busca de regra:

```javascript
  const n = ex.normalizado;
  // aplica regra aprendida pela contraparte (pix/cpf primeiro, nome depois)
  let origemCat = "modelo";
  const ck = normalizarChave(n.contraparte_chave);
  if (ck) { const r = await deps.db.buscarAssociacao(ck, "pix_cpf"); if (r) { n.macro = r.macro; n.sub = r.sub; origemCat = "regra"; } }
  if (origemCat === "modelo") { const nm = normalizarNome(n.contraparte_nome); if (nm) { const r = await deps.db.buscarAssociacao(nm, "nome"); if (r) { n.macro = r.macro; n.sub = r.sub; origemCat = "regra"; } } }
```

No `inserirTransacao` da captura, passar `origem_categoria: origemCat` e as colunas de contraparte:

```javascript
  const tx = await deps.db.inserirTransacao({
    dataISO: n.dataISO, natureza: n.natureza, esfera: "pessoal",
    valorCents: n.valorCents, reembolsoCents: 0, macro: n.macro, sub: n.sub,
    descricao: n.descricao, pessoa: null, fonte: "imagem", origem_categoria: origemCat,
    extraido_por: ex.extraido_por, confianca: ex.confianca, documento_id: doc.id,
    contraparte_nome: n.contraparte_nome, contraparte_chave: n.contraparte_chave,
  });
```

Na confirmação, sinalizar quando veio de regra:

```javascript
  const cat = n.sub ? `${n.macro} › ${n.sub}` : n.macro;
  const selo = origemCat === "regra" ? " ✓ aprendido" : "";
  const [a, m, d] = n.dataISO.split("-");
  await deps.confirmar(ev.chatId, `✅ R$ ${centsToBR(n.valorCents)} · ${d}/${m} · ${cat}${selo} · "${n.descricao ?? ""}"\najuste a categoria no app`, tx.id);
```

E no `handleTelegram`, o `dbFake` real usa `criarDb(sql)` que já tem `buscarAssociacao` (Task 4) — nada a mudar ali além de garantir que o import de normalizações está no topo.

- [ ] **Step 4: Rodar a suíte e ver passar** — `npm test` → todas PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/index.test.mjs
git commit -m "feat: captura aplica regra aprendida pela contraparte (origem=regra)"
```

---

### Task 6: App — descrição editável, subcategoria combobox, rótulo Categoria, larguras

**Files:**
- Modify: `public/app.js`, `public/app.test.mjs`, `public/index.html`, `public/shell.css`

**Interfaces:**
- Consumes: `/api/categorias` (já retorna `{macro, sub}`).
- Produces: `subsPorCategoria(cats) -> { [macro]: string[] }` (pura, testada); tabela com descrição editável (`PATCH descricao`), sub como `<input list>` + `<datalist>` por categoria, cabeçalho "Categoria", larguras corrigidas.

- [ ] **Step 1: Estender `public/app.test.mjs`** — adicionar (importar `subsPorCategoria`):

```javascript
import { subsPorCategoria } from "./app.js";

test("subsPorCategoria agrupa subs por categoria, ignorando nulos e duplicados", () => {
  const cats = [
    { macro: "Casa", sub: "Luz" }, { macro: "Casa", sub: "Água" }, { macro: "Casa", sub: null },
    { macro: "Casa", sub: "Luz" }, { macro: "Saúde", sub: "Plano" },
  ];
  const g = subsPorCategoria(cats);
  assert.deepEqual(g["Casa"], ["Luz", "Água"]);
  assert.deepEqual(g["Saúde"], ["Plano"]);
});
```

- [ ] **Step 2: Rodar e ver falhar** — `node --test public/app.test.mjs` → FAIL.

- [ ] **Step 3: Implementar `subsPorCategoria` em `public/app.js`** (função pura, junto das outras exportadas no topo):

```javascript
export function subsPorCategoria(cats) {
  const g = {};
  for (const c of cats) {
    if (!g[c.macro]) g[c.macro] = [];
    if (c.sub && !g[c.macro].includes(c.sub)) g[c.macro].push(c.sub);
  }
  return g;
}
```

- [ ] **Step 4: Rodar e ver passar** — `node --test public/app.test.mjs` → PASS.

- [ ] **Step 5: Guardar as subs por categoria no estado e nos datalists** — dentro do bloco browser de `app.js`:
  - Em `carregar()`, após obter `categorias`, guardar: `estado.subs = subsPorCategoria(categorias);`
  - Adicionar (uma vez) uma função que garante um `<datalist id="subs-<macro>">` por categoria no DOM, ou um único `<datalist id="subs-lista">` repopulado quando a categoria muda. Usar a abordagem de **um datalist por linha atualizado on-change** (mais simples e correto por linha):

- [ ] **Step 6: Reescrever `drawRows` em `public/app.js`** para descrição editável + sub combobox + rótulos:

```javascript
function fmtData(d) { const s = String(d).slice(0, 10); const [a, m, dia] = s.split("-"); return `${dia}/${m}/${a}`; }
function drawRows() {
  const macros = [...new Set(Object.keys(estado.cores))].sort();
  $("#rows").innerHTML = estado.transacoes.map((t, i) => {
    const rec = t.natureza === "receita";
    const opts = macros.map(mm => `<option ${mm === t.macro ? "selected" : ""}>${esc(mm)}</option>`).join("");
    const subs = (estado.subs && estado.subs[t.macro]) || [];
    const dlId = `subs-${i}`;
    const dlOpts = subs.map(s => `<option value="${esc(s)}"></option>`).join("");
    return `<tr data-id="${t.id}" data-i="${i}">
      <td class="dt">${fmtData(t.data)}</td>
      <td><input class="eddesc" value="${esc(t.descricao || "")}" placeholder="—"></td>
      <td><span class="macrochip"><i class="dot" style="background:var(${corDe(t.macro)})"></i><select class="edmacro">${opts}</select></span></td>
      <td><input class="edsub" list="${dlId}" value="${esc(t.sub || "")}" placeholder="—"><datalist id="${dlId}">${dlOpts}</datalist></td>
      <td class="val" style="color:${rec ? "var(--receita)" : "var(--ink)"}">${rec ? "+" : ""}R$ ${centavosBR(t.valor_total)}</td>
      <td class="val" style="color:var(--mut)">${+t.valor_reembolso ? "R$ " + centavosBR(t.valor_reembolso) : "—"}</td>
      <td><button class="del" title="Apagar">✕</button></td>
    </tr>`;
  }).join("");
}
```

- [ ] **Step 7: Ajustar os handlers de edição em `public/app.js`** (bloco `$("#rows").addEventListener("change", ...)`) para descrição e para repopular o datalist quando a categoria muda:

```javascript
  $("#rows").addEventListener("change", async e => {
    const tr = e.target.closest("tr"); if (!tr) return; const id = tr.dataset.id;
    try {
      if (e.target.classList.contains("edmacro")) {
        await apiPatch(`/api/transacoes/${id}`, { macro: e.target.value });
        // repopula as subs da nova categoria no datalist da linha
        const dl = tr.querySelector("datalist");
        const subs = (estado.subs && estado.subs[e.target.value]) || [];
        if (dl) dl.innerHTML = subs.map(s => `<option value="${esc(s)}"></option>`).join("");
        // atualiza a cor do chip
        const dot = tr.querySelector(".macrochip .dot");
        if (dot) dot.style.background = `var(${corDe(e.target.value)})`;
      }
      if (e.target.classList.contains("edsub")) await apiPatch(`/api/transacoes/${id}`, { sub: e.target.value });
      if (e.target.classList.contains("eddesc")) await apiPatch(`/api/transacoes/${id}`, { descricao: e.target.value });
    } catch (err) { alert("Falha ao salvar: " + err.message); }
  });
```

- [ ] **Step 8: `public/index.html`** — trocar o cabeçalho da tabela `<th>Macro</th>` por `<th>Categoria</th>` (manter "Subcategoria"). Nenhuma outra referência de UI a "Macro".

- [ ] **Step 9: `public/shell.css`** — corrigir larguras da tabela p/ não cortar texto:

```css
/* tabela: colunas com respiro; nada de sub truncada */
table{min-width:820px}
td.dt{width:96px}
.eddesc{border:1px solid transparent;background:transparent;color:var(--ink);font:inherit;font-size:13.5px;
  padding:3px 6px;border-radius:6px;width:100%;min-width:150px}
.eddesc:hover,.eddesc:focus{border-color:var(--line);background:var(--ground);outline:none}
.edsub{border:1px solid transparent;background:transparent;color:var(--ink);font:inherit;font-size:13px;
  padding:3px 6px;border-radius:6px;width:100%;min-width:180px}
.edsub:hover,.edsub:focus{border-color:var(--line);background:var(--ground);outline:none}
.macrochip select{max-width:150px}
```
(Substituir a regra antiga `.edsub{...width:130px}` por estas.)

- [ ] **Step 10: Verificação visual** (mock local, como no Inc 1): servir `public/` com um mock de `/api/*` (incluindo `/api/categorias` com várias subs por categoria e subs longas), abrir, e conferir: descrição edita, sub abre o combobox com as subs da categoria e não corta texto, cabeçalho diz "Categoria", troca de categoria repopula as subs.

- [ ] **Step 11: Commit**

```bash
git add public/app.js public/app.test.mjs public/index.html public/shell.css
git commit -m "feat: app — descrição editável, subcategoria combobox por categoria, rótulo Categoria, tabela mais larga"
```

---

### Task 7: Documentação (CLAUDE.md / CONTEXTO.md)

**Files:**
- Modify: `CLAUDE.md`, `CONTEXTO.md`

**Interfaces:** nenhuma (docs).

- [ ] **Step 1: `CLAUDE.md`** — no vocabulário fixo, atualizar `origem_categoria` para `modelo | manual | regra` (com o significado de `regra` = categoria aplicada por associação aprendida); registrar as colunas `contraparte_nome`/`contraparte_chave` e a tabela `associacoes`; nota de que a UI chama `macro` de "Categoria" mas a coluna segue `macro`.

- [ ] **Step 2: `CONTEXTO.md`** — registrar a decisão do Inc 2 (aprender pela contraparte; chave pix/cpf com nome de reserva; auto-aplicar) e o *porquê* (transações recorrentes são pras mesmas pessoas); marcar Inc 2 como implementado no roadmap.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CONTEXTO.md
git commit -m "docs: Inc 2 — vocabulário (origem=regra), contraparte, associacoes"
```

---

### Task 8: Modo ensino — teach-command no Telegram (dry-run)

**Files:**
- Create: `worker/teach.js`, `worker/teach.test.mjs`
- Modify: `worker/telegram.js` (parseUpdate captura `caption`), `worker/index.js`, `worker/index.test.mjs`

**Interfaces:**
- Consumes: `derivarChave` (contraparte.js), `db.upsertAssociacao` (Task 4), extração (Task 3).
- Produces: `parseAprender(caption) -> { macro, sub } | null` (puro). Fluxo teach em `tratarUpdate`: se a foto vem com caption de comando, extrai só a contraparte, faz `upsert` da associação e **não cria transação**.

- [ ] **Step 1: Escrever `worker/teach.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAprender } from "./teach.js";

test("parseAprender lê '/aprender Categoria > Sub'", () => {
  assert.deepEqual(parseAprender("/aprender Educação > Inglês Particular"),
    { macro: "Educação", sub: "Inglês Particular" });
});
test("aceita sem subcategoria", () => {
  assert.deepEqual(parseAprender("/aprender Casa"), { macro: "Casa", sub: null });
});
test("ignora legenda que não é comando", () => {
  assert.equal(parseAprender("comprovante de pix"), null);
  assert.equal(parseAprender(""), null);
  assert.equal(parseAprender(undefined), null);
});
```

- [ ] **Step 2: Rodar e ver falhar** — `node --test worker/teach.test.mjs` → FAIL.

- [ ] **Step 3: Implementar `worker/teach.js`**

```javascript
// Reconhece a legenda de ensino: "/aprender <Categoria> > <Subcategoria>".
// Por quê: ensinar a associação sem criar transação (dry-run), varrendo o backlog.
export function parseAprender(caption) {
  if (!caption || typeof caption !== "string") return null;
  const m = caption.trim().match(/^\/aprender\s+(.+)$/i);
  if (!m) return null;
  const [macro, sub] = m[1].split(">").map((s) => s.trim());
  if (!macro) return null;
  return { macro, sub: sub || null };
}
```

- [ ] **Step 4: `parseUpdate` captura a legenda** — em `worker/telegram.js`, no ramo de foto/documento-imagem, incluir `caption: m.caption || null` no objeto retornado. Adicionar um teste em `telegram.test.mjs` de que uma foto com `caption` retorna `caption` preenchido.

- [ ] **Step 5: Ramo teach em `tratarUpdate` (`worker/index.js`)** — importar `parseAprender` e, logo após baixar a imagem e (dedup opcional pode ser pulado no teach), antes do fluxo normal de gravação:

```javascript
  // modo ensino: foto com legenda "/aprender ..." → só aprende, não cria transação
  const ap = parseAprender(ev.caption);
  if (ap) {
    const cats = await deps.db.listarCategorias();
    const macros = [...new Set(cats.map((c) => c.macro))];
    if (!macros.includes(ap.macro)) { await deps.responderImpl(ev.chatId, `Categoria "${ap.macro}" não existe. Categorias: ${macros.join(", ")}`, env); return; }
    const ex = await deps.extrairImpl(bytes, mime, cats);
    if (!ex.ok) { await deps.responderImpl(ev.chatId, "Não consegui ler a contraparte desse comprovante.", env); return; }
    const n = ex.normalizado;
    const d = derivarChave({ contraparte_nome: n.contraparte_nome, contraparte_chave: n.contraparte_chave });
    if (!d) { await deps.responderImpl(ev.chatId, "Comprovante sem contraparte reconhecível — não dá pra aprender.", env); return; }
    await deps.db.upsertAssociacao({ chave: d.chave, tipo: d.tipo, macro: ap.macro, sub: ap.sub });
    const cat = ap.sub ? `${ap.macro} › ${ap.sub}` : ap.macro;
    await deps.responderImpl(ev.chatId, `✓ aprendido: ${n.contraparte_nome ?? d.chave} → ${cat}`, env);
    return;
  }
```
(Importar no topo: `import { derivarChave } from "./contraparte.js";` — já usado na Task 5; e `import { parseAprender } from "./teach.js";`. `ev.caption` vem do Step 4.)

- [ ] **Step 6: Teste em `worker/index.test.mjs`** — foto com caption teach:

```javascript
test("teach: foto com /aprender grava associação e NÃO cria transação", async () => {
  const db = dbFake();
  const aprendidas = [];
  db.listarCategorias = async () => [{ macro: "Educação", sub: null }];
  db.upsertAssociacao = async (a) => aprendidas.push(a);
  const deps = {
    db,
    baixar: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg" }),
    hashBytes: async () => "h1",
    extrairImpl: async () => ({ ok: true, extraido_por: "gemini", confianca: 0.9,
      normalizado: { contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "+5519995783408" } }),
    responderImpl: async () => {},
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, caption: "/aprender Educação > Inglês Particular",
    photo: [{ file_id: "b", width: 800 }] } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.estado.inseridos.length, 0);           // dry-run: nada gravado como transação
  assert.equal(aprendidas[0].macro, "Educação");
  assert.equal(aprendidas[0].tipo, "pix_cpf");
});
```
(No `dbFake`, garantir defaults `upsertAssociacao: async () => {}`, `buscarAssociacao: async () => null`, `listarCategorias` existente.)

- [ ] **Step 7: Rodar a suíte e ver passar** — `npm test` → PASS.

- [ ] **Step 8: Commit**

```bash
git add worker/teach.js worker/teach.test.mjs worker/telegram.js worker/index.js worker/index.test.mjs
git commit -m "feat: modo ensino no Telegram (/aprender, dry-run sem transação)"
```

---

### Task 9: Modo ensino — lote pelo Dropbox

**Files:**
- Create: `tools/contraparte.py`, `tests/test_contraparte.py`, `tools/ensino_extrair.py`, `tools/ensino_aplicar.py`, `tests/test_ensino.py`

**Interfaces:**
- Produces (puros, testados): `normalizar_nome`, `normalizar_chave`, `derivar_chave` (paridade com `worker/contraparte.js`); `agrupar_por_contraparte(rows) -> list[dict]` (agrupa por chave, conta ocorrências, mantém 1ª sugestão de macro/sub).
- Scripts: `ensino_extrair.py <pasta>` gera `contrapartes.csv`; `ensino_aplicar.py <csv>` faz upsert em `associacoes`.

- [ ] **Step 1: Escrever `tests/test_contraparte.py`** (mesmos casos do JS, garantindo paridade do lookup)

```python
from tools.contraparte import normalizar_nome, normalizar_chave, derivar_chave

def test_normalizar_nome():
    assert normalizar_nome("  Viviane   Ferrer  Borgato ") == "VIVIANE FERRER BORGATO"
    assert normalizar_nome("Educação") == "EDUCACAO"
    assert normalizar_nome("") is None

def test_normalizar_chave():
    assert normalizar_chave("+55 (19) 99578-3408") == "5519995783408"
    assert normalizar_chave("***.923.318-**") == "923318"
    assert normalizar_chave("  Fulano@Email.COM ") == "fulano@email.com"
    assert normalizar_chave("") is None

def test_derivar_chave():
    assert derivar_chave({"contraparte_chave": "+5519995783408", "contraparte_nome": "X"}) == {"chave": "5519995783408", "tipo": "pix_cpf"}
    assert derivar_chave({"contraparte_chave": None, "contraparte_nome": "Viviane Ferrer"}) == {"chave": "VIVIANE FERRER", "tipo": "nome"}
    assert derivar_chave({"contraparte_chave": None, "contraparte_nome": None}) is None
```

- [ ] **Step 2: Rodar e ver falhar** — `python -m pytest tests/test_contraparte.py -v` → FAIL.

- [ ] **Step 3: Implementar `tools/contraparte.py`** (espelho do `worker/contraparte.js`)

```python
"""Paridade com worker/contraparte.js — a normalização TEM de casar p/ o lookup bater."""
import re, unicodedata

def normalizar_nome(s):
    if not s or not isinstance(s, str): return None
    n = unicodedata.normalize("NFD", s)
    n = "".join(c for c in n if unicodedata.category(c) != "Mn")  # tira acento
    n = re.sub(r"\s+", " ", n).upper().strip()
    return n or None

def normalizar_chave(s):
    if not s or not isinstance(s, str): return None
    t = s.strip()
    if not t: return None
    if "@" in t: return t.lower()
    if any(ch.isdigit() for ch in t):
        d = re.sub(r"\D", "", t); return d or None
    return t.lower()

def derivar_chave(d):
    ch = normalizar_chave((d or {}).get("contraparte_chave"))
    if ch: return {"chave": ch, "tipo": "pix_cpf"}
    nm = normalizar_nome((d or {}).get("contraparte_nome"))
    if nm: return {"chave": nm, "tipo": "nome"}
    return None
```

- [ ] **Step 4: Rodar e ver passar** — `python -m pytest tests/test_contraparte.py -v` → PASS.

- [ ] **Step 5: Escrever `tests/test_ensino.py`** (agrupamento por contraparte)

```python
from tools.ensino_extrair import agrupar_por_contraparte

def test_agrupa_por_contraparte_unica():
    rows = [
        {"contraparte_nome": "VIVIANE FERRER BORGATO", "contraparte_chave": "+5519995783408", "macro": "Educação", "sub": "Inglês Particular"},
        {"contraparte_nome": "VIVIANE FERRER BORGATO", "contraparte_chave": "+5519995783408", "macro": "Educação", "sub": "Inglês Particular"},
        {"contraparte_nome": "PADARIA X", "contraparte_chave": None, "macro": "Casa", "sub": None},
    ]
    g = agrupar_por_contraparte(rows)
    viv = [x for x in g if x["chave"] == "5519995783408"][0]
    assert viv["tipo"] == "pix_cpf" and viv["n"] == 2 and viv["sugestao_macro"] == "Educação"
    assert any(x["tipo"] == "nome" and x["chave"] == "PADARIA X" for x in g)
```

- [ ] **Step 6: Rodar e ver falhar** — `python -m pytest tests/test_ensino.py -v` → FAIL.

- [ ] **Step 7: Implementar `tools/ensino_extrair.py`** (agrupamento puro + main que varre a pasta)

```python
"""Varre comprovantes do Dropbox, extrai contraparte (Gemini), agrupa por contraparte
única e escreve contrapartes.csv p/ o Caio revisar. Uma linha por contraparte."""
import csv, os, sys, json, base64, urllib.request
from collections import OrderedDict
from tools.contraparte import derivar_chave

def agrupar_por_contraparte(rows):
    ac = OrderedDict()
    for r in rows:
        d = derivar_chave(r)
        if not d: continue
        k = (d["chave"], d["tipo"])
        if k not in ac:
            ac[k] = {"chave": d["chave"], "tipo": d["tipo"], "nome": r.get("contraparte_nome") or "",
                     "n": 0, "sugestao_macro": r.get("macro") or "", "sugestao_sub": r.get("sub") or ""}
        ac[k]["n"] += 1
    return list(ac.values())

def _gemini(img_bytes, key, cats):
    prompt = ('Leia o comprovante e responda SOMENTE JSON com {"macro":string,"sub":string|null,'
              '"contraparte_nome":string|null,"contraparte_chave":string|null}. '
              "Escolha macro/sub desta lista: " + "; ".join(cats))
    body = {"contents": [{"parts": [{"text": prompt},
             {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(img_bytes).decode()}}]}],
            "generationConfig": {"responseMimeType": "application/json"}}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key={key}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req) as r:
        j = json.loads(r.read()); return json.loads(j["candidates"][0]["content"]["parts"][0]["text"])

def main(pasta, key, cats, saida="contrapartes.csv"):
    rows = []
    for dirpath, _, files in os.walk(pasta):
        for f in files:
            if not f.lower().endswith((".jpg", ".jpeg", ".png")): continue
            with open(os.path.join(dirpath, f), "rb") as fp: b = fp.read()
            try: rows.append(_gemini(b, key, cats))
            except Exception as e: print("falhou:", f, e)
    grupos = agrupar_por_contraparte(rows)
    with open(saida, "w", newline="", encoding="utf-8") as o:
        w = csv.DictWriter(o, fieldnames=["chave", "tipo", "nome", "n", "sugestao_macro", "sugestao_sub"])
        w.writeheader(); w.writerows(grupos)
    print(f"{len(rows)} comprovantes → {len(grupos)} contrapartes únicas em {saida}")

if __name__ == "__main__":
    import os as _os
    key = _os.environ["GEMINI_KEY"]  # exportar do .dev.vars, sem versionar
    cats = _os.environ.get("CATS", "Casa; Educação; Saúde; Pessoal; Empresa; Carro; Outros").split("; ")
    main(sys.argv[1], key, cats)
```

- [ ] **Step 8: Rodar e ver passar** — `python -m pytest tests/test_ensino.py -v` → PASS.

- [ ] **Step 9: Implementar `tools/ensino_aplicar.py`** (upsert a partir do CSV revisado)

```python
"""Lê contrapartes.csv (revisado pelo Caio) e faz upsert em associacoes."""
import csv, os, sys, psycopg

def aplicar(caminho_csv, database_url):
    n = 0
    with psycopg.connect(database_url) as conn, conn.cursor() as cur, open(caminho_csv, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            macro = (row.get("sugestao_macro") or "").strip()
            if not macro: continue  # linhas sem categoria confirmada são puladas
            sub = (row.get("sugestao_sub") or "").strip() or None
            cur.execute(
                """insert into associacoes (chave, tipo_chave, macro, sub, n, atualizado_em)
                   values (%s,%s,%s,%s,1,now())
                   on conflict (chave, tipo_chave) do update
                     set macro=excluded.macro, sub=excluded.sub, n=associacoes.n+1, atualizado_em=now()""",
                (row["chave"], row["tipo"], macro, sub))
            n += 1
        conn.commit()
    print(f"{n} associações aplicadas")

if __name__ == "__main__":
    aplicar(sys.argv[1], os.environ["DATABASE_URL"])
```

- [ ] **Step 10: Rodar o backlog** (checkpoint, com o Caio): `GEMINI_KEY=... python tools/ensino_extrair.py "C:/Users/caioc/Dropbox/Finanças/Comprovantes"` → revisar `contrapartes.csv` → `DATABASE_URL=... python tools/ensino_aplicar.py contrapartes.csv`.

- [ ] **Step 11: Commit**

```bash
git add tools/contraparte.py tools/ensino_extrair.py tools/ensino_aplicar.py tests/test_contraparte.py tests/test_ensino.py
git commit -m "feat: modo ensino em lote (extrai contrapartes do Dropbox, agrupa, aplica associações)"
```

---

## Checkpoint de infra (após as tasks, com o Caio)

1. Aplicar `migrations/0002_associacoes.sql` no Neon (Task 1 Step 3) — efeito na infra do Caio.
2. `npm test` (todas) + `python -m pytest tests/` (inalterado).
3. Merge `inc2-classificador` → `master`.
4. `wrangler deploy` (publish).
5. Teste ponta-a-ponta (aprendizado por correção): mandar um Pix pra uma contraparte nova → classifica pelo modelo → corrigir no app → mandar outro comprovante da MESMA contraparte → deve entrar já na categoria certa com "✓ aprendido".
6. Teste do modo ensino (Task 8): mandar um comprovante com legenda `/aprender Educação > Inglês Particular` → bot responde "✓ aprendido: <contraparte> → ..." e NÃO cria transação; a próxima captura dessa contraparte já vem classificada.
7. Bootstrap do backlog (Task 9, opcional): rodar `ensino_extrair.py` na pasta do Dropbox, revisar o CSV, `ensino_aplicar.py` — semeia as regras do passado de uma vez.

---

## Self-Review

**Cobertura da spec:**
- §3 modelo de dados (contraparte + associacoes + origem=regra) → Task 1. ✓
- §4 extração captura contraparte → Task 3; normalização → Task 2. ✓
- §5 aprendizado no PATCH (upsert) → Task 4 (`atualizarTransacao`). ✓
- §6 aplicação na captura (lookup pix→nome, auto-aplica, selo) → Task 5. ✓
- §7 app (contraparte visível via descrição/edição, descrição editável, sub combobox, rótulo Categoria, larguras) → Task 6. ✓
- §8 migração 0002 → Task 1. ✓
- §9 testes → cada task tem os seus (contraparte, validar, db, index, app). ✓
- §12 modo ensino (teach-command Telegram dry-run; lote pelo Dropbox agrupando por contraparte) → Tasks 8 e 9. ✓
- §10 fora de escopo (painel de regras, outros sinais, Gemini) → não implementados, corretamente. O "retroativo" agora é coberto pelo §12/Task 9. ✓

**Consistência da normalização:** `tools/contraparte.py` (Task 9) espelha `worker/contraparte.js` (Task 2) — mesmos casos de teste dos dois lados; se a normalização divergir, o lookup do worker não casa com as regras semeadas em lote. Verificar paridade ao implementar.

**Placeholders:** nenhum passo com TBD/vago; todo código escrito. Passos de rede (aplicar migração, deploy) e verificação visual estão explícitos por serem inerentemente com-rede/olho, não placeholders de lógica.

**Consistência de tipos:** `derivarChave` → `{chave, tipo}` usado em db (upsert) e a busca em index usa `buscarAssociacao(chave, tipo)`. `normalizado` ganha `contraparte_nome`/`contraparte_chave` em Task 3 e é consumido em Task 5 e gravado em Task 4/5 `inserirTransacao`. `origem_categoria='regra'` definido em Task 1 (check) e usado em Task 5. `subsPorCategoria` (Task 6) casa com o teste. `atualizarTransacao` aceita `descricao` (Task 4) e o handler PATCH já repassa `request.json()` (Inc 1) — descrição chega sem mudança no handler.
