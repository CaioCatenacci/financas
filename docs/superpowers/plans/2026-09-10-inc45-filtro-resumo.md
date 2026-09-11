# Incremento 4.5 — Filtro único + Resumo por mês fechado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unificar o filtro de tempo num seletor único de mês/ano em todas as telas e redesenhar o Resumo para o modelo "um mês fechado por vez" (curva diária + orçamento, sunburst, rosca de pessoa, bullet por categoria).

**Architecture:** Front (`public/app.js`/`index.html`) + agregação (`worker/db.js`/`index.js`). Sem mudança no modelo de dados. Lógica testável (ranges, acumulado, pace) em helpers puros de `app.js`; SQL de agregação com centavos convertidos na borda. Duas fases: **1** — filtro único + grade do Planejamento + Lançamentos; **2** — redesenho do Resumo e remoção do filtro antigo.

**Tech Stack:** Cloudflare Workers (JS ESM), Neon Postgres, HTML+JS vanilla (SVG inline, sem libs), `node --test`. `public/app.js` é ESM com funções puras testadas em `public/app.test.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-10-inc45-filtro-resumo-design.md`

## Global Constraints

- Branch nova `inc45-filtro-resumo` (não commitar no master direto).
- **Dinheiro:** o Resumo tem DOIS caminhos — os campos existentes (`kpis`, `porCategoria`, `porPessoa`, `mesVsAnterior`) seguem em **numeric-string (reais)** parseados com `parseFloat`/`+` no front (padrão atual, não mudar); os campos NOVOS de centavos (`diario`, e o consumo de `/api/metas`) usam **inteiro em centavos**, com `(round(x*100))::bigint` + **`Number()` na borda do `db.js`** (o bug do Inc 4 foi esquecer o `Number()` → `+` concatena string). Testes das leituras `::bigint` devem usar fake que devolve **string**.
- Mês normalizado como `'YYYY-MM'` na UI e API; range meio-aberto `[de, ateExcl)` para agregações por dia.
- Comentários e testes **em português** (o *porquê*). ES modules. SVG inline (sem libs externas), tema via variáveis CSS já existentes.
- Rotas atrás do token (herdam de `handleApi`). Campo de valor sempre `type="text"` + `inputmode="decimal"`.
- Front sem harness E2E: lógica testável vai para helpers puros; renderers SVG têm verificação manual.

---

## Estrutura de arquivos

```
public/app.js          MODIFICAR — estado.mes; rangeDoMes/acumularDiario/paceOrcamento (puros);
                       carregar() por mês; drawDiario/drawSunburst/drawPessoaDonut/drawBullet;
                       adaptar drawDumbbell; remover presets (Fase 2)
public/app.test.mjs    MODIFICAR — testes dos helpers puros novos
public/index.html      MODIFICAR — seletor de mês global; chip "Todos os meses" (Lançamentos);
                       contêineres novos do Resumo; remover .period (Fase 2); CSS dos gráficos
worker/db.js           MODIFICAR — resumoDiario(); resumoMesVsAnterior(mesRef)
worker/db.test.mjs     MODIFICAR — testes (fake string p/ ::bigint)
worker/index.js        MODIFICAR — /api/resumo aceita mes=, devolve diario + mesVsAnterior ancorado
worker/index.test.mjs  MODIFICAR — testes da rota
CLAUDE.md, CONTEXTO.md  MODIFICAR — decisões do Inc 4.5
```

---

## FASE 1 — Filtro único + Planejamento + Lançamentos

### Task 1: helper puro `rangeDoMes` + `estado.mes` groundwork

**Files:**
- Modify: `public/app.js` (adicionar `rangeDoMes` exportado; introduzir `estado.mes`)
- Test: `public/app.test.mjs`

**Interfaces:**
- Produces: `rangeDoMes(mes:'YYYY-MM') -> { de:'YYYY-MM-01', ateExcl:'YYYY-MM-01'(mês+1) }`

- [ ] **Step 1: Teste que falha** — acrescentar a `public/app.test.mjs`:

```js
import { rangeDoMes } from "./app.js";

test("rangeDoMes: de = dia 1, ateExcl = dia 1 do mês seguinte (vira o ano)", () => {
  assert.deepEqual(rangeDoMes("2026-09"), { de: "2026-09-01", ateExcl: "2026-10-01" });
  assert.deepEqual(rangeDoMes("2026-12"), { de: "2026-12-01", ateExcl: "2027-01-01" });
});
```
(reuse o `import { test } ...`/`assert` já no topo do arquivo; adicione só o `import { rangeDoMes }` se necessário, junto aos imports existentes de `./app.js`.)

