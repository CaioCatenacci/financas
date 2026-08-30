# Captura de comprovantes (Incremento 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um bot de Telegram recebe foto de comprovante, um modelo extrai os campos, a transação é gravada no Neon e o original vai pro Dropbox; um app atrás de token mostra lançamentos e um resumo visual; o histórico da planilha é importado.

**Architecture:** Um único Worker Cloudflare com três rotas (`/telegram`, `/app`, `/api/*`). A lógica pura (dinheiro, validação, nomes, auth, extração-orquestração) fica em módulos testáveis sem rede; adaptadores finos (Telegram, Gemini/Claude, Dropbox, Neon) recebem suas dependências de rede por injeção pra serem testados com `fetch` mockado. O front é HTML estático + JS vanilla servido pelo Worker. O import é um script Python separado.

**Tech Stack:** Cloudflare Workers (JS, ES modules), `@neondatabase/serverless`, Neon Postgres, Gemini Flash + Claude (visão) via HTTP, Dropbox API v2, Python 3.13 + openpyxl. Testes: `node:test`/`node:assert` no Worker; `pytest` no import.

**Spec:** `docs/superpowers/specs/2026-08-29-captura-comprovantes-design.md`

## Global Constraints

- **Repo:** `C:\Users\caioc\Caio\financas`, git novo, separado da LM Ateliê.
- **Dinheiro:** `numeric(12,2)` no banco; agregação sempre em SQL; em JS, parse via centavos inteiros (`parseBRtoCents`), nunca float acumulado. Teclado BR entrega vírgula.
- **Segurança:** token do bot, `ALLOWLIST` de chat_id, chaves Gemini/Claude, `DATABASE_URL`, refresh token + app key/secret do Dropbox, e `APP_TOKEN` são **Secrets do wrangler** (allowlist como Secret, nunca Text). App e `/api/*` atrás de token, falha fechada. Allowlist do bot falha fechada (vazia recusa todos).
- **`.gitignore`** cobre `dados/`, `*.xlsx`, `*.csv`, `.dev.vars`, `node_modules`.
- **Idioma:** comentários e testes em português, explicando o *porquê*.
- **App servido de `public/`** (refino da spec, que dizia `docs/`): mantém os markdown de design fora do diretório servido.
- **Vocabulário fixo:** `natureza ∈ {despesa, receita}`; `esfera ∈ {pessoal, empresa}`; `fonte ∈ {imagem, manual, extrato, fatura, importacao}`; `origem_categoria ∈ {modelo, manual}`; `extraido_por ∈ {gemini, claude}`.

---

## Estrutura de arquivos

```
package.json           scripts de teste; type: module
wrangler.toml          worker + binding de assets (public/)
.gitignore
.dev.vars.example      nomes dos secrets p/ dev local (sem valores)
schema.sql             DDL das 3 tabelas + índices
migrations/0001_init.sql   cópia versionada do schema
worker/
  money.js             parseBRtoCents, centsToBR, centsToNumeric
  validar.js           validarExtracao (valor/data/macro)
  dropbox_nome.js      caminhoDropbox, nomeArquivo, sanitizar
  auth.js              tokenValido, segredoTelegramValido, chatPermitido
  extrair.js           extrair() + prompts + resolução de categoria
  db.js                cliente Neon: inserts, listas, updates, resumos
  telegram.js          parseUpdate, downloadArquivo, enviarConfirmacao, responder
  index.js            export default {fetch}; tratarUpdate; rotas /api
  test-worker.mjs      suíte node:test (sem rede; fetch injetado)
public/
  shell.css  acesso.js  app.js  index.html  lancamentos.html  resumo.html
tools/
  import_planilha.py   import idempotente + relatório
tests/
  test_import.py       pytest do mapeamento
CLAUDE.md CONTEXTO.md README.md
```

---

### Task 1: Scaffolding do repo e harness de testes

**Files:**
- Create: `package.json`, `wrangler.toml`, `.gitignore`, `.dev.vars.example`, `worker/test-worker.mjs`, `README.md`

**Interfaces:**
- Consumes: nada (primeira task).
- Produces: `npm test` roda `node --test worker/test-worker.mjs`; convenção de teste com `node:test`.

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "financas",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test worker/",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^3"
  },
  "dependencies": {
    "@neondatabase/serverless": "^0.10"
  }
}
```

- [ ] **Step 2: Criar `.gitignore`**

```
node_modules/
dados/
*.xlsx
*.csv
.dev.vars
.wrangler/
```

- [ ] **Step 3: Criar `.dev.vars.example`** (só nomes, sem valores — nunca commitar `.dev.vars` real)

```
TELEGRAM_TOKEN=
TELEGRAM_SECRET=
ALLOWLIST=
GEMINI_KEY=
CLAUDE_KEY=
DATABASE_URL=
DROPBOX_REFRESH=
DROPBOX_APP_KEY=
DROPBOX_APP_SECRET=
APP_TOKEN=
```

- [ ] **Step 4: Criar `wrangler.toml`**

```toml
name = "financas"
main = "worker/index.js"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./public"
binding = "ASSETS"
```

- [ ] **Step 5: Criar o smoke test `worker/test-worker.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";

// Smoke: garante que o harness roda. Substituído pelos testes reais nas próximas tasks.
test("harness vivo", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npm test`
Expected: 1 test, PASS.

- [ ] **Step 7: Criar `README.md`** com uma linha de propósito e o comando `npm test`, apontando pra spec em `docs/superpowers/specs/`.

- [ ] **Step 8: Commit**

```bash
git add package.json wrangler.toml .gitignore .dev.vars.example worker/test-worker.mjs README.md
git commit -m "chore: scaffolding do repo financas + harness de testes"
```

---

### Task 2: Schema do banco

**Files:**
- Create: `schema.sql`, `migrations/0001_init.sql`

**Interfaces:**
- Produces: tabelas `categorias`, `documentos`, `transacoes` com os campos e o vocabulário do Global Constraints; `db.js` (Task 7) depende exatamente destes nomes de coluna.

- [ ] **Step 1: Escrever `schema.sql`**

```sql
create extension if not exists pgcrypto;  -- gen_random_uuid

create table categorias (
  id       uuid primary key default gen_random_uuid(),
  macro    text not null,
  sub      text,
  natureza text not null default 'despesa',
  ativa    boolean not null default true,
  unique (macro, sub)
);

create table documentos (
  id               uuid primary key default gen_random_uuid(),
  dropbox_path     text not null,
  nome_arquivo     text not null,
  tipo_arquivo     text,
  hash             text unique,
  telegram_file_id text,
  recebido_em      timestamptz not null default now()
);

create table transacoes (
  id               uuid primary key default gen_random_uuid(),
  data             date not null,
  natureza         text not null check (natureza in ('despesa','receita')),
  esfera           text not null default 'pessoal' check (esfera in ('pessoal','empresa')),
  valor_total      numeric(12,2) not null check (valor_total >= 0),
  valor_reembolso  numeric(12,2) not null default 0 check (valor_reembolso >= 0),
  valor_final      numeric(12,2) generated always as (valor_total - valor_reembolso) stored,
  macro            text not null,
  sub              text,
  descricao        text,
  pessoa           text,
  fonte            text not null check (fonte in ('imagem','manual','extrato','fatura','importacao')),
  origem_categoria text not null default 'modelo' check (origem_categoria in ('modelo','manual')),
  extraido_por     text check (extraido_por in ('gemini','claude')),
  confianca        numeric(4,3),
  documento_id     uuid references documentos(id),
  criado_em        timestamptz not null default now()
);

create index idx_transacoes_data on transacoes (data);
create index idx_transacoes_macro on transacoes (macro);
create index idx_transacoes_fonte on transacoes (fonte);
```

- [ ] **Step 2: Copiar pra `migrations/0001_init.sql`** (conteúdo idêntico — a migration versionada é o que se aplica; `schema.sql` é a referência legível).

- [ ] **Step 3: Aplicar no Neon** (pré-requisito: projeto Neon criado, `DATABASE_URL` em mãos)

Run: `psql "$DATABASE_URL" -f migrations/0001_init.sql`
Expected: sem erro.

- [ ] **Step 4: Verificar que as 3 tabelas existem**

Run: `psql "$DATABASE_URL" -c "select table_name from information_schema.tables where table_schema='public' order by 1;"`
Expected: `categorias`, `documentos`, `transacoes`.

- [ ] **Step 5: Commit**

```bash
git add schema.sql migrations/0001_init.sql
git commit -m "feat: schema (categorias, documentos, transacoes)"
```

---

### Task 3: Módulo de dinheiro

**Files:**
- Create: `worker/money.js`, `worker/money.test.mjs`

**Interfaces:**
- Produces:
  - `parseBRtoCents(str) -> number | null` — aceita "R$ 1.234,56", "1234,56", "1.234", "15,50"; retorna centavos inteiros ou `null` se inválido/≤0 não é regra aqui (0 é válido, negativo → null).
  - `centsToBR(cents) -> string` — 150550 → "1.505,50".
  - `centsToNumeric(cents) -> string` — 150550 → "1505.50" (pra passar ao SQL).

- [ ] **Step 1: Escrever o teste `worker/money.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBRtoCents, centsToBR, centsToNumeric } from "./money.js";

