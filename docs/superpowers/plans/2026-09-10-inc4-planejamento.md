# Incremento 4 — Planejamento orçamentário — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao Financas um valor alvo por categoria mês a mês, comparável com o gasto real, editável só num mês (exceção) ou de um mês em diante (baseline).

**Architecture:** Modelo baseline-com-vigência (`metas`) + exceção por mês (`metas_excecao`). A resolução "qual alvo vale neste mês" (precedência exceção > baseline mais recente ≤ mês > sem-alvo) e a média de sugestão vivem em `worker/metas.js` **puro** (sem banco/rede), testável. O SQL só busca dados crus e agrega o realizado (reusando a mesma fonte do Resumo). Duas fases: **A — tela do mês** (fatia E2E completa) → **B — grade categorias × meses** (aditiva).

**Tech Stack:** Cloudflare Workers (JS ESM), `@neondatabase/serverless`, Neon Postgres, HTML+JS vanilla (`public/app.js` é ESM com funções puras testadas). Testes: `node --test` (`npm test`).

**Spec:** `docs/superpowers/specs/2026-09-10-inc4-planejamento-design.md`

## Global Constraints

- Branch novo `inc4-planejamento` (não commitar no master direto).
- **Dinheiro em centavos na borda da API; agregação em SQL** (`numeric(12,2)`). `db.js` recebe centavos e converte com `centsToNumeric` (já importado em `worker/db.js:1`); leituras devolvem centavos via `(round(x*100))::bigint as ..._cents` (padrão já usado em `transacoesNaJanela`).
- Mês normalizado como `date` dia-01 (`'YYYY-MM-01'`); a API fala `'YYYY-MM'`.
- Alvo por **categoria (macro) de despesa**; sem subcategoria, sem pessoa, sem receita.
- Comentários e testes **em português**, explicando o *porquê*.
- Vocabulário fixo: novo `origem ∈ {excecao, baseline, sem-alvo}` (do alvo, não confundir com `origem_categoria`). `escopo ∈ {baseline, excecao}` nas escritas.
- ES modules. Rotas novas atrás do token, como todo `/api/*`.

---

## Estrutura de arquivos

```
migrations/0007_metas.sql   NOVO — tabelas metas + metas_excecao (aditiva)
schema.sql                  MODIFICAR — refletir as duas tabelas novas
worker/metas.js             NOVO — puro: alvoEfetivo, mediaSugestao, statusMeta, helpers de mês
worker/metas.test.mjs       NOVO — testes do módulo puro
worker/db.js                MODIFICAR — leituras/escritas de metas (fakeSql-testáveis)
worker/db.test.mjs          MODIFICAR — testes das queries de metas
worker/index.js             MODIFICAR — rotas /api/metas (GET mês, sugestao, PUT, DELETE) e (Fase B) /api/metas/grade
worker/index.test.mjs       MODIFICAR — testes das rotas via handleApi + fake
public/index.html           MODIFICAR — aba "Planejamento" + <section id="planejamento">
public/app.js               MODIFICAR — render da tela do mês + edição; (Fase B) grade
CLAUDE.md, CONTEXTO.md       MODIFICAR — status do Inc 4 + decisões
```

---

## FASE A — Tela do mês

### Task 1: `worker/metas.js` (módulo puro) + testes

**Files:**
- Create: `worker/metas.js`
- Test: `worker/metas.test.mjs`

**Interfaces:**
- Consumes: nada (puro).
- Produces:
  - `primeiroDiaDoMes(mes: 'YYYY-MM'|'YYYY-MM-DD') -> 'YYYY-MM-01'`
  - `mesAnterior(mes: 'YYYY-MM'|'YYYY-MM-DD', n=1) -> 'YYYY-MM'` (n negativo = meses à frente)
  - `alvoEfetivo(baselines, excecoes, categoriaId, mesDia01: 'YYYY-MM-01') -> { valorCents:number|null, origem:'excecao'|'baseline'|'sem-alvo' }`
    - `baselines`: `[{ categoria_id, vigente_desde:'YYYY-MM-01', valor_cents }]`
    - `excecoes`: `[{ categoria_id, mes:'YYYY-MM-01', valor_cents }]`
  - `mediaSugestao(realizadoPorMes: {'YYYY-MM': cents}, mes:'YYYY-MM', janela=3) -> number|null`
  - `statusMeta(realizadoCents, alvoCents:number|null) -> 'normal'|'aviso'|'estouro'|'sem-alvo'`