- [ ] **Step 2: Rodar e ver falhar** — `npm test` → FAIL (`rangeDoMes` não exportado).

- [ ] **Step 3: Implementar** — no bloco de funções puras do topo de `public/app.js` (perto de `periodoRange`):

```js
// Inc 4.5: range meio-aberto [de, ateExcl) de um mês 'YYYY-MM'. Substitui periodoRange no eixo mês.
export function rangeDoMes(mes) {
  const [a, m] = mes.split("-").map(Number);
  const prox = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
  return { de: `${mes}-01`, ateExcl: `${prox}-01` };
}
```

E no objeto `estado` (achar a declaração `const estado = {...}` em `app.js`), adicionar o campo `mes` inicializado com o mês corrente e `lancTudo:false`:
```js
// dentro de estado:  mes: new Date().toISOString().slice(0,7), lancTudo: false,
```
(Não remover `estado.periodo` ainda — o Resumo usa até a Fase 2. Só adicionar os campos novos.)

- [ ] **Step 4: Rodar e ver passar** — `npm test` → PASS.

- [ ] **Step 5: Commit**
```bash
git add public/app.js public/app.test.mjs
git commit -m "feat: rangeDoMes (puro) + estado.mes p/ o filtro único"
```

---

### Task 2: seletor de mês global + Lançamentos (mês único + "Todos os meses")

**Files:**
- Modify: `public/index.html` (seletor de mês no topo; chip "Todos os meses" em Lançamentos; CSS)
- Modify: `public/app.js` (wire do seletor; `carregarLancamentos` por mês / tudo)

**Interfaces:**
- Consumes: `rangeDoMes`, `estado.mes`, `estado.lancTudo` (Task 1); `GET /api/transacoes?de=&ate=` (existente).
- Produces: seseletor `#mesSel` (global) governando Lançamentos; Resumo intocado (segue `.period`).

- [ ] **Step 1: HTML** — em `public/index.html`, adicionar um seletor de mês no topo (logo abaixo de `.tabs` ou ao lado). Reuse o estilo de `.planhead input[type="month"]`:
```html
  <div class="mesbar">
    <label>Mês <input type="month" id="mesSel"></label>
  </div>
```
E em Lançamentos, dentro de `#filtros` (após os selects), um chip de alternância:
```html
    <button type="button" class="chip" id="lancTudo" aria-pressed="false">Todos os meses</button>
```
Adicionar CSS mínimo para `.mesbar` (espaçamento) e o estado ativo do chip (`#lancTudo[aria-pressed="true"]`) no `<style>`.

- [ ] **Step 2: Wire do seletor** — em `public/app.js`:
  - No load inicial, setar `$("#mesSel").value = estado.mes`.
  - Listener: `$("#mesSel").addEventListener("change", e => { estado.mes = e.target.value; /* re-render da aba ativa */ })`. LEIA como a troca de aba decide a aba ativa (bloco `document.querySelectorAll(".tab")...`) e re-renderize a aba corrente: se Lançamentos ativo → `carregarLancamentos()`; se Planejamento → `renderPlanejamento()`; se Resumo → (Fase 1: nada, segue presets).
  - **Lançamentos por mês:** LEIA o `carregar()` atual (usa `periodoRange(estado.periodo)` p/ buscar `/api/transacoes`). Separe a busca de transações num caminho que, quando a aba é Lançamentos, use `rangeDoMes(estado.mes)` (`de`, e `ate` = dia anterior a `ateExcl`, ou passe `ateExcl` e ajuste o filtro `<=`/`<` conforme a rota — a rota `/api/transacoes` filtra por `data`; use `de` e `ate` inclusivos: `ate` = último dia do mês). Quando `estado.lancTudo` verdadeiro, buscar sem filtro de data (janela ampla `1900-01-01`..`2999-12-31`, como o preset "tudo" fazia).
  - Chip "Todos os meses": `$("#lancTudo").addEventListener("click", ...)` alterna `estado.lancTudo`, atualiza `aria-pressed`, e recarrega Lançamentos. Quando ligado, desabilitar/ignorar `#mesSel` para Lançamentos.