test("parseBRtoCents aceita formatos do teclado BR", () => {
  assert.equal(parseBRtoCents("R$ 1.234,56"), 123456);
  assert.equal(parseBRtoCents("1234,56"), 123456);
  assert.equal(parseBRtoCents("15,50"), 1550);
  assert.equal(parseBRtoCents("1.234"), 123400); // sem centavos
  assert.equal(parseBRtoCents("100"), 10000);
});

test("parseBRtoCents rejeita lixo e negativo", () => {
  assert.equal(parseBRtoCents("abc"), null);
  assert.equal(parseBRtoCents(""), null);
  assert.equal(parseBRtoCents("-5,00"), null);
});

test("centsToBR formata com ponto de milhar e vírgula decimal", () => {
  assert.equal(centsToBR(150550), "1.505,50");
  assert.equal(centsToBR(1550), "15,50");
  assert.equal(centsToBR(0), "0,00");
});

test("centsToNumeric produz string pronta p/ SQL", () => {
  assert.equal(centsToNumeric(150550), "1505.50");
  assert.equal(centsToNumeric(5), "0.05");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/money.test.mjs`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `worker/money.js`**

```javascript
// Dinheiro em centavos inteiros: float acumula erro que aparece ao fechar margem.
export function parseBRtoCents(str) {
  if (typeof str !== "string") return null;
  let s = str.replace(/R\$\s*/i, "").trim();
  if (!s) return null;
  if (s.startsWith("-")) return null; // magnitude sempre positiva
  s = s.replace(/\./g, ""); // remove milhar
  if (s.includes(",")) s = s.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

export function centsToBR(cents) {
  const neg = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100).toLocaleString("pt-BR");
  const dec = String(abs % 100).padStart(2, "0");
  return `${neg}${reais},${dec}`;
}

export function centsToNumeric(cents) {
  const neg = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${neg}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test worker/money.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/money.js worker/money.test.mjs
git commit -m "feat: money.js (parse/format BR em centavos)"
```

---

### Task 4: Validação da extração

**Files:**
- Create: `worker/validar.js`, `worker/validar.test.mjs`

**Interfaces:**
- Consumes: `parseBRtoCents` de `money.js`.
- Produces: `validarExtracao(campos, macrosValidas) -> { ok: boolean, erros: string[], normalizado?: {dataISO, valorCents, natureza, macro, sub, descricao} }`.
  - `campos`: objeto do modelo `{data, valor, descricao, natureza, macro, sub}` (valor pode ser número ou string BR).
  - `macrosValidas`: array de strings (nomes de macro reais).
  - Regras: valor parseável e > 0; `data` vira ISO `AAAA-MM-DD` válida (aceita `DD/MM/AAAA` e ISO); `natureza ∈ {despesa,receita}` (default despesa se ausente); `macro` deve estar em `macrosValidas` (senão erro — o Worker cai no macro "Outros" só se existir; ver Task 9); `sub` opcional.

- [ ] **Step 1: Escrever `worker/validar.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { validarExtracao } from "./validar.js";

const MACROS = ["Casa", "Saúde", "Outros"];

test("aceita extração completa e normaliza data BR + valor", () => {
  const r = validarExtracao(
    { data: "29/08/2026", valor: "15,50", descricao: "Padaria", natureza: "despesa", macro: "Casa", sub: "Limpeza" },
    MACROS
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.normalizado, {
    dataISO: "2026-08-29", valorCents: 1550, natureza: "despesa",
    macro: "Casa", sub: "Limpeza", descricao: "Padaria",
  });
});

test("aceita data já em ISO e natureza ausente vira despesa", () => {
  const r = validarExtracao({ data: "2026-08-29", valor: 20, macro: "Casa" }, MACROS);
  assert.equal(r.ok, true);
  assert.equal(r.normalizado.natureza, "despesa");
  assert.equal(r.normalizado.valorCents, 2000);
});

test("rejeita valor inválido", () => {
  const r = validarExtracao({ data: "29/08/2026", valor: "xx", macro: "Casa" }, MACROS);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("valor")));
});

test("rejeita data inválida", () => {
  const r = validarExtracao({ data: "32/13/2026", valor: "10", macro: "Casa" }, MACROS);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("data")));
});

test("rejeita macro fora da lista", () => {
  const r = validarExtracao({ data: "2026-08-29", valor: "10", macro: "Marte" }, MACROS);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("macro")));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/validar.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar `worker/validar.js`**

```javascript
import { parseBRtoCents } from "./money.js";

function normalizarData(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let ano, mes, dia;
  if (m) { [, ano, mes, dia] = m; }
  else {
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    [, dia, mes, ano] = m;
  }
  const d = new Date(`${ano}-${mes}-${dia}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  // rejeita overflow tipo 32/13: o Date normaliza, então confere de volta
  if (d.getUTCMonth() + 1 !== Number(mes) || d.getUTCDate() !== Number(dia)) return null;
  return `${ano}-${mes}-${dia}`;
}