- [ ] **Step 1: Escrever os testes que falham** — `worker/metas.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { primeiroDiaDoMes, mesAnterior, alvoEfetivo, mediaSugestao, statusMeta } from "./metas.js";

test("primeiroDiaDoMes normaliza p/ dia-01", () => {
  assert.equal(primeiroDiaDoMes("2026-09"), "2026-09-01");
  assert.equal(primeiroDiaDoMes("2026-09-17"), "2026-09-01");
});

test("mesAnterior anda pra trás e (n negativo) pra frente, virando o ano", () => {
  assert.equal(mesAnterior("2026-03", 1), "2026-02");
  assert.equal(mesAnterior("2026-01", 1), "2025-12");
  assert.equal(mesAnterior("2026-01", 3), "2025-10");
  assert.equal(mesAnterior("2026-11", -2), "2027-01"); // 2 à frente
});

// baselines: cada um "vale a partir de vigente_desde", propaga pra frente até um mais novo
const baselines = [
  { categoria_id: "c1", vigente_desde: "2026-01-01", valor_cents: 100000 },
  { categoria_id: "c1", vigente_desde: "2026-06-01", valor_cents: 150000 },
];
const excecoes = [
  { categoria_id: "c1", mes: "2026-08-01", valor_cents: 200000 },
];

test("alvoEfetivo: exceção vence tudo naquele mês", () => {
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "c1", "2026-08-01"),
    { valorCents: 200000, origem: "excecao" });
});

test("alvoEfetivo: baseline mais recente <= mês", () => {
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "c1", "2026-05-01"),
    { valorCents: 100000, origem: "baseline" });
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "c1", "2026-07-01"),
    { valorCents: 150000, origem: "baseline" });
});

test("alvoEfetivo: exceção NÃO propaga (mês seguinte volta ao baseline)", () => {
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "c1", "2026-09-01"),
    { valorCents: 150000, origem: "baseline" });
});

test("alvoEfetivo: mês antes de qualquer baseline → sem-alvo", () => {
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "c1", "2025-12-01"),
    { valorCents: null, origem: "sem-alvo" });
});

test("alvoEfetivo: categoria sem nenhuma meta → sem-alvo", () => {
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "cX", "2026-07-01"),
    { valorCents: null, origem: "sem-alvo" });
});

test("mediaSugestao: média dos 3 meses anteriores presentes, arredondada em centavos", () => {
  const real = { "2026-06": 100000, "2026-07": 110000, "2026-08": 90100 };
  // (100000+110000+90100)/3 = 100033.33 → 100033
  assert.equal(mediaSugestao(real, "2026-09", 3), 100033);
});

test("mediaSugestao: janela com meses faltando usa só os presentes", () => {
  const real = { "2026-08": 90000 }; // só 1 dos 3 anteriores
  assert.equal(mediaSugestao(real, "2026-09", 3), 90000);
});

test("mediaSugestao: nenhum mês anterior com dado → null", () => {
  assert.equal(mediaSugestao({ "2026-09": 50000 }, "2026-09", 3), null);
});

test("statusMeta: faixas normal/aviso/estouro e sem-alvo", () => {
  assert.equal(statusMeta(50000, null), "sem-alvo");
  assert.equal(statusMeta(50000, 100000), "normal");   // 50%
  assert.equal(statusMeta(80000, 100000), "aviso");     // 80%
  assert.equal(statusMeta(100001, 100000), "estouro");  // >100%
  assert.equal(statusMeta(1, 0), "estouro");            // alvo 0 e gastou
  assert.equal(statusMeta(0, 0), "normal");             // alvo 0 e nada gasto
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL (`Cannot find module './metas.js'`).

- [ ] **Step 3: Implementar** — `worker/metas.js`:

```js
// Inc 4: planejamento. Puro (sem banco/rede) — tudo entra por parâmetro, p/ auditar o número.
// Dinheiro em centavos inteiros; datas ISO comparadas lexicograficamente (YYYY-MM-DD ordena certo).

// 'YYYY-MM' ou 'YYYY-MM-DD' → 'YYYY-MM-01' (primeiro dia do mês).
export function primeiroDiaDoMes(mes) {
  return mes.slice(0, 7) + "-01";
}

// n meses antes de `mes`; n negativo = meses à frente. Vira o ano via aritmética de índice.
export function mesAnterior(mes, n = 1) {
  const [a, m] = mes.slice(0, 7).split("-").map(Number);
  const idx = a * 12 + (m - 1) - n;
  const ano = Math.floor(idx / 12);
  const mm = ((idx % 12) + 12) % 12 + 1; // 1..12, seguro p/ índice negativo
  return `${ano}-${String(mm).padStart(2, "0")}`;
}

// Alvo efetivo de (categoria, mês). Precedência: exceção > baseline mais recente <= mês > sem-alvo.
export function alvoEfetivo(baselines, excecoes, categoriaId, mesDia01) {
  const exc = (excecoes || []).find(e => e.categoria_id === categoriaId && e.mes === mesDia01);
  if (exc) return { valorCents: exc.valor_cents, origem: "excecao" };
  const cands = (baselines || [])
    .filter(b => b.categoria_id === categoriaId && b.vigente_desde <= mesDia01)
    .sort((x, y) => (x.vigente_desde < y.vigente_desde ? 1 : -1)); // desc: mais recente primeiro
  if (cands.length) return { valorCents: cands[0].valor_cents, origem: "baseline" };
  return { valorCents: null, origem: "sem-alvo" };
}

// Média (centavos, arredondada) do realizado dos `janela` meses ANTERIORES a `mes`.
// Conta só os meses presentes em realizadoPorMes; nenhum presente → null.
export function mediaSugestao(realizadoPorMes, mes, janela = 3) {
  const vals = [];
  for (let i = 1; i <= janela; i++) {
    const m = mesAnterior(mes, i);
    if (realizadoPorMes[m] != null) vals.push(realizadoPorMes[m]);
  }
  if (!vals.length) return null;
  return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
}