- [ ] **Step 3: Verificação** (sem servidor ao vivo — controller checa depois): `node --check public/app.js`; `npm test` (segue verde — nada de front testado aqui além do Task 1). Conferir por leitura que `#mesSel`/`#lancTudo` batem com os seletores do JS.

- [ ] **Step 4: Commit**
```bash
git add public/index.html public/app.js
git commit -m "feat: seletor de mês global + Lançamentos por mês com atalho 'Todos os meses'"
```

---

### Task 3: Planejamento segue o filtro; grade com ano + cores por célula

**Files:**
- Modify: `public/app.js` (`renderPlanejamento`/`renderGrade` usam `estado.mes`; grade 12 meses + ano + status por célula)
- Modify: `public/index.html` (CSS das cores de célula da grade, se necessário)

**Interfaces:**
- Consumes: `estado.mes` (Task 1), `mesSel` (Task 2); `GET /api/metas?mes=`, `GET /api/metas/grade?de=&ate=` (existentes); `statusMeta` do backend já devolve o `status` por linha no `/api/metas`; a grade usa `origem`/`alvo_cents`/`realizado_cents` por célula.

- [ ] **Step 1:** A tela do mês do Planejamento passa a usar `estado.mes` em vez do `#planMes` interno. LEIA `renderPlanejamento()` e o HTML `#planMes`: **remover** o `#planMes` (e seu listener) e ancorar em `estado.mes` (o seletor global `#mesSel` é a fonte). O botão "Sugerir pra todas" e a edição seguem iguais, só trocando a fonte do mês.

- [ ] **Step 2: Grade ancorada + 12 meses + ano.** LEIA `renderGrade()` (hoje chama `GET /api/metas/grade` sem `de`/`ate`, usando o default do backend). Passar `de = estado.mes` e `ate = mesAnterior(estado.mes, -11)` (12 colunas a partir do mês selecionado). Como `mesAnterior` vive em `worker/metas.js` (backend), NÃO importar no front — calcular o `ate` com uma aritmética local simples (ex.: derivar de `estado.mes` somando 11 meses; ou deixar `de` e passar `ate` calculado por um helper local). Rótulos das colunas: usar `mesLabel` já existente, garantindo que ele mostre o **ano** (ex.: `jun/26`); se `mesLabel` não inclui ano, ajustar a chamada na grade para anexar o ano (`'26`).

- [ ] **Step 3: Cores por célula.** Para cada célula com `realizado_cents != null` (mês corrido/corrente), calcular a faixa e aplicar classe: reusar a mesma semântica de `statusMeta` (>100% estouro, ≥80% aviso, senão normal). Como `statusMeta` é backend, replicar a regra inline no front (é trivial: `frac = realizado/alvo`) OU pedir ao `/api/metas/grade` que devolva `status` por célula (preferir **replicar inline no front** para não mexer no backend nesta task). Aplicar `.status-estouro/.aviso/.normal` (classes já existentes no `<style>`) à célula; futuro (realizado null) fica neutro. Ajustar CSS se as classes de status precisarem de fundo/borda além da cor de texto para ficarem legíveis numa célula de grade.

- [ ] **Step 4: Verificação** (sem live): `node --check public/app.js`; `npm test`. Conferir por leitura que a grade some com `#planMes` e usa `#mesSel`.

- [ ] **Step 5: Commit**
```bash
git add public/app.js public/index.html
git commit -m "feat: Planejamento segue o filtro global; grade com ano e cores por célula"
```

**Checkpoint Fase 1** (controller + usuário): deploy e conferir ao vivo — seletor global governa Planejamento e Lançamentos; grade a partir do mês escolhido, com ano e cores; "Todos os meses" carrega tudo. Resumo segue com os presets (transitório).

---

## FASE 2 — Resumo por mês fechado

### Task 4: `db.js` — `resumoDiario` + `resumoMesVsAnterior(mesRef)` + testes

**Files:**
- Modify: `worker/db.js`
- Test: `worker/db.test.mjs`

**Interfaces:**
- Produces:
  - `resumoDiario(de, ateExcl) -> [{ dia:'YYYY-MM-DD', total_cents:number }]` (despesa+computa_resumo, por dia, meio-aberto)
  - `resumoMesVsAnterior(mesRef:'YYYY-MM')` — ancora no mês passado (hoje ancora em `max(data)`)