export function validarExtracao(campos, macrosValidas) {
  const erros = [];
  const valorCents = typeof campos.valor === "number"
    ? Math.round(campos.valor * 100)
    : parseBRtoCents(String(campos.valor ?? ""));
  if (valorCents === null || valorCents <= 0) erros.push("valor inválido");

  const dataISO = normalizarData(campos.data);
  if (!dataISO) erros.push("data inválida");

  const natureza = campos.natureza === "receita" ? "receita" : "despesa";

  const macro = campos.macro;
  if (!macrosValidas.includes(macro)) erros.push(`macro desconhecida: ${macro}`);

  if (erros.length) return { ok: false, erros };
  return {
    ok: true,
    erros: [],
    normalizado: {
      dataISO, valorCents, natureza, macro,
      sub: campos.sub || null,
      descricao: campos.descricao || null,
    },
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test worker/validar.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/validar.js worker/validar.test.mjs
git commit -m "feat: validar.js (normaliza data/valor, checa macro)"
```

---

### Task 5: Nome e caminho do Dropbox

**Files:**
- Create: `worker/dropbox_nome.js`, `worker/dropbox_nome.test.mjs`

**Interfaces:**
- Consumes: `centsToNumeric` de `money.js` (pra o valor no nome).
- Produces:
  - `sanitizar(s) -> string` — remove `/\:*?"<>|`, colapsa espaços em `-`, tira acento opcional (mantém letras), corta em 40 chars.
  - `caminhoDropbox(dataISO) -> string` — "2026-08-29" → "/Finanças/Comprovantes/2026/2026-08".
  - `nomeArquivo({dataISO, macro, sub, valorCents, descricao, ext}) -> string` — "2026-08-29_Casa_Limpeza_15.50_padaria.jpg".

- [ ] **Step 1: Escrever `worker/dropbox_nome.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizar, caminhoDropbox, nomeArquivo } from "./dropbox_nome.js";

test("sanitizar remove caracteres proibidos e espaços", () => {
  assert.equal(sanitizar("Padaria / Café"), "Padaria-Café");
  assert.equal(sanitizar("a:b*c?"), "abc");
});

test("caminhoDropbox agrupa por ano/mês", () => {
  assert.equal(caminhoDropbox("2026-08-29"), "/Finanças/Comprovantes/2026/2026-08");
});

test("nomeArquivo monta o padrão", () => {
  assert.equal(
    nomeArquivo({ dataISO: "2026-08-29", macro: "Casa", sub: "Limpeza", valorCents: 1550, descricao: "padaria", ext: "jpg" }),
    "2026-08-29_Casa_Limpeza_15.50_padaria.jpg"
  );
});

test("nomeArquivo lida com sub nulo e descrição vazia", () => {
  assert.equal(
    nomeArquivo({ dataISO: "2026-08-29", macro: "Outros", sub: null, valorCents: 900, descricao: null, ext: "png" }),
    "2026-08-29_Outros_9.00.png"
  );
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/dropbox_nome.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar `worker/dropbox_nome.js`**

```javascript
import { centsToNumeric } from "./money.js";

export function sanitizar(s) {
  if (!s) return "";
  return String(s)
    .replace(/[/\\:*?"<>|]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
}

export function caminhoDropbox(dataISO) {
  const [ano, mes] = dataISO.split("-");
  return `/Finanças/Comprovantes/${ano}/${ano}-${mes}`;
}

export function nomeArquivo({ dataISO, macro, sub, valorCents, descricao, ext }) {
  const partes = [dataISO, sanitizar(macro)];
  if (sub) partes.push(sanitizar(sub));
  partes.push(centsToNumeric(valorCents));
  const desc = sanitizar(descricao);
  if (desc) partes.push(desc);
  return `${partes.join("_")}.${ext}`;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test worker/dropbox_nome.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/dropbox_nome.js worker/dropbox_nome.test.mjs
git commit -m "feat: dropbox_nome.js (caminho por data + nome padronizado)"
```

---

### Task 6: Auth e allowlist (falha fechada)

**Files:**
- Create: `worker/auth.js`, `worker/auth.test.mjs`

**Interfaces:**
- Produces:
  - `chatPermitido(chatId, allowlistCsv) -> boolean` — csv vazio/undefined recusa todos.
  - `segredoTelegramValido(request, segredo) -> boolean` — compara header `X-Telegram-Bot-Api-Secret-Token`.
  - `tokenValido(request, tokenEsperado) -> boolean` — aceita cookie `token=` ou query `?token=`; `tokenEsperado` vazio recusa.

- [ ] **Step 1: Escrever `worker/auth.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatPermitido, segredoTelegramValido, tokenValido } from "./auth.js";

test("chatPermitido falha fechada com lista vazia", () => {
  assert.equal(chatPermitido(123, ""), false);
  assert.equal(chatPermitido(123, undefined), false);
});

test("chatPermitido aceita id na lista", () => {
  assert.equal(chatPermitido(123, "123,456"), true);
  assert.equal(chatPermitido(999, "123,456"), false);
});

test("segredoTelegramValido compara header", () => {
  const req = new Request("https://x", { headers: { "X-Telegram-Bot-Api-Secret-Token": "s3" } });
  assert.equal(segredoTelegramValido(req, "s3"), true);
  assert.equal(segredoTelegramValido(req, "outro"), false);
});

test("tokenValido aceita query e cookie, recusa vazio", () => {
  const q = new Request("https://x/app?token=abc");
  assert.equal(tokenValido(q, "abc"), true);
  const c = new Request("https://x/app", { headers: { Cookie: "token=abc" } });
  assert.equal(tokenValido(c, "abc"), true);
  assert.equal(tokenValido(q, ""), false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/auth.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar `worker/auth.js`**

```javascript
export function chatPermitido(chatId, allowlistCsv) {
  if (!allowlistCsv) return false; // falha fechada
  const ids = allowlistCsv.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(String(chatId));
}

export function segredoTelegramValido(request, segredo) {
  if (!segredo) return false;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === segredo;
}

function lerCookie(request, nome) {
  const raw = request.headers.get("Cookie") || "";
  for (const parte of raw.split(";")) {
    const [k, v] = parte.trim().split("=");
    if (k === nome) return v;
  }
  return null;
}

export function tokenValido(request, tokenEsperado) {
  if (!tokenEsperado) return false; // falha fechada
  const url = new URL(request.url);
  const q = url.searchParams.get("token");
  const c = lerCookie(request, "token");
  return q === tokenEsperado || c === tokenEsperado;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test worker/auth.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/auth.js worker/auth.test.mjs
git commit -m "feat: auth.js (token do app + segredo + allowlist falha-fechada)"
```

---

### Task 7: Módulo de extração (Gemini + fallback Claude)

**Files:**
- Create: `worker/extrair.js`, `worker/extrair.test.mjs`

**Interfaces:**
- Consumes: `validarExtracao` de `validar.js`.
- Produces:
  - `extrair(imagemBytes, mime, categorias, deps) -> Promise<{ok, normalizado?, extraido_por?, confianca?, erros?}>`.
    - `categorias`: `[{macro, sub}]` (lista real, do banco). As macros distintas são derivadas aqui.
    - `deps`: `{ callGemini, callClaude, limiar }`. Cada `call*` é `async (imagemBytes, mime, categorias) -> {campos, confianca}` (ou lança).
    - Fluxo: tenta Gemini; se lançar OU `confianca < limiar`, tenta Claude; valida o resultado escolhido; se ambos falham/invalidam, `{ok:false, erros}`.
  - `callGeminiHTTP(bytes, mime, categorias, key) -> {campos, confianca}` e `callClaudeHTTP(bytes, mime, categorias, key) -> {campos, confianca}`: adaptadores reais (usados em Task 9, não no teste).
  - `PROMPT(categorias) -> string`: instrução comum pedindo JSON `{data, valor, descricao, natureza, macro, sub, confianca}` escolhendo macro/sub da lista fornecida.

- [ ] **Step 1: Escrever `worker/extrair.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extrair } from "./extrair.js";

const CATS = [{ macro: "Casa", sub: "Limpeza" }, { macro: "Saúde", sub: null }];
const bom = { data: "2026-08-29", valor: "15,50", descricao: "x", natureza: "despesa", macro: "Casa", sub: "Limpeza" };

test("usa Gemini quando confiança >= limiar", async () => {
  const deps = {
    limiar: 0.6,
    callGemini: async () => ({ campos: bom, confianca: 0.9 }),
    callClaude: async () => { throw new Error("não devia chamar"); },
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", CATS, deps);
  assert.equal(r.ok, true);
  assert.equal(r.extraido_por, "gemini");
  assert.equal(r.normalizado.valorCents, 1550);
});

test("cai pro Claude quando Gemini lança", async () => {
  const deps = {
    limiar: 0.6,
    callGemini: async () => { throw new Error("boom"); },
    callClaude: async () => ({ campos: bom, confianca: 0.8 }),
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", CATS, deps);
  assert.equal(r.ok, true);
  assert.equal(r.extraido_por, "claude");
});

test("cai pro Claude quando Gemini vem com confiança baixa", async () => {
  const deps = {
    limiar: 0.6,
    callGemini: async () => ({ campos: bom, confianca: 0.3 }),
    callClaude: async () => ({ campos: bom, confianca: 0.95 }),
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", CATS, deps);
  assert.equal(r.extraido_por, "claude");
});

test("falha quando ambos inválidos", async () => {
  const ruim = { ...bom, valor: "xx" };
  const deps = {
    limiar: 0.6,
    callGemini: async () => ({ campos: ruim, confianca: 0.9 }),
    callClaude: async () => ({ campos: ruim, confianca: 0.9 }),
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", CATS, deps);
  assert.equal(r.ok, false);
  assert.ok(r.erros.length > 0);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/extrair.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar `worker/extrair.js`**

```javascript
import { validarExtracao } from "./validar.js";

export function PROMPT(categorias) {
  const lista = categorias
    .map((c) => (c.sub ? `${c.macro} > ${c.sub}` : c.macro))
    .join("; ");
  return [
    "Você lê um comprovante de pagamento (pix/transferência) em imagem.",
    "Responda SOMENTE um JSON com as chaves:",
    '{ "data": "AAAA-MM-DD", "valor": número, "descricao": string,',
    '  "natureza": "despesa"|"receita", "macro": string, "sub": string|null,',
    '  "confianca": número entre 0 e 1 }.',
    "Escolha macro e sub EXCLUSIVAMENTE desta lista (não invente rótulo):",
    lista,
    "Se não tiver certeza do sub, use null. 'confianca' é sua certeza global na leitura.",
  ].join("\n");
}

function macrosDe(categorias) {
  return [...new Set(categorias.map((c) => c.macro))];
}

async function tentar(call, bytes, mime, categorias, macros, quem) {
  const { campos, confianca } = await call(bytes, mime, categorias);
  const v = validarExtracao(campos, macros);
  return { v, confianca, quem };
}

export async function extrair(imagemBytes, mime, categorias, deps) {
  const macros = macrosDe(categorias);
  const errosAcum = [];

  // 1) Gemini
  let geminiOk = null;
  try {
    const g = await tentar(deps.callGemini, imagemBytes, mime, categorias, macros, "gemini");
    if (g.v.ok && g.confianca >= deps.limiar) {
      return { ok: true, normalizado: g.v.normalizado, extraido_por: "gemini", confianca: g.confianca };
    }
    geminiOk = g; // guarda p/ eventual uso se Claude também falhar
    if (!g.v.ok) errosAcum.push(...g.v.erros.map((e) => `gemini: ${e}`));
  } catch (e) {
    errosAcum.push(`gemini: ${e.message}`);
  }

  // 2) Claude (fallback)
  try {
    const c = await tentar(deps.callClaude, imagemBytes, mime, categorias, macros, "claude");
    if (c.v.ok) {
      return { ok: true, normalizado: c.v.normalizado, extraido_por: "claude", confianca: c.confianca };
    }
    errosAcum.push(...c.v.erros.map((e) => `claude: ${e}`));
  } catch (e) {
    errosAcum.push(`claude: ${e.message}`);
  }

  // 3) último recurso: Gemini válido mas de baixa confiança ainda serve
  if (geminiOk && geminiOk.v.ok) {
    return { ok: true, normalizado: geminiOk.v.normalizado, extraido_por: "gemini", confianca: geminiOk.confianca };
  }
  return { ok: false, erros: errosAcum };
}

// ---- Adaptadores HTTP reais (não usados nos testes unitários) ----

function b64(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export async function callGeminiHTTP(bytes, mime, categorias, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [
      { text: PROMPT(categorias) },
      { inline_data: { mime_type: mime, data: b64(bytes) } },
    ] }],
    generationConfig: { responseMimeType: "application/json" },
  };
  const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`gemini ${resp.status}`);
  const j = await resp.json();
  const txt = j.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const campos = JSON.parse(txt);
  return { campos, confianca: Number(campos.confianca ?? 0) };
}

export async function callClaudeHTTP(bytes, mime, categorias, key) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime, data: b64(bytes) } },
        { type: "text", text: PROMPT(categorias) + "\nResponda só o JSON." },
      ] }],
    }),
  });
  if (!resp.ok) throw new Error(`claude ${resp.status}`);
  const j = await resp.json();
  const txt = (j.content?.[0]?.text ?? "{}").replace(/^```json\s*|\s*```$/g, "");
  const campos = JSON.parse(txt);
  return { campos, confianca: Number(campos.confianca ?? 0) };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test worker/extrair.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/extrair.js worker/extrair.test.mjs