// Faixa visual do consumo do alvo. Sem alvo → 'sem-alvo'; >100% → 'estouro'; >=80% → 'aviso'; senão 'normal'.
export function statusMeta(realizadoCents, alvoCents) {
  if (alvoCents == null) return "sem-alvo";
  if (alvoCents === 0) return realizadoCents > 0 ? "estouro" : "normal";
  const frac = realizadoCents / alvoCents;
  if (frac > 1) return "estouro";
  if (frac >= 0.8) return "aviso";
  return "normal";
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS (todos os testes de `metas.test.mjs`).

- [ ] **Step 5: Commit**

```bash
git add worker/metas.js worker/metas.test.mjs
git commit -m "feat: metas.js — resolução de alvo, média de sugestão e status (puro)"
```

---

### Task 2: Migração `0007_metas.sql` + `schema.sql`

**Files:**
- Create: `migrations/0007_metas.sql`
- Modify: `schema.sql` (adicionar as duas tabelas ao fim)

**Interfaces:**
- Produces: tabelas `metas(categoria_id, vigente_desde, valor_alvo, criado_em)` e `metas_excecao(categoria_id, mes, valor_alvo, criado_em)`.

- [ ] **Step 1: Escrever a migração** — `migrations/0007_metas.sql`:

```sql
-- Inc 4: planejamento orçamentário. Aditiva. Alvo por categoria (despesa), mês a mês.

-- baseline: "a partir de vigente_desde, o alvo desta categoria é V" (propaga pra frente
-- até um baseline mais novo). Alterar toda a sequência futura = inserir baseline no mês atual.
create table if not exists metas (
  categoria_id  uuid not null references categorias(id),
  vigente_desde date not null,                        -- sempre dia 01 do mês
  valor_alvo    numeric(12,2) not null check (valor_alvo >= 0),
  criado_em     timestamptz not null default now(),
  primary key (categoria_id, vigente_desde)
);

-- exceção: "só neste mês o alvo é V" (NÃO propaga). Alterar um mês pontual.
create table if not exists metas_excecao (
  categoria_id uuid not null references categorias(id),
  mes          date not null,                         -- sempre dia 01 do mês
  valor_alvo   numeric(12,2) not null check (valor_alvo >= 0),
  criado_em    timestamptz not null default now(),
  primary key (categoria_id, mes)
);
```

- [ ] **Step 2: Refletir em `schema.sql`** — colar as mesmas duas definições `create table` ao final do arquivo (sem `if not exists`, no estilo do resto do `schema.sql`), com um comentário `-- Inc 4: planejamento`.

- [ ] **Step 3: Aplicar no Neon e verificar** — aplicar via o mesmo mecanismo dos Incs anteriores (`DATABASE_URL` do `.dev.vars`, sem exibir; psycopg ou `psql -f migrations/0007_metas.sql`). Verificar:
  - `select to_regclass('public.metas'), to_regclass('public.metas_excecao');` → ambas não-nulas.
  - `insert`/`select`/`delete` de teste numa categoria real (ex.: pegar um `id` de `select id from categorias where nome='Casa'`), depois limpar.

- [ ] **Step 4: Commit**

```bash
git add migrations/0007_metas.sql schema.sql
git commit -m "feat: migração 0007 (metas + metas_excecao)"
```

---

### Task 3: `db.js` — leituras e escritas de metas + testes

**Files:**
- Modify: `worker/db.js` (adicionar métodos ao objeto retornado por `criarDb`)
- Test: `worker/db.test.mjs`

**Interfaces:**
- Consumes: `sql` (tagged template do Neon), `centsToNumeric` (já importado em `worker/db.js:1`).
- Produces (métodos do db):
  - `metasBaselines() -> [{ categoria_id, vigente_desde:'YYYY-MM-01', valor_cents }]`
  - `metasExcecoes() -> [{ categoria_id, mes:'YYYY-MM-01', valor_cents }]`
  - `realizadoPorCategoriaMes(de, ateExcl) -> [{ categoria_id, mes:'YYYY-MM', realizado_cents }]` (janela meio-aberta `[de, ateExcl)`, datas `'YYYY-MM-DD'`)
  - `setBaseline(categoria_id, mesDia01, valorCents)` / `setExcecao(categoria_id, mesDia01, valorCents)` (upsert)
  - `apagarBaseline(categoria_id, mesDia01)` / `apagarExcecao(categoria_id, mesDia01)`

- [ ] **Step 1: Escrever os testes que falham** — acrescentar ao fim de `worker/db.test.mjs`:

```js
test("metasBaselines lê baselines em centavos", async () => {
  const sql = fakeSql([{ categoria_id: "c1", vigente_desde: "2026-01-01", valor_cents: 100000 }]);
  const db = criarDb(sql);
  const r = await db.metasBaselines();
  assert.equal(r[0].valor_cents, 100000);
  assert.match(sql.chamadas[0].text, /from metas/i);
  assert.match(sql.chamadas[0].text, /round\(valor_alvo\*100\)/i);
});

test("realizadoPorCategoriaMes: só despesa+computa_resumo, janela meio-aberta", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.realizadoPorCategoriaMes("2026-06-01", "2026-09-01");
  const c = sql.chamadas[0];
  assert.match(c.text, /natureza = 'despesa'/i);
  assert.match(c.text, /computa_resumo/i);
  assert.match(c.text, /data >= .* and .*data < /is);
  assert.deepEqual(c.values, ["2026-06-01", "2026-09-01"]);
});

test("setBaseline faz upsert convertendo centavos → numeric", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.setBaseline("c1", "2026-09-01", 150000);
  const c = sql.chamadas[0];
  assert.match(c.text, /insert into metas/i);
  assert.match(c.text, /on conflict .*do update/is);
  assert.ok(c.values.includes("c1"));
  assert.ok(c.values.includes("2026-09-01"));
  assert.ok(c.values.includes("1500.00"));
});

test("setExcecao faz upsert em metas_excecao", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.setExcecao("c1", "2026-08-01", 200000);
  const c = sql.chamadas[0];
  assert.match(c.text, /insert into metas_excecao/i);
  assert.ok(c.values.includes("2000.00"));
});

test("apagarExcecao remove pela chave (categoria, mes)", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.apagarExcecao("c1", "2026-08-01");
  const c = sql.chamadas[0];
  assert.match(c.text, /delete from metas_excecao/i);
  assert.deepEqual(c.values, ["c1", "2026-08-01"]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL (`db.metasBaselines is not a function`).

- [ ] **Step 3: Implementar** — adicionar estes métodos dentro do objeto retornado por `criarDb` em `worker/db.js` (perto dos `resumo*`, mantendo o estilo):

```js
    // ---- Inc 4: planejamento (metas) ----
    async metasBaselines() {
      return await sql`
        select categoria_id, to_char(vigente_desde,'YYYY-MM-01') as vigente_desde,
               (round(valor_alvo*100))::bigint as valor_cents
        from metas`;
    },

    async metasExcecoes() {
      return await sql`
        select categoria_id, to_char(mes,'YYYY-MM-01') as mes,
               (round(valor_alvo*100))::bigint as valor_cents
        from metas_excecao`;
    },

    // realizado (despesa, no resumo) por categoria e mês na janela meio-aberta [de, ateExcl).
    async realizadoPorCategoriaMes(de, ateExcl) {
      return await sql`
        select t.categoria_id, to_char(t.data,'YYYY-MM') as mes,
               (round(sum(t.valor_final)*100))::bigint as realizado_cents
        from transacoes t
        where t.natureza = 'despesa' and t.computa_resumo
          and t.data >= ${de} and t.data < ${ateExcl}
        group by t.categoria_id, to_char(t.data,'YYYY-MM')`;
    },

    async setBaseline(categoria_id, mesDia01, valorCents) {
      await sql`
        insert into metas (categoria_id, vigente_desde, valor_alvo)
        values (${categoria_id}, ${mesDia01}, ${centsToNumeric(valorCents)})
        on conflict (categoria_id, vigente_desde)
        do update set valor_alvo = excluded.valor_alvo, criado_em = now()`;
    },

    async setExcecao(categoria_id, mesDia01, valorCents) {
      await sql`
        insert into metas_excecao (categoria_id, mes, valor_alvo)
        values (${categoria_id}, ${mesDia01}, ${centsToNumeric(valorCents)})
        on conflict (categoria_id, mes)
        do update set valor_alvo = excluded.valor_alvo, criado_em = now()`;
    },

    async apagarBaseline(categoria_id, mesDia01) {
      await sql`delete from metas where categoria_id = ${categoria_id} and vigente_desde = ${mesDia01}`;
    },

    async apagarExcecao(categoria_id, mesDia01) {
      await sql`delete from metas_excecao where categoria_id = ${categoria_id} and mes = ${mesDia01}`;
    },
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/db.js worker/db.test.mjs
git commit -m "feat: db — leituras/escritas de metas (baseline, exceção, realizado por mês)"
```

---

### Task 4: Rotas `/api/metas` (mês, sugestão, PUT, DELETE) + testes

**Files:**
- Modify: `worker/index.js` (dentro de `handleApi`, e o import no topo)
- Test: `worker/index.test.mjs`

**Interfaces:**
- Consumes: `alvoEfetivo`, `mediaSugestao`, `statusMeta`, `primeiroDiaDoMes`, `mesAnterior` (Task 1); `db.catalogo`, `db.metasBaselines`, `db.metasExcecoes`, `db.realizadoPorCategoriaMes`, `db.setBaseline`, `db.setExcecao`, `db.apagarBaseline`, `db.apagarExcecao` (Task 3).
- Produces:
  - `GET /api/metas?mes=YYYY-MM` → `{ mes, linhas:[{categoria_id, categoria, alvo_cents, realizado_cents, diff_cents, origem, status}], total:{alvo_cents, realizado_cents, diff_cents} }`
  - `GET /api/metas/sugestao?mes=YYYY-MM` → `{ mes, linhas:[{categoria_id, sugestao_cents}] }`
  - `PUT /api/metas` body `{categoria_id, mes:'YYYY-MM', valor_cents, escopo}` → `{ ok:true }`
  - `DELETE /api/metas?categoria_id&mes=YYYY-MM&escopo` → `{ ok:true }`

- [ ] **Step 1: Escrever os testes que falham** — acrescentar ao fim de `worker/index.test.mjs`:

```js
// fake do db p/ as rotas de metas
function dbMetasFake(over = {}) {
  const estado = { baselines: [], excecoes: [], apagados: [] };
  return {
    estado,
    catalogo: async () => ({
      categorias: [
        { id: "c1", nome: "Casa", natureza: "despesa" },
        { id: "c2", nome: "Salário", natureza: "receita" }, // deve ser filtrada (só despesa)
      ],
      subcategorias: [],
    }),
    metasBaselines: async () => (over.baselines || [{ categoria_id: "c1", vigente_desde: "2026-01-01", valor_cents: 100000 }]),
    metasExcecoes: async () => (over.excecoes || []),
    realizadoPorCategoriaMes: async () => (over.realizado || [{ categoria_id: "c1", mes: "2026-09", realizado_cents: 80000 }]),
    setBaseline: async (cat, mes, v) => estado.baselines.push({ cat, mes, v }),
    setExcecao: async (cat, mes, v) => estado.excecoes.push({ cat, mes, v }),
    apagarBaseline: async (cat, mes) => estado.apagados.push({ tipo: "baseline", cat, mes }),
    apagarExcecao: async (cat, mes) => estado.apagados.push({ tipo: "excecao", cat, mes }),
  };
}
const envTok = { APP_TOKEN: "token123", DATABASE_URL: "" };
const cook = { "Cookie": "token=token123" };

test("GET /api/metas monta linha por categoria de despesa com alvo/realizado/status", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas?mes=2026-09", { headers: cook });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.equal(data.mes, "2026-09");
  assert.equal(data.linhas.length, 1); // 'Salário' (receita) filtrada
  const l = data.linhas[0];
  assert.equal(l.categoria, "Casa");
  assert.equal(l.alvo_cents, 100000);      // baseline de jan vale em set
  assert.equal(l.realizado_cents, 80000);
  assert.equal(l.diff_cents, 20000);
  assert.equal(l.origem, "baseline");
  assert.equal(l.status, "aviso");          // 80%
  assert.equal(data.total.alvo_cents, 100000);
  assert.equal(data.total.realizado_cents, 80000);
});