- [ ] **Step 1: Testes que falham** — acrescentar a `worker/db.test.mjs`:

```js
test("resumoDiario: despesa+computa_resumo por dia, meio-aberto, cents numérico", async () => {
  const sql = fakeSql([{ dia: "2026-09-03", total_cents: "1500" }]); // Neon devolve bigint como STRING
  const db = criarDb(sql);
  const r = await db.resumoDiario("2026-09-01", "2026-10-01");
  assert.equal(typeof r[0].total_cents, "number");
  assert.equal(r[0].total_cents, 1500);
  const c = sql.chamadas[0];
  assert.match(c.text, /natureza = 'despesa'/i);
  assert.match(c.text, /computa_resumo/i);
  assert.match(c.text, /data >= .* and .*data < /is);
  assert.deepEqual(c.values, ["2026-09-01", "2026-10-01"]);
});

test("resumoMesVsAnterior ancora no mês passado (não em max(data))", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.resumoMesVsAnterior("2026-09");
  const c = sql.chamadas[0];
  assert.ok(c.values.includes("2026-09-01") || c.text.includes("2026-09"), "usa o mês passado por parâmetro");
  assert.doesNotMatch(c.text, /max\(data\)/i);
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npm test` → FAIL.

- [ ] **Step 3: Implementar** — em `worker/db.js`, adicionar `resumoDiario` e substituir `resumoMesVsAnterior` (LEIA a versão atual antes — ela usa `with m as (select date_trunc('month', max(data)) as cur from transacoes)`):

```js
    async resumoDiario(de, ateExcl) {
      const rows = await sql`
        select to_char(data,'YYYY-MM-DD') as dia,
               (round(sum(valor_final)*100))::bigint as total_cents
        from transacoes
        where natureza='despesa' and computa_resumo
          and data >= ${de} and data < ${ateExcl}
        group by 1 order by 1`;
      return rows.map(r => ({ ...r, total_cents: Number(r.total_cents) }));
    },
```

```js
    // dumbbell: despesa por categoria no mês de referência vs o anterior. Ancorado no mês passado.
    async resumoMesVsAnterior(mesRef) {
      const cur = `${mesRef}-01`;
      return await sql`
        with m as (select date_trunc('month', ${cur}::date) as cur)
        select c.nome as macro,
          coalesce(sum(t.valor_final) filter (where date_trunc('month', t.data) = (select cur from m)), 0) as atual,
          coalesce(sum(t.valor_final) filter (where date_trunc('month', t.data) = (select cur from m) - interval '1 month'), 0) as ant
        from transacoes t
        left join categorias c on c.id = t.categoria_id
        where t.natureza = 'despesa' and t.computa_resumo
          and t.data >= (select cur from m) - interval '1 month'
          and t.data <  (select cur from m) + interval '1 month'
        group by c.nome
        order by atual desc`;
    },
```
(Manter o formato de saída `macro/atual/ant` idêntico ao atual — o front `drawDumbbell` faz `+r.ant`/`+r.atual`; NÃO converter para cents aqui, é o caminho numeric-string existente.)

- [ ] **Step 4: Rodar e ver passar** — `npm test` → PASS.

- [ ] **Step 5: Commit**
```bash
git add worker/db.js worker/db.test.mjs
git commit -m "feat: db — resumoDiario (cents) e resumoMesVsAnterior ancorado no mês"
```

---

### Task 5: `/api/resumo?mes=` devolve `diario` + `mesVsAnterior` ancorado

**Files:**
- Modify: `worker/index.js` (bloco `/api/resumo`)
- Test: `worker/index.test.mjs`

**Interfaces:**
- Consumes: `db.resumoDiario`, `db.resumoMesVsAnterior(mesRef)` (Task 4); `primeiroDiaDoMes`/`mesAnterior` de `./metas.js` (já importados).
- Produces: `GET /api/resumo?mes=YYYY-MM` → objeto com `kpis`, `porCategoria`, `porPessoa`, `mesVsAnterior` (do mês), `diario` (novo). Mantém `de`/`ate` como fallback compatível.

- [ ] **Step 1: Teste que falha** — acrescentar a `worker/index.test.mjs` (usar um fake de db com os métodos de resumo; LEIA o `dbApiFake`/o fake usado no teste `"/api/resumo inclui porPessoa"` e estenda-o com `resumoDiario` e `resumoMesVsAnterior`):