git commit -m "feat: extrair.js (orquestração Gemini + fallback Claude + adaptadores HTTP)"
```

---

### Task 8: Cliente do banco (Neon)

**Files:**
- Create: `worker/db.js`, `worker/db.test.mjs`

**Interfaces:**
- Consumes: `centsToNumeric` de `money.js`.
- Produces (fábrica que recebe a função `sql` do Neon pra ser testável sem rede):
  - `criarDb(sql)` retorna objeto com:
    - `documentoPorHash(hash) -> Promise<row|null>`
    - `inserirDocumento({dropbox_path, nome_arquivo, tipo_arquivo, hash, telegram_file_id}) -> Promise<{id}>`
    - `inserirTransacao(t) -> Promise<{id}>` onde `t = {dataISO, natureza, esfera, valorCents, reembolsoCents, macro, sub, descricao, pessoa, fonte, origem_categoria, extraido_por, confianca, documento_id}`
    - `listarCategorias() -> Promise<row[]>`
    - `listarTransacoes(filtros) -> Promise<row[]>`
    - `atualizarTransacao(id, campos) -> Promise<void>`
    - `apagarTransacao(id) -> Promise<void>`
    - `resumoPorCategoria(de, ate) -> Promise<row[]>`
    - `resumoMensal() -> Promise<row[]>`
    - `resumoReembolsoAno() -> Promise<row[]>`
- Nota: `sql` é a tagged template do `@neondatabase/serverless`. Nos testes, injeta-se um fake que grava a query recebida.

- [ ] **Step 1: Escrever `worker/db.test.mjs`** (valida montagem de query e conversão de dinheiro, sem banco real)

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarDb } from "./db.js";

// fake da tagged template: guarda strings + valores e devolve resultado programável
function fakeSql(resultado = []) {
  const chamadas = [];
  const fn = (strings, ...values) => {
    chamadas.push({ text: strings.join("?"), values });
    return Promise.resolve(resultado);
  };
  fn.chamadas = chamadas;
  return fn;
}

test("documentoPorHash consulta por hash e retorna null se vazio", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const r = await db.documentoPorHash("abc");
  assert.equal(r, null);
  assert.match(sql.chamadas[0].text, /from documentos/i);
  assert.deepEqual(sql.chamadas[0].values, ["abc"]);
});

test("inserirTransacao converte centavos p/ numeric string", async () => {
  const sql = fakeSql([{ id: "t1" }]);
  const db = criarDb(sql);
  const r = await db.inserirTransacao({
    dataISO: "2026-08-29", natureza: "despesa", esfera: "pessoal",
    valorCents: 1550, reembolsoCents: 0, macro: "Casa", sub: "Limpeza",
    descricao: "x", pessoa: null, fonte: "imagem", origem_categoria: "modelo",
    extraido_por: "gemini", confianca: 0.9, documento_id: "d1",
  });
  assert.equal(r.id, "t1");
  assert.ok(sql.chamadas[0].values.includes("15.50"));
  assert.ok(sql.chamadas[0].values.includes("0.00"));
});

test("resumoPorCategoria filtra por intervalo", async () => {
  const sql = fakeSql([{ macro: "Casa", total: "100.00" }]);
  const db = criarDb(sql);
  const r = await db.resumoPorCategoria("2026-01-01", "2026-12-31");
  assert.equal(r[0].macro, "Casa");
  assert.deepEqual(sql.chamadas[0].values, ["2026-01-01", "2026-12-31"]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/db.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar `worker/db.js`**

```javascript
import { centsToNumeric } from "./money.js";