test("GET /api/metas: categoria sem baseline vem alvo_cents null e diff null", async () => {
  const db = dbMetasFake({ baselines: [] });
  const req = new Request("http://localhost/api/metas?mes=2026-09", { headers: cook });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.equal(data.linhas[0].alvo_cents, null);
  assert.equal(data.linhas[0].diff_cents, null);
  assert.equal(data.linhas[0].origem, "sem-alvo");
  assert.equal(data.total.alvo_cents, 0); // total soma só quem tem alvo
});

test("GET /api/metas rejeita mes inválido", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas?mes=2026", { headers: cook });
  const resp = await handleApi(req, envTok, new URL(req.url), db);
  assert.equal(resp.status, 400);
});

test("GET /api/metas/sugestao devolve média dos 3 meses anteriores por categoria", async () => {
  const db = dbMetasFake({ realizado: [
    { categoria_id: "c1", mes: "2026-06", realizado_cents: 100000 },
    { categoria_id: "c1", mes: "2026-07", realizado_cents: 110000 },
    { categoria_id: "c1", mes: "2026-08", realizado_cents: 90100 },
  ]});
  const req = new Request("http://localhost/api/metas/sugestao?mes=2026-09", { headers: cook });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.equal(data.linhas.find(x => x.categoria_id === "c1").sugestao_cents, 100033);
});