```js
test("/api/resumo?mes= devolve diario e mesVsAnterior do mês", async () => {
  const db = dbResumoFake(); // fake com kpis/porCategoria/porPessoa/resumoDiario/resumoMesVsAnterior
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const req = new Request("http://localhost/api/resumo?mes=2026-09", { headers: { "Cookie": "token=token123" } });
  const data = await (await handleApi(req, env, new URL(req.url), db)).json();
  assert.ok(Array.isArray(data.diario), "tem diario");
  assert.ok(Array.isArray(data.mesVsAnterior), "tem mesVsAnterior");
  assert.equal(db.estado.mesRef, "2026-09"); // resumoMesVsAnterior recebeu o mês
});
```
Definir `dbResumoFake` no arquivo, registrando em `estado` o `mesRef` recebido e o `de`/`ateExcl` de `resumoDiario`, e devolvendo arrays simples.

- [ ] **Step 2: Rodar e ver falhar** — `npm test` → FAIL.

- [ ] **Step 3: Implementar** — no bloco `if (url.pathname === "/api/resumo")` de `worker/index.js`, aceitar `mes` e computar o range; adicionar `diario` e passar o mês ao `mesVsAnterior`:

```js
  if (url.pathname === "/api/resumo") {
    const mes = url.searchParams.get("mes");
    let de, ate, ateExcl, mesRef;
    if (mes && /^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) {
      const [ya, ma] = mes.split("-").map(Number);
      const lastDay = new Date(Date.UTC(ya, ma, 0)).getUTCDate();
      de = `${mes}-01`; ate = `${mes}-${String(lastDay).padStart(2, "0")}`;
      ateExcl = primeiroDiaDoMes(mesAnterior(mes, -1)); mesRef = mes;
    } else {
      de = url.searchParams.get("de") || "1900-01-01";
      ate = url.searchParams.get("ate") || "2999-12-31";
      ateExcl = null; mesRef = (ate || "").slice(0, 7) || new Date().toISOString().slice(0, 7);
    }
    return j({
      kpis: await db.resumoKPIs(de, ate),
      porCategoria: await db.resumoPorCategoria(de, ate),
      porPessoa: await db.resumoPorPessoa(de, ate),
      mesVsAnterior: await db.resumoMesVsAnterior(mesRef),
      diario: ateExcl ? await db.resumoDiario(de, ateExcl) : [],
    });
  }
```
(Remoção de `mensal` do payload: o front deixa de usá-lo na Task 7; o método `resumoMensal` do db fica órfão e é removido na Task 10. Se algum teste existente checar `data.mensal`, ajuste-o.)

- [ ] **Step 4: Rodar e ver passar** — `npm test` → PASS. Rodar a suíte inteira e corrigir qualquer teste que dependia de `mensal`/da assinatura antiga de `resumoMesVsAnterior`.

- [ ] **Step 5: Commit**
```bash
git add worker/index.js worker/index.test.mjs
git commit -m "feat: /api/resumo aceita mes=, devolve diario e mesVsAnterior ancorado"
```

---

### Task 6: helpers puros da curva diária (`acumularDiario`, `paceOrcamento`)

**Files:**
- Modify: `public/app.js`
- Test: `public/app.test.mjs`

**Interfaces:**
- Produces:
  - `acumularDiario(diario, ano, mes, hojeISO=null) -> [{ dia:'YYYY-MM-DD', acum_cents }]` (dias 1..último; acumulado; para em `hojeISO` quando dado)
  - `paceOrcamento(totalCents, ano, mes) -> [{ dia:number(1..último), alvo_cents }]` (reta linear 0→total)

- [ ] **Step 1: Testes que falham** — em `public/app.test.mjs`:

```js
import { acumularDiario, paceOrcamento } from "./app.js";

test("acumularDiario: acumula por dia e para em hoje no mês corrente", () => {
  const diario = [{ dia: "2026-09-01", total_cents: 1000 }, { dia: "2026-09-03", total_cents: 500 }];
  const r = acumularDiario(diario, 2026, 9, "2026-09-03");
  assert.equal(r.length, 3);                    // dias 1,2,3 (para em hoje)
  assert.equal(r[0].acum_cents, 1000);
  assert.equal(r[1].acum_cents, 1000);          // dia 2 sem gasto: mantém
  assert.equal(r[2].acum_cents, 1500);          // dia 3 acumula
});

test("acumularDiario: mês fechado (sem hoje) vai até o último dia", () => {
  const r = acumularDiario([{ dia: "2026-06-30", total_cents: 200 }], 2026, 6, null);
  assert.equal(r.length, 30);
  assert.equal(r[29].acum_cents, 200);
});

test("paceOrcamento: reta linear de 0 ao total no último dia", () => {
  const r = paceOrcamento(300000, 2026, 9); // set = 30 dias
  assert.equal(r.length, 30);
  assert.equal(r[29].alvo_cents, 300000);
  assert.equal(r[14].alvo_cents, Math.round(300000 * 15 / 30)); // dia 15
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npm test` → FAIL.

- [ ] **Step 3: Implementar** — em `public/app.js` (bloco puro do topo):

```js
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
```

- [ ] **Step 4: Rodar e ver passar** — `npm test` → PASS.

- [ ] **Step 5: Commit**
```bash
git add public/app.js public/app.test.mjs
git commit -m "feat: acumularDiario + paceOrcamento (puros) p/ a curva diária"
```

---

### Task 7: Resumo no mês fechado — curva diária + dumbbell ancorado; remover presets

**Files:**
- Modify: `public/index.html` (remover `.period`; trocar título/contêiner de "Evolução mensal")
- Modify: `public/app.js` (`carregar()` por mês + fetch `/api/metas?mes=`; `drawDiario` substitui `drawEvo`; `drawDumbbell` lê dado ancorado; remover uso de `estado.periodo`)

**Interfaces:**
- Consumes: `rangeDoMes`, `acumularDiario`, `paceOrcamento` (helpers); `GET /api/resumo?mes=`, `GET /api/metas?mes=`; helpers de desenho existentes (`showTip/hideTip`, `BRL`, `mesLabel`).
- Produces: Resumo governado por `estado.mes`; `#mesSel` agora vale no Resumo também.

- [ ] **Step 1: Remover presets + wire do mês.** Em `index.html`, remover o bloco `.period` (linhas do `<div class="period">`). Em `app.js`: remover o listener das `.period .chip` e o uso de `estado.periodo`; `carregar()` passa a computar `rangeDoMes(estado.mes)` e buscar `/api/resumo?mes=${estado.mes}` **e** `/api/metas?mes=${estado.mes}` (guardar em `estado.resumo` e `estado.metasMes`). `#mesSel` no `change` re-renderiza o Resumo quando ativo.

- [ ] **Step 2: `drawDiario` (substitui `drawEvo`).** Em `index.html`, trocar o título do card "Evolução mensal" para "Gasto no mês" (sub: "acumulado × orçamento") e a legenda (Gasto acumulado / Orçamento). Manter o contêiner `#evo` (ou renomear para `#diario`; se renomear, ajustar o JS). Implementar `drawDiario()` **espelhando a estrutura SVG de `drawEvo`** (mesmos paddings/`viewBox`/grid/`showTip`), mas:
  - X = dias do mês (1..último); Y = centavos → reais.
  - Série 1: `acumularDiario(estado.resumo.diario, ano, mes, hojeSeMesCorrente)` → linha do gasto acumulado (para em hoje no mês corrente).
  - Série 2: `paceOrcamento(estado.metasMes.total.alvo_cents, ano, mes)` → reta tracejada do orçamento.
  - Domínio Y = `max(maior acumulado, orçamento total) * 1.1`.
  - Hover por dia: `showTip` com dia, gasto acumulado (`BRL`) e orçamento previsto até o dia.
  - Chamar `drawDiario()` no lugar de `drawEvo()` na sequência de render (`drawKPIs(); drawDiario(); drawDonut()...`).

- [ ] **Step 3: `drawDumbbell` ancorado.** `drawDumbbell` já lê `estado.resumo.mesVsAnterior`; como o backend agora ancora no mês selecionado, nenhuma mudança de lógica é necessária além de confirmar que continua lendo esse campo. Ajustar o sub do card se fizer sentido ("mês selecionado vs anterior").

- [ ] **Step 4: Verificação** (sem live): `node --check public/app.js`; `npm test`. Conferir que nenhuma referência a `estado.periodo`/`periodoRange`/`.period` sobrou (grep). Confirmar contêineres.