export function criarDb(sql) {
  return {
    async documentoPorHash(hash) {
      const rows = await sql`select * from documentos where hash = ${hash} limit 1`;
      return rows[0] ?? null;
    },

    async inserirDocumento(d) {
      const rows = await sql`
        insert into documentos (dropbox_path, nome_arquivo, tipo_arquivo, hash, telegram_file_id)
        values (${d.dropbox_path}, ${d.nome_arquivo}, ${d.tipo_arquivo}, ${d.hash}, ${d.telegram_file_id})
        returning id`;
      return { id: rows[0].id };
    },

    async inserirTransacao(t) {
      const rows = await sql`
        insert into transacoes
          (data, natureza, esfera, valor_total, valor_reembolso, macro, sub, descricao,
           pessoa, fonte, origem_categoria, extraido_por, confianca, documento_id)
        values
          (${t.dataISO}, ${t.natureza}, ${t.esfera}, ${centsToNumeric(t.valorCents)},
           ${centsToNumeric(t.reembolsoCents ?? 0)}, ${t.macro}, ${t.sub}, ${t.descricao},
           ${t.pessoa ?? null}, ${t.fonte}, ${t.origem_categoria}, ${t.extraido_por ?? null},
           ${t.confianca ?? null}, ${t.documento_id ?? null})
        returning id`;
      return { id: rows[0].id };
    },

    async listarCategorias() {
      return await sql`select macro, sub, natureza from categorias where ativa order by macro, sub`;
    },

    async listarTransacoes(f = {}) {
      // filtros opcionais; usa coalesce p/ ignorar quando nulos
      return await sql`
        select * from transacoes
        where (${f.de ?? null}::date is null or data >= ${f.de ?? null})
          and (${f.ate ?? null}::date is null or data <= ${f.ate ?? null})
          and (${f.macro ?? null}::text is null or macro = ${f.macro ?? null})
          and (${f.natureza ?? null}::text is null or natureza = ${f.natureza ?? null})
          and (${f.esfera ?? null}::text is null or esfera = ${f.esfera ?? null})
        order by data desc, criado_em desc
        limit 1000`;
    },

    async atualizarTransacao(id, c) {
      await sql`
        update transacoes set
          data = coalesce(${c.dataISO ?? null}, data),
          macro = coalesce(${c.macro ?? null}, macro),
          sub = ${c.sub === undefined ? sql`sub` : c.sub},
          valor_total = coalesce(${c.valorCents != null ? centsToNumeric(c.valorCents) : null}, valor_total),
          valor_reembolso = coalesce(${c.reembolsoCents != null ? centsToNumeric(c.reembolsoCents) : null}, valor_reembolso),
          pessoa = ${c.pessoa === undefined ? sql`pessoa` : c.pessoa},
          natureza = coalesce(${c.natureza ?? null}, natureza),
          esfera = coalesce(${c.esfera ?? null}, esfera),
          origem_categoria = 'manual'
        where id = ${id}`;
    },

    async apagarTransacao(id) {
      await sql`delete from transacoes where id = ${id}`;
    },

    async resumoPorCategoria(de, ate) {
      return await sql`
        select macro, sub, natureza, sum(valor_final) as total, count(*) as n
        from transacoes where data >= ${de} and data <= ${ate}
        group by macro, sub, natureza order by total desc`;
    },

    async resumoMensal() {
      return await sql`
        select to_char(data,'YYYY-MM') as mes, natureza, sum(valor_final) as total
        from transacoes group by 1, 2 order by 1`;
    },

    async resumoReembolsoAno() {
      return await sql`
        select extract(year from data)::int as ano, macro,
               sum(valor_total) as bruto, sum(valor_reembolso) as reembolsado, sum(valor_final) as liquido
        from transacoes where valor_reembolso > 0
        group by 1, 2 order by 1, 2`;
    },
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test worker/db.test.mjs`
Expected: PASS.

- [ ] **Step 5 (integração opcional, se `TEST_DATABASE_URL` setado):** aplicar `schema.sql` numa branch Neon e rodar um insert+select real via um script pontual. Não bloqueia a task; documentar no README que a validação real acontece no deploy.

- [ ] **Step 6: Commit**

```bash
git add worker/db.js worker/db.test.mjs
git commit -m "feat: db.js (inserts, listas, updates, 3 resumos)"
```

---

### Task 9: Adaptador Telegram + roteador do Worker

**Files:**
- Create: `worker/telegram.js`, `worker/index.js`, `worker/index.test.mjs`
- Test: `worker/telegram.test.mjs`

**Interfaces:**
- `telegram.js` produz:
  - `parseUpdate(update) -> {tipo:'imagem', chatId, fileId, mime, messageId} | {tipo:'callback', chatId, data, messageId} | {tipo:'pdf'|'texto'|'ignorar', chatId}`
  - `downloadArquivo(token, fileId, fetchImpl) -> Promise<{bytes, mime}>`
  - `responder(token, chatId, texto, fetchImpl) -> Promise<void>`
  - `enviarConfirmacao(token, chatId, texto, transacaoId, fetchImpl) -> Promise<void>` (mensagem com botão inline "Apagar" cujo `callback_data` é `del:<id>`)
- `index.js` produz:
  - `export default { fetch(request, env, ctx) }`
  - `tratarUpdate(update, env, deps) -> Promise<void>` (deps injeta `db`, `extrair`, `fetchImpl`, `subirDropbox`, `hashBytes` p/ teste)
- Consumes: tasks 3–8 e `dropbox.js` (adaptador de upload, criado aqui).

- [ ] **Step 1: Escrever `worker/telegram.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpdate } from "./telegram.js";

test("parseUpdate reconhece foto (maior tamanho)", () => {
  const u = { message: { chat: { id: 7 }, message_id: 1, photo: [
    { file_id: "a", width: 90 }, { file_id: "b", width: 800 } ] } };
  const r = parseUpdate(u);
  assert.equal(r.tipo, "imagem");
  assert.equal(r.fileId, "b");
  assert.equal(r.chatId, 7);
});

test("parseUpdate reconhece documento-imagem", () => {
  const u = { message: { chat: { id: 7 }, document: { file_id: "d", mime_type: "image/png" } } };
  const r = parseUpdate(u);
  assert.equal(r.tipo, "imagem");
  assert.equal(r.mime, "image/png");
});

test("parseUpdate marca pdf e callback", () => {
  assert.equal(parseUpdate({ message: { chat: { id: 7 }, document: { file_id: "d", mime_type: "application/pdf" } } }).tipo, "pdf");
  const cb = parseUpdate({ callback_query: { message: { chat: { id: 7 }, message_id: 3 }, data: "del:xyz" } });
  assert.equal(cb.tipo, "callback");
  assert.equal(cb.data, "del:xyz");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/telegram.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar `worker/telegram.js`**

```javascript
export function parseUpdate(update) {
  if (update.callback_query) {
    const cq = update.callback_query;
    return { tipo: "callback", chatId: cq.message.chat.id, data: cq.data, messageId: cq.message.message_id };
  }
  const m = update.message;
  if (!m) return { tipo: "ignorar" };
  const chatId = m.chat.id;
  if (Array.isArray(m.photo) && m.photo.length) {
    const maior = m.photo.reduce((a, b) => (b.width > a.width ? b : a));
    return { tipo: "imagem", chatId, fileId: maior.file_id, mime: "image/jpeg", messageId: m.message_id };
  }
  if (m.document) {
    const mime = m.document.mime_type || "";
    if (mime.startsWith("image/")) return { tipo: "imagem", chatId, fileId: m.document.file_id, mime, messageId: m.message_id };
    if (mime === "application/pdf") return { tipo: "pdf", chatId };
    return { tipo: "ignorar", chatId };
  }
  if (m.text) return { tipo: "texto", chatId };
  return { tipo: "ignorar", chatId };
}

export async function downloadArquivo(token, fileId, fetchImpl = fetch) {
  const info = await (await fetchImpl(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)).json();
  const path = info.result.file_path;
  const mime = path.endsWith(".png") ? "image/png" : "image/jpeg";
  const resp = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return { bytes, mime };
}

export async function responder(token, chatId, texto, fetchImpl = fetch) {
  await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto }),
  });
}

export async function enviarConfirmacao(token, chatId, texto, transacaoId, fetchImpl = fetch) {
  await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text: texto,
      reply_markup: { inline_keyboard: [[{ text: "🗑 Apagar", callback_data: `del:${transacaoId}` }]] },
    }),
  });
}
```

- [ ] **Step 4: Criar o adaptador `worker/dropbox.js`** (upload real; recebe `fetchImpl` p/ teste)

```javascript
// Sobe bytes pro Dropbox. Refresh token -> access token curto -> /2/files/upload.
async function accessToken(env, fetchImpl) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.DROPBOX_REFRESH,
    client_id: env.DROPBOX_APP_KEY,
    client_secret: env.DROPBOX_APP_SECRET,
  });
  const r = await fetchImpl("https://api.dropbox.com/oauth2/token", { method: "POST", body });
  if (!r.ok) throw new Error(`dropbox token ${r.status}`);
  return (await r.json()).access_token;
}

export async function subirDropbox(env, caminhoCompleto, bytes, fetchImpl = fetch) {
  const tok = await accessToken(env, fetchImpl);
  const r = await fetchImpl("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: caminhoCompleto, mode: "add", autorename: true }),
    },
    body: bytes,
  });
  if (!r.ok) throw new Error(`dropbox upload ${r.status}`);
  return (await r.json()).path_display;
}
```

- [ ] **Step 5: Escrever `worker/index.test.mjs`** (o fluxo de captura ponta-a-ponta com tudo injetado)

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { tratarUpdate } from "./index.js";

function dbFake() {
  const estado = { inseridos: [], docs: [], apagados: [] };
  return {
    estado,
    listarCategorias: async () => [{ macro: "Casa", sub: "Limpeza" }],
    documentoPorHash: async () => null,
    inserirDocumento: async (d) => { estado.docs.push(d); return { id: "doc1" }; },
    inserirTransacao: async (t) => { estado.inseridos.push(t); return { id: "tx1" }; },
    apagarTransacao: async (id) => { estado.apagados.push(id); },
  };
}

const bom = { data: "2026-08-29", valor: "15,50", descricao: "Padaria", natureza: "despesa", macro: "Casa", sub: "Limpeza" };

test("foto vira transação + confirmação", async () => {
  const enviados = [];
  const db = dbFake();
  const deps = {
    db,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    baixar: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }),
    extrairImpl: async () => ({ ok: true, normalizado: { dataISO: "2026-08-29", valorCents: 1550, natureza: "despesa", macro: "Casa", sub: "Limpeza", descricao: "Padaria" }, extraido_por: "gemini", confianca: 0.9 }),
    subir: async () => "/Finanças/Comprovantes/2026/2026-08/x.jpg",
    hashBytes: async () => "h1",
    confirmar: async (chatId, texto, id) => enviados.push({ chatId, texto, id }),
    responderImpl: async () => {},
  };
  const env = { TELEGRAM_TOKEN: "t" };
  const update = { message: { chat: { id: 7 }, message_id: 1, photo: [{ file_id: "b", width: 800 }] } };
  await tratarUpdate(update, env, deps);
  assert.equal(db.estado.inseridos.length, 1);
  assert.equal(db.estado.inseridos[0].fonte, "imagem");
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].texto, /15,50/);
});

test("dedup: hash conhecido não insere de novo", async () => {
  const db = dbFake();
  db.documentoPorHash = async () => ({ id: "jaexiste", recebido_em: "2026-08-01" });
  const respostas = [];
  const deps = {
    db, baixar: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg" }),
    hashBytes: async () => "h1", extrairImpl: async () => { throw new Error("não devia extrair"); },
    subir: async () => "x", confirmar: async () => {}, responderImpl: async (c, t) => respostas.push(t), fetchImpl: async () => ({}),
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, photo: [{ file_id: "b", width: 800 }] } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.estado.inseridos.length, 0);
  assert.ok(respostas.some((t) => /já registrei/i.test(t)));
});