test("PUT /api/metas escopo baseline chama setBaseline com dia-01", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas", {
    method: "PUT", headers: { ...cook, "content-type": "application/json" },
    body: JSON.stringify({ categoria_id: "c1", mes: "2026-09", valor_cents: 150000, escopo: "baseline" }),
  });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.deepEqual(data, { ok: true });
  assert.deepEqual(db.estado.baselines, [{ cat: "c1", mes: "2026-09-01", v: 150000 }]);
});

test("PUT /api/metas escopo excecao chama setExcecao", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas", {
    method: "PUT", headers: { ...cook, "content-type": "application/json" },
    body: JSON.stringify({ categoria_id: "c1", mes: "2026-08", valor_cents: 200000, escopo: "excecao" }),
  });
  await handleApi(req, envTok, new URL(req.url), db);
  assert.deepEqual(db.estado.excecoes, [{ cat: "c1", mes: "2026-08-01", v: 200000 }]);
});

test("PUT /api/metas rejeita valor_cents negativo", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas", {
    method: "PUT", headers: { ...cook, "content-type": "application/json" },
    body: JSON.stringify({ categoria_id: "c1", mes: "2026-09", valor_cents: -1, escopo: "baseline" }),
  });
  const resp = await handleApi(req, envTok, new URL(req.url), db);
  assert.equal(resp.status, 400);
});