- [ ] **Step 5: Commit**
```bash
git add public/index.html public/app.js
git commit -m "feat: Resumo por mês — curva diária + orçamento, dumbbell ancorado, sem presets"
```

---

### Task 8: `drawSunburst` (categoria + subcategoria, com foco)

**Files:**
- Modify: `public/app.js` (`drawSunburst` substitui `drawDonut`)
- Modify: `public/index.html` (título/contêiner do card de categoria, se necessário)

**Interfaces:**
- Consumes: `estado.resumo.porCategoria` (traz `macro`, `sub`, `natureza`, `total`); helpers `corDe`/`construirCores`/`CAT`/`showTip`/`hideTip`/`BRL`.
- Produces: `drawSunburst()` chamado no lugar de `drawDonut()`.

- [ ] **Step 1:** LEIA `drawDonut()` (estrutura SVG de anel/arcos, uso de `corDe`, `#donut`, `#catlist`, `showTip`). O sunburst reaproveita o mesmo contêiner `#donut` e a `#catlist` (lista lateral por categoria).

- [ ] **Step 2: Implementar `drawSunburst()`** — dois anéis concêntricos:
  - **Anel interno:** despesa por **categoria** (agregando `porCategoria` por `macro`, só `natureza==='despesa'`) — cor por `corDe(macro)`.
  - **Anel externo:** as **subcategorias** de cada categoria (linhas com `sub` não-nula), como fatias alinhadas ao arco da categoria-mãe; cor = tom mais claro/escuro da cor da categoria (derivar via `opacity` ou mistura). Categoria sem sub: o anel externo naquele arco fica vazio/atenuado.
  - Ângulos proporcionais ao `total` (usar `parseFloat(r.total)`), como o donut faz.
  - Hover em qualquer fatia: `showTip` com nome (categoria › sub) + valor (`BRL`) + % do total.
  - **Foco (clique):** clicar numa fatia de categoria **foca** aquela categoria — re-renderiza mostrando só ela (anel interno = a categoria; anel externo = as subs dela em ângulo cheio). Um clique no centro (ou num "voltar") reseta para a visão completa. Guardar o foco em `estado.sunburstFoco` (nome da categoria ou null) e re-desenhar.
  - Manter a `#catlist` como legenda/lista por categoria (reusar a que o donut já monta).
  - Chamar `drawSunburst()` no lugar de `drawDonut()` na sequência de render.

- [ ] **Step 3: Verificação** (sem live): `node --check public/app.js`; `npm test`. Conferir contêiner/handlers por leitura.

- [ ] **Step 4: Commit**
```bash
git add public/app.js public/index.html
git commit -m "feat: Resumo — sunburst categoria+subcategoria com clique pra focar"
```

---

### Task 9: `drawPessoaDonut` (rosca) + `drawBullet` (novo, orçamento × realizado)

**Files:**
- Modify: `public/app.js` (`drawPessoaDonut` substitui `drawPessoa`; `drawBullet` novo)
- Modify: `public/index.html` (contêiner do bullet, espaço maior; ajuste do card de pessoa)

**Interfaces:**
- Consumes: `estado.resumo.porPessoa` (via `agruparPorPessoa`), `estado.metasMes.linhas` (`categoria`, `alvo_cents`, `realizado_cents`, `status`), helpers `showTip`/`BRL`/`corDe`.
- Produces: `drawPessoaDonut()` e `drawBullet()` chamados na sequência de render.

- [ ] **Step 1: `drawPessoaDonut`** — LEIA `drawPessoa()` (contêiner `#pessoa`, `agruparPorPessoa`). Substituir a barra por uma **rosca**: fatia por pessoa proporcional à despesa (`agruparPorPessoa(estado.resumo.porPessoa)` → `{pessoa, despesa}`), cor por índice (`CAT`), **total no centro** (`BRL` da soma), legenda por pessoa com valor/%. Reusar a mecânica de arco do donut/sunburst. Chamar no lugar de `drawPessoa()`.