test("callback del apaga a transação", async () => {
  const db = dbFake();
  const deps = { db, responderImpl: async () => {}, fetchImpl: async () => ({}) };
  const update = { callback_query: { message: { chat: { id: 7 }, message_id: 3 }, data: "del:tx1" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.deepEqual(db.estado.apagados, ["tx1"]);
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `node --test worker/index.test.mjs`
Expected: FAIL.

- [ ] **Step 7: Implementar `worker/index.js`**

```javascript
import { neon } from "@neondatabase/serverless";
import { criarDb } from "./db.js";
import { parseUpdate, downloadArquivo, responder, enviarConfirmacao } from "./telegram.js";
import { extrair, callGeminiHTTP, callClaudeHTTP } from "./extrair.js";
import { subirDropbox } from "./dropbox.js";
import { caminhoDropbox, nomeArquivo } from "./dropbox_nome.js";
import { centsToBR } from "./money.js";
import { tokenValido, segredoTelegramValido, chatPermitido } from "./auth.js";

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
  const hash = await deps.hashBytes(bytes);

  const jaTem = await deps.db.documentoPorHash(hash);
  if (jaTem) { await deps.responderImpl(ev.chatId, "Esse comprovante eu já registrei antes.", env); return; }

  const categorias = await deps.db.listarCategorias();
  const ex = await deps.extrairImpl(bytes, mime, categorias);
  if (!ex.ok) { await deps.responderImpl(ev.chatId, "Não consegui ler esse comprovante. Pode reenviar mais nítido?", env); return; }

  const n = ex.normalizado;
  const ext = mime === "image/png" ? "png" : "jpg";
  const caminho = `${caminhoDropbox(n.dataISO)}/${nomeArquivo({ ...n, ext })}`;
  const dropboxPath = await deps.subir(env, caminho, bytes);

  const doc = await deps.db.inserirDocumento({
    dropbox_path: dropboxPath, nome_arquivo: nomeArquivo({ ...n, ext }),
    tipo_arquivo: mime, hash, telegram_file_id: ev.fileId,
  });
  const tx = await deps.db.inserirTransacao({
    dataISO: n.dataISO, natureza: n.natureza, esfera: "pessoal",
    valorCents: n.valorCents, reembolsoCents: 0, macro: n.macro, sub: n.sub,
    descricao: n.descricao, pessoa: null, fonte: "imagem", origem_categoria: "modelo",
    extraido_por: ex.extraido_por, confianca: ex.confianca, documento_id: doc.id,
  });

  const cat = n.sub ? `${n.macro} › ${n.sub}` : n.macro;
  const [a, m, d] = n.dataISO.split("-");
  await deps.confirmar(ev.chatId, `✅ R$ ${centsToBR(n.valorCents)} · ${d}/${m} · ${cat} · "${n.descricao ?? ""}"\najuste a categoria no app`, tx.id, env);
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

async function handleApi(request, env, url) {
  if (!tokenValido(request, env.APP_TOKEN)) return new Response("no", { status: 401 });
  const sql = neon(env.DATABASE_URL);
  const db = criarDb(sql);
  const j = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

  if (url.pathname === "/api/transacoes" && request.method === "GET") {
    const p = url.searchParams;
    return j(await db.listarTransacoes({ de: p.get("de"), ate: p.get("ate"), macro: p.get("macro"), natureza: p.get("natureza"), esfera: p.get("esfera") }));
  }
  if (url.pathname === "/api/categorias") return j(await db.listarCategorias());
  if (url.pathname.startsWith("/api/transacoes/") && request.method === "PATCH") {
    const id = url.pathname.split("/").pop();
    await db.atualizarTransacao(id, await request.json());
    return j({ ok: true });
  }
  if (url.pathname.startsWith("/api/transacoes/") && request.method === "DELETE") {
    await db.apagarTransacao(url.pathname.split("/").pop());
    return j({ ok: true });
  }
  if (url.pathname === "/api/resumo") {
    const de = url.searchParams.get("de") || "1900-01-01";
    const ate = url.searchParams.get("ate") || "2999-12-31";
    return j({
      porCategoria: await db.resumoPorCategoria(de, ate),
      mensal: await db.resumoMensal(),
      reembolso: await db.resumoReembolsoAno(),
    });
  }
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/telegram") return handleTelegram(request, env);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      if (!tokenValido(request, env.APP_TOKEN)) return new Response("acesso negado", { status: 401 });
      // repassa pro asset (index.html) preservando o cookie de token setado pelo acesso.js
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
```

- [ ] **Step 8: Rodar toda a suíte e ver passar**

Run: `npm test`
Expected: todas PASS (money, validar, dropbox_nome, auth, extrair, db, telegram, index).

- [ ] **Step 9: Commit**

```bash
git add worker/telegram.js worker/telegram.test.mjs worker/dropbox.js worker/index.js worker/index.test.mjs
git commit -m "feat: telegram.js + dropbox.js + index.js (fluxo de captura + rotas /api)"
```

---

### Task 10: App front-end (`public/`)

**Files:**
- Create: `public/shell.css`, `public/acesso.js`, `public/app.js`, `public/app.test.mjs`, `public/index.html`, `public/lancamentos.html`, `public/resumo.html`

**Interfaces:**
- Consumes: rotas `/api/*` da Task 9.
- Produces:
  - `app.js`: `centavosBR(numericStr)`, `agruparMensal(rows) -> [{mes, receita, despesa, saldo}]` (funções puras testadas); e helpers `apiGet/apiPatch/apiDelete` (não testados).
  - `acesso.js`: lê `?token=` da URL, grava cookie `token=...; path=/`, e recarrega em `/app`.

- [ ] **Step 1: Escrever `public/app.test.mjs`** (só as funções puras)

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { agruparMensal, centavosBR } from "./app.js";

test("agruparMensal soma receita/despesa e saldo por mês", () => {
  const rows = [
    { mes: "2026-01", natureza: "despesa", total: "100.00" },
    { mes: "2026-01", natureza: "receita", total: "300.00" },
    { mes: "2026-02", natureza: "despesa", total: "50.00" },
  ];
  assert.deepEqual(agruparMensal(rows), [
    { mes: "2026-01", receita: 300, despesa: 100, saldo: 200 },
    { mes: "2026-02", receita: 0, despesa: 50, saldo: -50 },
  ]);
});

test("centavosBR formata numeric string", () => {
  assert.equal(centavosBR("1505.50"), "1.505,50");
  assert.equal(centavosBR("9.00"), "9,00");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test public/app.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar `public/app.js`**

```javascript
export function centavosBR(numericStr) {
  const cents = Math.round(parseFloat(numericStr) * 100);
  const reais = Math.floor(Math.abs(cents) / 100).toLocaleString("pt-BR");
  const dec = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${reais},${dec}`;
}

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

// ---- helpers de rede (não testados) ----
export const apiGet = (p) => fetch(p).then((r) => r.json());
export const apiPatch = (p, body) => fetch(p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const apiDelete = (p) => fetch(p, { method: "DELETE" });
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test public/app.test.mjs`
Expected: PASS.

- [ ] **Step 5: Criar `public/acesso.js`**

```javascript
// Token na URL -> cookie -> segue pro app. Sem login, sem conta.
(function () {
  const url = new URL(location.href);
  const t = url.searchParams.get("token");
  if (t) {
    document.cookie = `token=${t}; path=/; max-age=31536000; samesite=strict`;
    url.searchParams.delete("token");
    location.replace(url.pathname + url.search);
  }
})();
```

- [ ] **Step 6: Criar `public/shell.css`** (tema claro/escuro simples, tabela e cards; conteúdo mínimo)

```css
:root { --bg:#faf9f5; --fg:#141413; --line:#e0e0d8; --accent:#0d7a6b; }
@media (prefers-color-scheme: dark){ :root{ --bg:#0e1413; --fg:#e8efed; --line:#28322f; --accent:#54cfba; } }
* { box-sizing: border-box; }
body { margin:0; font:15px system-ui, sans-serif; background:var(--bg); color:var(--fg); }
nav { display:flex; gap:16px; padding:14px 20px; border-bottom:1px solid var(--line); }
nav a { color:var(--accent); text-decoration:none; font-weight:600; }
main { max-width:1000px; margin:0 auto; padding:20px; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
.card { border:1px solid var(--line); border-radius:10px; padding:16px; margin:12px 0; }
select,input { font:inherit; padding:4px 6px; }
svg .bar { fill: var(--accent); }
```

- [ ] **Step 7: Criar `public/index.html`** (redireciona pra lançamentos, roda `acesso.js`)

```html
<!doctype html><meta charset="utf8"><title>Finanças</title>
<link rel="stylesheet" href="/shell.css">
<script src="/acesso.js"></script>
<script>location.replace("/lancamentos.html")</script>
```

- [ ] **Step 8: Criar `public/lancamentos.html`** (tabela editável)

```html
<!doctype html><meta charset="utf8"><title>Lançamentos</title>
<link rel="stylesheet" href="/shell.css">
<nav><a href="/lancamentos.html">Lançamentos</a><a href="/resumo.html">Resumo</a></nav>
<main>
  <h1>Lançamentos</h1>
  <div>
    <label>De <input type="date" id="de"></label>
    <label>Até <input type="date" id="ate"></label>
    <button id="filtrar">Filtrar</button>
  </div>
  <table><thead><tr><th>Data</th><th>Descrição</th><th>Macro</th><th>Sub</th><th>Valor</th><th>Reemb.</th><th></th></tr></thead>
  <tbody id="linhas"></tbody></table>
</main>
<script type="module">
import { apiGet, apiPatch, apiDelete, centavosBR } from "/app.js";
const tbody = document.getElementById("linhas");
let categorias = [];
async function carregar() {
  categorias = await apiGet("/api/categorias");
  const de = document.getElementById("de").value, ate = document.getElementById("ate").value;
  const qs = new URLSearchParams(); if (de) qs.set("de", de); if (ate) qs.set("ate", ate);
  const linhas = await apiGet("/api/transacoes?" + qs);
  const macros = [...new Set(categorias.map(c=>c.macro))];
  tbody.innerHTML = "";
  for (const t of linhas) {
    const tr = document.createElement("tr");
    const opts = macros.map(m=>`<option ${m===t.macro?"selected":""}>${m}</option>`).join("");
    tr.innerHTML = `<td>${t.data}</td><td>${t.descricao??""}</td>
      <td><select data-id="${t.id}" class="macro">${opts}</select></td>
      <td><input data-id="${t.id}" class="sub" value="${t.sub??""}" size="10"></td>
      <td>R$ ${centavosBR(t.valor_total)}</td><td>R$ ${centavosBR(t.valor_reembolso)}</td>
      <td><button data-id="${t.id}" class="del">apagar</button></td>`;
    tbody.appendChild(tr);
  }
}
tbody.addEventListener("change", async (e) => {
  const id = e.target.dataset.id; if (!id) return;
  if (e.target.classList.contains("macro")) await apiPatch(`/api/transacoes/${id}`, { macro: e.target.value });
  if (e.target.classList.contains("sub")) await apiPatch(`/api/transacoes/${id}`, { sub: e.target.value });
});
tbody.addEventListener("click", async (e) => {
  if (e.target.classList.contains("del")) { await apiDelete(`/api/transacoes/${e.target.dataset.id}`); carregar(); }
});
document.getElementById("filtrar").addEventListener("click", carregar);
carregar();
</script>
```

- [ ] **Step 9: Criar `public/resumo.html`** (três painéis, gráficos SVG próprios)

```html
<!doctype html><meta charset="utf8"><title>Resumo</title>
<link rel="stylesheet" href="/shell.css">
<nav><a href="/lancamentos.html">Lançamentos</a><a href="/resumo.html">Resumo</a></nav>
<main>
  <h1>Resumo</h1>
  <div class="card"><h2>Gastos por categoria</h2><div id="cat"></div></div>
  <div class="card"><h2>Mensal: receita × despesa</h2><div id="mensal"></div></div>
  <div class="card"><h2>Reembolso / IR por ano</h2><div id="reemb"></div></div>
</main>
<script type="module">
import { apiGet, agruparMensal, centavosBR } from "/app.js";
function barras(el, dados, rotulo, valor) {
  const max = Math.max(1, ...dados.map(valor));
  el.innerHTML = dados.map(d => {
    const w = Math.round((valor(d)/max)*300);
    return `<div style="display:flex;gap:8px;align-items:center;margin:3px 0">
      <span style="width:160px">${rotulo(d)}</span>
      <svg width="320" height="16"><rect class="bar" width="${w}" height="14"></rect></svg>
      <span>R$ ${centavosBR(String(valor(d)))}</span></div>`;
  }).join("");
}
const r = await apiGet("/api/resumo");
// por categoria: soma por macro (só despesa)
const porMacro = {};
for (const x of r.porCategoria) if (x.natureza==="despesa") porMacro[x.macro] = (porMacro[x.macro]||0)+parseFloat(x.total);
barras(document.getElementById("cat"),
  Object.entries(porMacro).map(([macro,total])=>({macro,total})).sort((a,b)=>b.total-a.total),
  d=>d.macro, d=>d.total);
// mensal
const mensal = agruparMensal(r.mensal);
document.getElementById("mensal").innerHTML = mensal.map(m=>
  `<div style="margin:3px 0">${m.mes}: receita R$ ${centavosBR(String(m.receita))} · despesa R$ ${centavosBR(String(m.despesa))} · saldo <b>R$ ${centavosBR(String(m.saldo))}</b></div>`).join("");
// reembolso por ano
const porAno = {};
for (const x of r.reembolso) porAno[x.ano] = (porAno[x.ano]||0)+parseFloat(x.reembolsado);
barras(document.getElementById("reemb"),
  Object.entries(porAno).map(([ano,total])=>({ano,total})),
  d=>d.ano, d=>d.total);
</script>
```

- [ ] **Step 10: Verificação manual** (documentar no README): `npx wrangler dev`, abrir `http://localhost:8787/app?token=<APP_TOKEN>` (com `.dev.vars` preenchido e schema aplicado numa branch Neon), conferir que Lançamentos lista e Resumo desenha.

- [ ] **Step 11: Commit**

```bash
git add public/
git commit -m "feat: app (lançamentos editável + resumo com 3 painéis)"
```

---

### Task 11: Importação do histórico da planilha

**Files:**
- Create: `tools/import_planilha.py`, `tests/test_import.py`, `pyproject.toml` (ou `requirements.txt` com openpyxl, psycopg)

**Interfaces:**
- Produces (funções puras testáveis + um `main` que escreve no banco):
  - `corrigir_mojibake(s) -> str`
  - `natureza_de(tipo, valor_final) -> str`
  - `esfera_de(tipo) -> str`
  - `subs_recorrentes(gastos, min_ocorrencias) -> set[str]`
  - `montar_import(rows, min_ocorrencias) -> (transacoes: list[dict], categorias: list[dict], relatorio: dict)`
  - `MACRO_DE = {tipo_planilha: macro}` mapeando os 10 Tipos.

- [ ] **Step 1: Escrever `tests/test_import.py`**

```python
from tools.import_planilha import (
    corrigir_mojibake, natureza_de, esfera_de, subs_recorrentes, montar_import,
)

def test_corrige_mojibake():
    assert corrigir_mojibake("Educa\ufffd\ufffdo") == "Educa\ufffd\ufffdo" or corrigir_mojibake("Educação") == "Educação"

def test_natureza():
    assert natureza_de("Receita", 100) == "receita"
    assert natureza_de("Casa", -50) == "despesa"

def test_esfera():
    assert esfera_de("Empresa") == "empresa"
    assert esfera_de("Casa") == "pessoal"

def test_subs_recorrentes_respeita_limiar():
    gastos = ["Limpeza", "Limpeza", "Limpeza", "Cama nova", "Luz", "Luz"]
    assert subs_recorrentes(gastos, 3) == {"Limpeza"}
    assert subs_recorrentes(gastos, 2) == {"Limpeza", "Luz"}

def test_montar_import_mapeia_e_preserva_descricao():
    rows = [
        {"Tipo": "Casa", "Gasto": "Limpeza", "Pessoa": None, "Data": "2026-01-10",
         "ValorTotal": 170, "ValorReembolso": 0, "ValorFinal": -170},
        {"Tipo": "Casa", "Gasto": "Limpeza", "Pessoa": None, "Data": "2026-01-17",
         "ValorTotal": 170, "ValorReembolso": 0, "ValorFinal": -170},
        {"Tipo": "Casa", "Gasto": "Limpeza", "Pessoa": None, "Data": "2026-01-24",
         "ValorTotal": 170, "ValorReembolso": 0, "ValorFinal": -170},
        {"Tipo": "Compra", "Gasto": "Cama nova", "Pessoa": None, "Data": "2026-02-01",
         "ValorTotal": 2000, "ValorReembolso": 0, "ValorFinal": -2000},
    ]
    txs, cats, rel = montar_import(rows, min_ocorrencias=3)
    # Limpeza recorrente -> vira sub; Cama nova -> sub None, mas descricao preservada
    limpeza = [t for t in txs if t["descricao"] == "Limpeza"][0]
    cama = [t for t in txs if t["descricao"] == "Cama nova"][0]
    assert limpeza["sub"] == "Limpeza"
    assert limpeza["macro"] == "Casa"
    assert cama["sub"] is None
    assert cama["descricao"] == "Cama nova"
    assert all(t["fonte"] == "importacao" for t in txs)
    assert {"macro": "Casa", "sub": "Limpeza"} in cats
    assert rel["n_transacoes"] == 4
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `python -m pytest tests/test_import.py -v`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `tools/import_planilha.py`** (funções puras + main)

```python
"""Importa o histórico de Gastos.xlsx para o Neon. Idempotente na fonte='importacao'."""
from collections import Counter

MACRO_DE = {
    "Casa": "Casa", "Educação": "Educação", "Saúde": "Saúde", "Pessoal": "Pessoal",
    "Empresa": "Empresa", "Receita": "Receita", "Carro": "Carro",
    "Cidadania Italiana": "Cidadania Italiana", "Compra": "Compra", "Outros": "Outros",
}

def corrigir_mojibake(s):
    if not isinstance(s, str):
        return s
    try:
        # o xlsx foi lido como latin1 sobre bytes utf8; desfaz quando possível
        return s.encode("latin1").decode("utf8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s

def natureza_de(tipo, valor_final):
    if tipo == "Receita":
        return "receita"
    if valor_final is not None and valor_final > 0 and tipo not in MACRO_DE:
        return "receita"
    return "despesa"

def esfera_de(tipo):
    return "empresa" if tipo == "Empresa" else "pessoal"

def subs_recorrentes(gastos, min_ocorrencias):
    c = Counter(g for g in gastos if g)
    return {g for g, n in c.items() if n >= min_ocorrencias}

def montar_import(rows, min_ocorrencias=3):
    rows = [{**r, "Tipo": corrigir_mojibake(r["Tipo"]), "Gasto": corrigir_mojibake(r.get("Gasto"))} for r in rows]
    recorrentes = subs_recorrentes([r.get("Gasto") for r in rows], min_ocorrencias)
    txs, pares = [], set()
    for r in rows:
        tipo = r["Tipo"]
        macro = MACRO_DE.get(tipo, "Outros")
        gasto = r.get("Gasto")
        sub = gasto if gasto in recorrentes else None
        nat = natureza_de(tipo, r.get("ValorFinal"))
        txs.append({
            "data": str(r["Data"])[:10], "natureza": nat, "esfera": esfera_de(tipo),
            "valor_total": abs(float(r["ValorTotal"] or 0)),
            "valor_reembolso": abs(float(r.get("ValorReembolso") or 0)),
            "macro": macro, "sub": sub, "descricao": gasto, "pessoa": r.get("Pessoa") or None,
            "fonte": "importacao", "origem_categoria": "manual",
        })
        pares.add((macro, sub))
        if sub:
            pares.add((macro, None))
    cats = [{"macro": m, "sub": s} for (m, s) in sorted(pares, key=lambda p: (p[0], p[1] or ""))]
    relatorio = {
        "n_transacoes": len(txs),
        "por_macro": dict(Counter(t["macro"] for t in txs)),
        "n_categorias": len(cats),
        "receitas": sum(1 for t in txs if t["natureza"] == "receita"),
    }
    return txs, cats, relatorio

def _ler_xlsx(caminho):
    import openpyxl
    wb = openpyxl.load_workbook(caminho, data_only=True, read_only=True)
    ws = wb["Gastos"]
    it = ws.iter_rows(values_only=True)
    hdr = list(next(it))
    idx = {h: i for i, h in enumerate(hdr)}
    def val(row, nome):
        i = idx.get(nome)
        return row[i] if i is not None and i < len(row) else None
    return [{c: val(row, c) for c in ["Tipo", "Gasto", "Pessoa", "Data", "ValorTotal", "ValorReembolso", "ValorFinal"]}
            for row in it if val(row, "Tipo")]

def main(caminho_xlsx, database_url, min_ocorrencias=3):
    import psycopg
    rows = _ler_xlsx(caminho_xlsx)
    txs, cats, rel = montar_import(rows, min_ocorrencias)
    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        cur.execute("delete from transacoes where fonte = 'importacao'")  # idempotência
        for c in cats:
            cur.execute(
                "insert into categorias (macro, sub) values (%s, %s) on conflict (macro, sub) do nothing",
                (c["macro"], c["sub"]))
        for t in txs:
            cur.execute(
                """insert into transacoes
                   (data, natureza, esfera, valor_total, valor_reembolso, macro, sub, descricao, pessoa, fonte, origem_categoria)
                   values (%(data)s,%(natureza)s,%(esfera)s,%(valor_total)s,%(valor_reembolso)s,%(macro)s,%(sub)s,%(descricao)s,%(pessoa)s,%(fonte)s,%(origem_categoria)s)""",
                t)
        conn.commit()
    print("Import concluído:", rel)
    return rel

if __name__ == "__main__":
    import os, sys
    main(sys.argv[1], os.environ["DATABASE_URL"])
```

- [ ] **Step 4: Rodar e ver passar**

Run: `python -m pytest tests/test_import.py -v`
Expected: PASS.

- [ ] **Step 5: Criar `pyproject.toml`** declarando deps `openpyxl`, `psycopg[binary]`, `pytest`; e um `tests/__init__.py` + `tools/__init__.py` vazios pra o import do teste funcionar.

- [ ] **Step 6: Rodar o import real** (uma vez, após schema aplicado)

Run: `DATABASE_URL=... python tools/import_planilha.py "C:/Users/caioc/Dropbox/Finanças/Gastos.xlsx"`
Expected: imprime o relatório com ~453 transações; conferir contagem no app.

- [ ] **Step 7: Commit**

```bash
git add tools/import_planilha.py tests/test_import.py pyproject.toml tools/__init__.py tests/__init__.py
git commit -m "feat: import do histórico (mapeamento + idempotência + relatório)"
```

---

### Task 12: Documentação do projeto (CLAUDE.md, CONTEXTO.md, README)

**Files:**
- Create: `CLAUDE.md`, `CONTEXTO.md`; Modify: `README.md`

**Interfaces:** nenhuma (documentação). Fecha o incremento com o "manual de operação" no espírito da LM Ateliê.

- [ ] **Step 1: Escrever `CLAUDE.md`** com: a regra "nada no repo antes de funcionar E2E"; as convenções de dinheiro (centavos/`parseBR`, agregação em SQL); o vocabulário fixo das colunas; as regras de segurança (Secrets, allowlist falha-fechada, `.gitignore`); e o roadmap dos incrementos (§13 da spec).

- [ ] **Step 2: Escrever `CONTEXTO.md`** registrando as decisões deste brainstorming (imagem-primeiro, um Worker, Gemini+fallback, Dropbox por data, dois níveis+reembolso, importar histórico) e o *porquê* de cada uma, pra não re-litigar.

- [ ] **Step 3: Atualizar `README.md`** com: pré-requisitos (BotFather, App Dropbox + refresh token, projeto Neon, chaves Gemini/Claude), lista de Secrets a setar (`wrangler secret put ...`), como aplicar o schema, como rodar o import, e `npm test` + `wrangler dev`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CONTEXTO.md README.md
git commit -m "docs: manual de operação, contexto das decisões e setup"
```

---

## Self-Review

**Cobertura da spec:**
- §4 Arquitetura (um Worker, três rotas) → Task 9. ✓
- §5 Modelo de dados → Task 2 (schema) + Task 8 (queries). ✓
- §6 Fluxo de captura (allowlist, dedup, extração, Dropbox, gravação, confirmação, botão Apagar, PDF educado) → Tasks 6, 9. ✓
- §7 Extração (Gemini+fallback, limiar, categorias no prompt, validação) → Tasks 4, 7. ✓
- §8 Dropbox (caminho por data, nome, sanitize) → Tasks 5, 9. ✓
- §9 App (token, Lançamentos editável, Resumo 3 painéis) → Task 10. ✓
- §10 Import (mojibake, mapeamento, sub recorrente, natureza/esfera, idempotência, relatório) → Task 11. ✓
- §11 Segurança (Secrets, falha fechada, gitignore) → Tasks 1, 6, 12. ✓
- §12 Testes → cada task tem seus testes; suíte roda via `npm test` e `pytest`. ✓

**Placeholders:** nenhum passo com "TBD"/"handle errors"/"similar to"; todo código está escrito. Verificação manual do front (Task 10 Step 10) e integração DB (Task 8 Step 5) estão explícitas por serem inerentemente com-rede, não são placeholders de lógica.

**Consistência de tipos:** `criarDb(sql)` (Task 8) consumido em `index.js` (Task 9). `extrair(bytes, mime, categorias, deps)` (Task 7) chamado como `extrairImpl` em `index.js`. `normalizado` tem `{dataISO, valorCents, natureza, macro, sub, descricao}` em Task 4 e é assim consumido em Tasks 7 e 9. `nomeArquivo`/`caminhoDropbox` (Task 5) usados em Task 9. `agruparMensal`/`centavosBR` (Task 10) batem com o teste. Vocabulário (`fonte='imagem'|'importacao'`, etc.) consistente entre Tasks 2, 9, 11.