test("DELETE /api/metas escopo excecao chama apagarExcecao", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas?categoria_id=c1&mes=2026-08&escopo=excecao", { method: "DELETE", headers: cook });
  await handleApi(req, envTok, new URL(req.url), db);
  assert.deepEqual(db.estado.apagados, [{ tipo: "excecao", cat: "c1", mes: "2026-08-01" }]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL (rotas devolvem 404 / handlers ausentes).

- [ ] **Step 3: Implementar** — no topo de `worker/index.js`, adicionar ao lado dos outros imports:

```js
import { alvoEfetivo, mediaSugestao, statusMeta, primeiroDiaDoMes, mesAnterior } from "./metas.js";
```

Dentro de `handleApi`, logo após o bloco `if (url.pathname === "/api/resumo") { ... }` (linha ~221), inserir:

```js
  // ---- Inc 4: planejamento (metas) ----
  const mesValido = (m) => /^\d{4}-\d{2}$/.test(m || "");

  if (url.pathname === "/api/metas" && request.method === "GET") {
    const mes = url.searchParams.get("mes");
    if (!mesValido(mes)) return erroJson("mes inválido (use YYYY-MM)", 400);
    const dia01 = primeiroDiaDoMes(mes);
    const de = dia01, ateExcl = primeiroDiaDoMes(mesAnterior(mes, -1)); // [mês, mês+1)
    const [catalogo, baselines, excecoes, realizado] = await Promise.all([
      db.catalogo(), db.metasBaselines(), db.metasExcecoes(), db.realizadoPorCategoriaMes(de, ateExcl),
    ]);
    const realPorCat = {};
    for (const r of realizado) realPorCat[r.categoria_id] = r.realizado_cents;
    const linhas = catalogo.categorias
      .filter((c) => c.natureza === "despesa")
      .map((c) => {
        const { valorCents, origem } = alvoEfetivo(baselines, excecoes, c.id, dia01);
        const realizado_cents = realPorCat[c.id] || 0;
        const diff_cents = valorCents == null ? null : valorCents - realizado_cents;
        return { categoria_id: c.id, categoria: c.nome, alvo_cents: valorCents, realizado_cents,
                 diff_cents, origem, status: statusMeta(realizado_cents, valorCents) };
      });
    const total = linhas.reduce((acc, l) => {
      if (l.alvo_cents != null) acc.alvo_cents += l.alvo_cents;
      acc.realizado_cents += l.realizado_cents;
      return acc;
    }, { alvo_cents: 0, realizado_cents: 0 });
    total.diff_cents = total.alvo_cents - total.realizado_cents;
    return j({ mes, linhas, total });
  }

  if (url.pathname === "/api/metas/sugestao" && request.method === "GET") {
    const mes = url.searchParams.get("mes");
    if (!mesValido(mes)) return erroJson("mes inválido (use YYYY-MM)", 400);
    const de = primeiroDiaDoMes(mesAnterior(mes, 3)), ateExcl = primeiroDiaDoMes(mes); // [mês-3, mês)
    const [catalogo, realizado] = await Promise.all([db.catalogo(), db.realizadoPorCategoriaMes(de, ateExcl)]);
    const porCat = {};
    for (const r of realizado) (porCat[r.categoria_id] ||= {})[r.mes] = r.realizado_cents;
    const linhas = catalogo.categorias
      .filter((c) => c.natureza === "despesa")
      .map((c) => ({ categoria_id: c.id, sugestao_cents: mediaSugestao(porCat[c.id] || {}, mes, 3) }));
    return j({ mes, linhas });
  }

  if (url.pathname === "/api/metas" && request.method === "PUT") {
    const b = await body();
    if (!mesValido(b.mes)) return erroJson("mes inválido (use YYYY-MM)", 400);
    if (!Number.isInteger(b.valor_cents) || b.valor_cents < 0) return erroJson("valor_cents inválido", 400);
    if (!b.categoria_id) return erroJson("categoria_id obrigatório", 400);
    const dia01 = primeiroDiaDoMes(b.mes);
    if (b.escopo === "baseline") await db.setBaseline(b.categoria_id, dia01, b.valor_cents);
    else if (b.escopo === "excecao") await db.setExcecao(b.categoria_id, dia01, b.valor_cents);
    else return erroJson("escopo inválido (baseline|excecao)", 400);
    return j({ ok: true });
  }

  if (url.pathname === "/api/metas" && request.method === "DELETE") {
    const p = url.searchParams;
    if (!mesValido(p.get("mes"))) return erroJson("mes inválido (use YYYY-MM)", 400);
    if (!p.get("categoria_id")) return erroJson("categoria_id obrigatório", 400);
    const dia01 = primeiroDiaDoMes(p.get("mes"));
    if (p.get("escopo") === "baseline") await db.apagarBaseline(p.get("categoria_id"), dia01);
    else if (p.get("escopo") === "excecao") await db.apagarExcecao(p.get("categoria_id"), dia01);
    else return erroJson("escopo inválido (baseline|excecao)", 400);
    return j({ ok: true });
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/index.test.mjs
git commit -m "feat: rotas /api/metas (mês, sugestão, PUT/DELETE de alvo)"
```

---

### Task 5: UI — aba "Planejamento" (tela do mês)

**Files:**
- Modify: `public/index.html` (botão de aba + `<section>`)
- Modify: `public/app.js` (troca de aba + render + edição)

**Interfaces:**
- Consumes: `GET /api/metas?mes=`, `GET /api/metas/sugestao?mes=`, `PUT /api/metas`, `DELETE /api/metas` (Task 4); helpers `apiGet`/`apiPost`(via fetch PUT)/`apiDelete` já em `app.js` (linhas ~224–236).
- Produces: aba funcional; nenhuma nova função exportada obrigatória (o render é interno). Reusa `centavosBR` para exibir centavos.

- [ ] **Step 1: HTML** — em `public/index.html`, adicionar o botão de aba após o de Ajustes (linha ~24):

```html
      <button class="tab" data-view="planejamento">Planejamento</button>
```

e a seção após `<section id="ajustes" ...>` (linha ~129):

```html
  <section id="planejamento" class="hidden">
    <div class="planhead">
      <label>Mês <input type="month" id="planMes"></label>
      <button id="planSugerir" class="btn">Sugerir pra todas</button>
    </div>
    <table id="planTabela">
      <thead><tr><th>Categoria</th><th>Alvo</th><th>Realizado</th><th>Falta / Estourou</th></tr></thead>
      <tbody></tbody>
      <tfoot></tfoot>
    </table>
  </section>
```

- [ ] **Step 2: Troca de aba** — em `public/app.js`, no bloco de troca (linhas ~795–802), acrescentar a linha e carregar ao abrir:

```js
    $("#planejamento").classList.toggle("hidden", v !== "planejamento");
    if (v === "planejamento") renderPlanejamento();
```

- [ ] **Step 3: Render + edição** — adicionar em `public/app.js` (perto dos outros handlers de aba, ex.: após o bloco de `#ajustes`), usando os helpers `apiGet`/`apiDelete` e um PUT via `fetch`:

```js
  // ---- Inc 4: Planejamento (tela do mês) ----
  const mesCorrenteISO = () => new Date().toISOString().slice(0, 7);
  const apiPut = (p, body) => fetch(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(r => { if (!r.ok) throw new Error(`PUT ${p} ${r.status}`); return r; });

  async function renderPlanejamento() {
    const mesInput = $("#planMes");
    if (!mesInput.value) mesInput.value = mesCorrenteISO();
    const mes = mesInput.value;
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
        <td><input class="planAlvo" inputmode="decimal" value="${alvo}" placeholder="${placeholder}" data-sug="${sugPorCat[l.categoria_id] ?? ""}"></td>
        <td>${realizado}</td>
        <td class="status-${l.status}"><div class="planbar"><i style="width:${barra}%"></i></div>${diff}</td>
      </tr>`;
    }).join("");

    const tfoot = $("#planTabela tfoot");
    tfoot.innerHTML = `<tr><td>Total</td>
      <td>${centavosBR(dados.total.alvo_cents / 100 + "")}</td>
      <td>${centavosBR(dados.total.realizado_cents / 100 + "")}</td>
      <td>${dados.total.diff_cents >= 0 ? "falta" : "estourou"} ${centavosBR(Math.abs(dados.total.diff_cents) / 100 + "")}</td></tr>`;
  }

  // salvar alvo: pergunta o escopo (só este mês vs deste mês em diante)
  $("#planTabela").addEventListener("change", async (e) => {
    if (!e.target.classList.contains("planAlvo")) return;
    const tr = e.target.closest("tr");
    const categoria_id = tr.dataset.cat;
    const mes = $("#planMes").value;
    const raw = e.target.value.trim();
    if (raw === "") { // limpar → apaga exceção do mês (baseline permanece)
      await apiDelete(`/api/metas?categoria_id=${categoria_id}&mes=${mes}&escopo=excecao`).catch(() => {});
      return renderPlanejamento();
    }
    const cents = parseBRtoCentsUI(raw);
    if (cents == null) { alert("Valor inválido"); return renderPlanejamento(); }
    const soEste = confirm("OK = só este mês (exceção)\nCancelar = deste mês em diante (baseline)");
    const escopo = soEste ? "excecao" : "baseline";
    await apiPut(`/api/metas`, { categoria_id, mes, valor_cents: cents, escopo });
    renderPlanejamento();
  });

  // "Sugerir pra todas": pré-preenche os campos vazios com a sugestão; NÃO grava (Caio revisa e salva).
  $("#planSugerir").addEventListener("click", () => {
    $("#planTabela").querySelectorAll(".planAlvo").forEach(inp => {
      if (inp.value.trim() === "" && inp.dataset.sug) inp.value = centavosBR(Number(inp.dataset.sug) / 100 + "");
    });
  });

  $("#planMes").addEventListener("change", renderPlanejamento);