- [ ] **Step 2: `drawBullet`** — em `index.html`, adicionar um card de largura total (grid de 1 coluna) com contêiner `#bullet`, título "Orçamento × realizado" (sub: "por categoria, no mês"). Implementar `drawBullet()`:
  - Uma linha (bullet horizontal) por categoria de `estado.metasMes.linhas` que tenha `alvo_cents != null`, ordenada por `realizado_cents/alvo_cents` desc.
  - Cada linha: rótulo da categoria; uma faixa de fundo; **barra** = `realizado_cents` (escala pelo `max(realizado, alvo)` da linha, ou uma escala comum); **marcador vertical** = `alvo_cents` (o orçamento); cor da barra por `status` (`--ink`/`--aviso`/`--neg` conforme normal/aviso/estouro, reusando as variáveis já usadas na aba Planejamento).
  - Hover: `showTip` com categoria, realizado, orçamento e diferença (`BRL`).
  - Categorias sem alvo: omitir (ou listar ao fim sem barra de meta) — preferir omitir para manter o painel limpo.
  - Chamar `drawBullet()` na sequência de render, depois do dumbbell/pessoa.

- [ ] **Step 3: Verificação** (sem live): `node --check public/app.js`; `npm test`. Conferir contêineres `#pessoa`/`#bullet` e handlers por leitura.

- [ ] **Step 4: Commit**
```bash
git add public/app.js public/index.html
git commit -m "feat: Resumo — rosca de pessoa + bullet de orçamento × realizado por categoria"
```

---

### Task 10: limpeza + docs + checkpoint

**Files:**
- Modify: `worker/db.js` (remover `resumoMensal` órfão), `worker/index.js`/testes (se referenciarem `mensal`)
- Modify: `CLAUDE.md`, `CONTEXTO.md`

- [ ] **Step 1: Limpeza.** Remover o método `resumoMensal` de `worker/db.js` (agora sem uso) e qualquer referência remanescente a `mensal`/`agruparMensal`/`periodoRange`/`estado.periodo` no front que tenha ficado órfã (grep). Se `agruparMensal` não for mais usada, removê-la e seu teste; se ainda for usada por algo, manter. Rodar `npm test`.
- [ ] **Step 2: Docs.** `CLAUDE.md` (nota do Inc 4.5: filtro único de mês; `/api/resumo?mes=` com `diario`; Resumo por mês fechado). `CONTEXTO.md`: seção "14. Incremento 4.5 — filtro único + Resumo por mês fechado" explicando o *porquê* (mês fechado como unidade natural com orçamento; curva diária vs pace; sunburst/rosca/bullet; faseamento).
- [ ] **Step 3:** `npm test` verde.
- [ ] **Step 4: Commit**
```bash
git add -A
git commit -m "chore+docs: Inc 4.5 — remover resumoMensal órfão; roadmap e contexto"
```

**Checkpoint Fase 2** (controller + usuário): deploy e conferir ao vivo — Resumo por mês (curva diária + orçamento, dumbbell, waterfall, sunburst com foco, rosca de pessoa, bullet), presets removidos, seletor único governando tudo.

---

## Self-Review (contra a spec)

**Cobertura:** filtro único (Task 1,2) · Lançamentos mês+Tudo (Task 2) · grade ano+cores+12 meses (Task 3) · curva diária+pace (Task 4,5,6,7) · dumbbell ancorado (Task 4,5,7) · waterfall mantido (intocado) · sunburst com foco (Task 8) · rosca de pessoa (Task 9) · bullet (Task 9) · remoção de presets (Task 7) · limpeza+docs (Task 10). Faseamento 1→2 respeitado (Resumo não quebra na Fase 1).

**Consistência de tipos/unidades:** `diario.total_cents` e o consumo de `/api/metas` são inteiros em **centavos** (`::bigint` + `Number()` na borda; testes com fake string). `kpis`/`porCategoria`/`porPessoa`/`mesVsAnterior` seguem **numeric-string (reais)** parseados com `+`/`parseFloat` (padrão atual, não alterado). Datas: UI/API em `'YYYY-MM'`; agregação diária meio-aberta `[de, ateExcl)`. `estado.mes` é a fonte única do mês; `estado.periodo` some na Task 7.

**Placeholders:** helpers puros e SQL têm código completo + TDD. Os renderers SVG (drawDiario/Sunburst/PessoaDonut/Bullet) têm spec visual/interação detalhada + instrução de espelhar a função análoga existente (drawEvo/drawDonut/drawPessoa) — guia concreto, não placeholder; a lógica testável foi extraída para os helpers puros (Task 1,6) e o backend (Task 4). Front sem harness E2E → verificação manual explícita nos checkpoints.