```

Notas p/ o executor:
- Use o helper `esc()` já existente em `app.js` para o nome da categoria. Se não houver um parser BR local no escopo, adicione um mínimo `parseBRtoCentsUI(str)` (vírgula/ponto → centavos) espelhando `centavosBR` — teclado brasileiro entrega vírgula (regra do `CLAUDE.md`).
- Estilos: adicionar em `public/index.html`/CSS as classes `.status-normal/.status-aviso/.status-estouro` (cor do texto/borda), `.planbar > i` (largura = % consumido), `.selo-excecao`. Aviso = amarelo, estouro = vermelho (limiares já vêm do backend em `status`).

- [ ] **Step 4: Verificação manual** (front não tem harness E2E; a API já está coberta):
  - `npx wrangler dev` (ou o fluxo de dev do projeto), abrir `/app?token=…`, aba **Planejamento**.
  - Mês corrente aparece; categorias de despesa listadas com realizado.
  - Definir um alvo → escolher "deste mês em diante" → recarregar mês seguinte: alvo aparece (baseline propagou).
  - Definir alvo no mês seguinte com "só este mês" → volta um mês: inalterado; selo "exceção" no mês editado.
  - "Sugerir pra todas" preenche campos vazios; salvar um deles grava.
  - Estouro: categoria com realizado > alvo fica vermelha; ≥80% amarela.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: aba Planejamento — tela do mês (alvo vs realizado, editar por escopo)"
```

---

### Task 6: Docs + checkpoint de infra (Fase A)

**Files:**
- Modify: `CLAUDE.md` (roadmap: Inc 4 → "implementado (Fase A)"; nota das tabelas `metas`/`metas_excecao`)
- Modify: `CONTEXTO.md` (nova seção "13. Incremento 4: planejamento — baseline+vigência+exceção", registrando o *porquê* das decisões aprovadas)

- [ ] **Step 1:** Atualizar `CLAUDE.md`: na tabela de roadmap, mudar o status do Inc 4 e adicionar as colunas novas numa nota curta (tabelas `metas`, `metas_excecao`; alvo por categoria de despesa; `origem`/`escopo`).
- [ ] **Step 2:** Acrescentar seção ao `CONTEXTO.md` explicando: por que baseline+vigência+exceção (preserva histórico, sem horizonte), por que resolução em JS puro, por que só despesa/macro, semear por média de 3 meses.
- [ ] **Step 3:** `npm test` — tudo verde.
- [ ] **Step 4:** Aplicar `0007` no Neon (se ainda não), deploy (`npm run deploy`), e conferir a aba no app ao vivo.
- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CONTEXTO.md
git commit -m "docs: Inc 4 Fase A — planejamento (roadmap + contexto)"
```

**Checkpoint Fase A:** `0007` aplicada, `npm test` verde, deploy feito, aba Planejamento funcional ao vivo (definir alvo, ver realizado, ajustar pontual/futuro). Fatia E2E entregue.

---

## FASE B — Grade categorias × meses

### Task 7: Rota `GET /api/metas/grade` + testes

**Files:**
- Modify: `worker/index.js`
- Test: `worker/index.test.mjs`

**Interfaces:**
- Consumes: mesmos helpers e métodos de db da Fase A.
- Produces: `GET /api/metas/grade?de=YYYY-MM&ate=YYYY-MM` → `{ meses:['YYYY-MM'...], categorias:[{categoria_id, categoria, celulas:[{mes, alvo_cents, origem, realizado_cents}]}] }`. Default sem `de`/`ate`: `de = mês corrente − 3`, `ate = mês corrente + 8` (12 colunas). `realizado_cents` = `null` em meses futuros.

- [ ] **Step 1: Testes que falham** — acrescentar em `worker/index.test.mjs`:

```js
test("GET /api/metas/grade monta meses e células com alvo e realizado", async () => {
  const db = dbMetasFake({
    baselines: [{ categoria_id: "c1", vigente_desde: "2026-01-01", valor_cents: 100000 }],
    realizado: [{ categoria_id: "c1", mes: "2026-08", realizado_cents: 90000 }],
  });
  const req = new Request("http://localhost/api/metas/grade?de=2026-08&ate=2026-10", { headers: cook });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.deepEqual(data.meses, ["2026-08", "2026-09", "2026-10"]);
  const c1 = data.categorias.find(c => c.categoria_id === "c1");
  assert.equal(c1.celulas.length, 3);
  assert.equal(c1.celulas[0].alvo_cents, 100000);       // baseline propaga
  assert.equal(c1.celulas[0].realizado_cents, 90000);   // ago (passado) tem realizado
});

test("GET /api/metas/grade: default de/ate = 12 meses (−3..+8) do mês corrente", async () => {
  const db = dbMetasFake({ baselines: [], realizado: [] });
  const req = new Request("http://localhost/api/metas/grade", { headers: cook });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.equal(data.meses.length, 12);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL (404 na rota da grade).

- [ ] **Step 3: Implementar** — em `worker/index.js`, junto às rotas de metas:

```js
  if (url.pathname === "/api/metas/grade" && request.method === "GET") {
    const p = url.searchParams;
    const hoje = new Date().toISOString().slice(0, 7);
    let de = p.get("de"), ate = p.get("ate");
    if (!mesValido(de)) de = mesAnterior(hoje, 3);    // 3 meses atrás
    if (!mesValido(ate)) ate = mesAnterior(hoje, -8); // 8 à frente
    const meses = [];
    for (let m = de; ; m = mesAnterior(m, -1)) { meses.push(m); if (m === ate || meses.length >= 60) break; }
    const deDia = primeiroDiaDoMes(de), ateExcl = primeiroDiaDoMes(mesAnterior(ate, -1));
    const [catalogo, baselines, excecoes, realizado] = await Promise.all([
      db.catalogo(), db.metasBaselines(), db.metasExcecoes(), db.realizadoPorCategoriaMes(deDia, ateExcl),
    ]);
    const realMap = {};
    for (const r of realizado) realMap[`${r.categoria_id}|${r.mes}`] = r.realizado_cents;
    const categorias = catalogo.categorias
      .filter((c) => c.natureza === "despesa")
      .map((c) => ({
        categoria_id: c.id, categoria: c.nome,
        celulas: meses.map((m) => {
          const { valorCents, origem } = alvoEfetivo(baselines, excecoes, c.id, primeiroDiaDoMes(m));
          const passadoOuCorrente = m <= hoje;
          return { mes: m, alvo_cents: valorCents, origem,
                   realizado_cents: passadoOuCorrente ? (realMap[`${c.id}|${m}`] || 0) : null };
        }),
      }));
    return j({ meses, categorias });
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/index.test.mjs
git commit -m "feat: rota /api/metas/grade (categorias × meses)"
```

---

### Task 8: UI — grade secundária

**Files:**
- Modify: `public/index.html` (um contêiner da grade dentro de `#planejamento`)
- Modify: `public/app.js` (render da grade + edição por célula grava baseline)

**Interfaces:**
- Consumes: `GET /api/metas/grade`, `PUT /api/metas` (escopo sempre `baseline` na grade).

- [ ] **Step 1: HTML** — dentro de `<section id="planejamento">`, após a tabela do mês, um bloco recolhível:

```html
    <details id="planGradeWrap">
      <summary>Planejar vários meses (grade)</summary>
      <div class="planGradeScroll"><table id="planGrade"></table></div>
    </details>
```

- [ ] **Step 2: Render** — em `public/app.js`, ao final de `renderPlanejamento()` chamar `renderGrade()` e implementá-la:

```js
  async function renderGrade() {
    const g = await apiGet(`/api/metas/grade`);
    const head = `<thead><tr><th>Categoria</th>${g.meses.map(m => `<th>${mesLabel(m)}</th>`).join("")}</tr></thead>`;
    const body = g.categorias.map(c => {
      const tds = c.celulas.map(cel => {
        const alvo = cel.alvo_cents == null ? "" : centavosBR(cel.alvo_cents / 100 + "");
        const real = cel.realizado_cents == null ? "" : `<small>${centavosBR(cel.realizado_cents / 100 + "")}</small>`;
        return `<td><input class="gAlvo" inputmode="decimal" value="${alvo}" data-cat="${c.categoria_id}" data-mes="${cel.mes}">${real}</td>`;
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
    await apiPut(`/api/metas`, { categoria_id: e.target.dataset.cat, mes: e.target.dataset.mes, valor_cents: cents, escopo: "baseline" });
    renderPlanejamento(); // re-render mês + grade
  });
```

Nota: `mesLabel` já existe em `app.js` (usado nos gráficos); reuse.

- [ ] **Step 3: Verificação manual:**
  - Abrir a grade; editar uma célula → recarregar: aquele mês e os seguintes mostram o novo alvo (baseline propagou); meses anteriores inalterados.
  - Realizado aparece pequeno nas células de meses corridos; futuro só com alvo.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: grade categorias × meses (edição grava baseline a partir do mês)"
```

---

### Task 9: Docs + checkpoint de infra (Fase B)

- [ ] **Step 1:** Atualizar `CLAUDE.md` (Inc 4 completo: mês + grade) e `CONTEXTO.md` (nota da grade: edição = baseline "daqui pra frente").
- [ ] **Step 2:** `npm test` verde; deploy; conferir grade ao vivo.
- [ ] **Step 3: Commit** `docs: Inc 4 Fase B — grade (roadmap + contexto)`.
- [ ] **Step 4:** Finalizar a branch (merge no master via o fluxo do projeto).

**Checkpoint Fase B:** grade funcional ao vivo; planejamento completo (mês + sequência).

---

## Self-Review (contra a spec)

**Cobertura da spec:**
- §3 modelo de dados → Task 2. §4 resolução pura → Task 1. §5 API (mês, grade, sugestão, PUT, DELETE) → A4 (+ B1 grade). §6 UI (mês + grade) → A5, B2. §7 faseamento → Fases A/B. §8 testes → testes em A1/A3/A4/B1 + verificação manual do front. §9 fora de escopo → respeitado (só despesa/macro, sem pessoa/receita/sub/Telegram/rollover).
- Semear por média (decisão da conversa) → `mediaSugestao` (A1) + `/api/metas/sugestao` (A4) + "Sugerir pra todas" (A5). "Sugerir pra todas" pré-preenche sem gravar (default aprovado).
- Estouro (vermelho) / aviso 80% (amarelo) → `statusMeta` (A1), devolvido em `status` (A4), pintado no front (A5).

**Consistência de tipos:** `valor_cents`/`alvo_cents`/`realizado_cents`/`sugestao_cents`/`diff_cents` são inteiros (centavos) em toda a API; `db.js` converte na borda. `origem ∈ {excecao,baseline,sem-alvo}`, `escopo ∈ {baseline,excecao}`, `status ∈ {normal,aviso,estouro,sem-alvo}` usados de forma idêntica em A1/A4/A5/B1. Datas: db devolve `'YYYY-MM-01'`; `alvoEfetivo` compara `'YYYY-MM-01'`; API fala `'YYYY-MM'` e normaliza com `primeiroDiaDoMes`.

**Placeholders:** nenhum — todo passo tem código real ou verificação concreta. (O front não tem harness E2E; a lógica testável foi empurrada pro backend/`metas.js`, e o front tem verificação manual explícita.)
