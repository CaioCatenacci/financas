# Inc 4.6 — Agrupamento de transações: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ligar explicitamente as transações duplicadas (linha do extrato × lançamento do Caio) num grupo com um único representante, que é o único que conta no Resumo, visível e editável na tela de Lançamentos; e fazer o import do extrato gravar esse grupo no casamento automático.

**Architecture:** duas colunas em `transacoes` (`grupo_id`, `representante`) mais uma coluna gerada `conta_no_resumo` que centraliza a regra "quem conta"; as regras de grupo ficam puras em `worker/grupos.js` (decidem, devolvem a lista mínima de linhas a atualizar) e `db.js` grava cada ação numa única `sql.transaction`; o app monta os grupos client-side a partir da lista plana (`montarLinhas`) e filtra por cima (`filtrarLinhas`). Fase A entrega modelo + regras + rotas + tela (agrupar na mão); Fase B faz o import gravar o grupo em vez de carimbar o hash no lançamento.

**Tech Stack:** Cloudflare Worker (JS puro, `node --test`), Neon Postgres via `@neondatabase/serverless`, app vanilla JS em `public/`, pytest só pra os tools Python (que **não** mudam neste incremento).

**Spec:** `docs/superpowers/specs/2026-09-25-agrupamento-transacoes-design.md`

## Global Constraints

- Dinheiro em centavos na API; agregação em SQL (`numeric(12,2)`); nada de float acumulado em JS (CLAUDE.md).
- `grupos.js` é **puro**: sem banco, sem rede; tudo entra por parâmetro (mesmo espírito de `metas.js`/`money.js`).
- Comentários e testes **em português**, explicando o *porquê*.
- Vocabulário fixo: `grupo_id` (uuid, conjunto de duplicatas), `representante` (boolean, o membro que conta), **membro** (linha com `grupo_id` e `representante=false`), `conta_no_resumo` (gerada: `computa_resumo and (grupo_id is null or representante)`).
- Toda ação de grupo grava numa **única `sql.transaction`** (1 subrequest, atômica).
- Erro de regra → `400 {erro}` com mensagem legível (helper `erroJson` de `handleApi`). Nunca 500 opaco.
- `computa_resumo` continua sendo a flag do usuário ("fora do resumo"); as leituras agregadas passam a usar `conta_no_resumo`.
- Migrações aditivas e idempotentes; aplicar no Neon **antes** do deploy do código que lê a coluna nova.
- Sem commit/push automático fora dos passos de commit do plano; o Caio faz o push pelo GitHub Desktop.

## Review Focus

Entradas que a spec implica mas que um usuário real vai esbarrar; cada linha tem o teste apontado na task dona do código.

1. **Grupo cujo representante ficou fora do período carregado** (Lançamentos filtra por mês; a linha do banco pode estar em outro mês): os membros não podem sumir da tela. → Task 5, teste "membros órfãos viram linhas soltas".
2. **`POST /api/grupos` com ids repetidos ou inexistentes**: a leitura devolve menos linhas que ids; tem que virar erro legível, não grupo de 1. → Task 4, teste "ids repetidos/inexistentes → 400".
3. **Tirar membro pela URL de outro grupo** (`/api/grupos/G1/membros/x` com `x` em G2): não pode limpar nada. → Task 2, teste "id fora do grupo → erro"; Task 4 cobre a rota.
4. **Agrupar linhas que já estão todas no mesmo grupo** (seleção só da linha do grupo, ou clique duplo): não pode "criar" nada nem trocar o representante. → Task 2, teste "todas no mesmo grupo → erro".
5. **Casado do import cujo lançamento já está num grupo com outra linha de extrato**: não pode casar de novo (duplicaria a evidência). → Task 8, teste do predicado de candidatos.

---

## File Structure

| Arquivo | Responsabilidade | Fase |
|---|---|---|
| `migrations/0009_grupos.sql` (novo) | colunas `grupo_id`/`representante`/`conta_no_resumo`, check, índices | A |
| `worker/grupos.js` (novo) + `worker/grupos.test.mjs` (novo) | regras puras de grupo | A |
| `worker/db.js` + `worker/db.test.mjs` | leituras com `conta_no_resumo`; `transacoesPorIds`, `membrosDoGrupo`, `grupoDaTransacao`, `gravarGrupo`; Fase B: `transacoesNaJanela`, `aplicarImportacao`, insert com grupo | A/B |
| `worker/index.js` + `worker/index.test.mjs` | rotas `/api/grupos*`, `DELETE /api/transacoes/:id` e `del:` do Telegram com `podeApagar` | A |
| `worker/reconciliar.js` + `.test.mjs`, `worker/importar.js` + `.test.mjs` | `matchGrupoId` no casamento | B |
| `public/app.js` + `public/app.test.mjs` | `montarLinhas`, `filtrarLinhas`, UI de grupo; Fase B: `montarDecisao` com linha do extrato + grupo | A/B |
| `public/index.html`, `public/shell.css` | chip "agrupados", botão "Agrupar", selos, linhas de membro | A |
| `CLAUDE.md`, `CONTEXTO.md`, `BACKLOG.md` | vocabulário, decisão, status | A/B |

---

# FASE A — modelo, regras, rotas e tela

### Task 1: Migração 0009 + leituras agregadas por `conta_no_resumo`

**Files:**
- Create: `migrations/0009_grupos.sql`
- Modify: `worker/db.js` (funções `resumoPorCategoria`, `resumoKPIs`, `resumoDiario`, `resumoMesVsAnterior`, `resumoReembolsoAno`, `resumoPorPessoa`, `realizadoPorCategoriaMes`)
- Test: `worker/db.test.mjs`

**Interfaces:**
- Produces: colunas `transacoes.grupo_id uuid`, `transacoes.representante boolean`, `transacoes.conta_no_resumo boolean` (gerada). As leituras agregadas filtram por `conta_no_resumo`.

- [ ] **Step 1: Escrever o teste que falha (leituras por `conta_no_resumo`)**

Acrescentar ao fim de `worker/db.test.mjs`:

```js
// ---- Inc 4.6: grupos ----
// A regra "quem conta" mora na coluna gerada conta_no_resumo (computa_resumo AND (sem grupo OU
// representante)). Se alguma leitura agregada ainda filtrar por computa_resumo, um membro de
// grupo volta a contar e o Resumo dobra o valor da duplicata.
test("leituras agregadas filtram por conta_no_resumo, não por computa_resumo", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.resumoPorCategoria("2026-09-01", "2026-09-30");
  await db.resumoKPIs("2026-09-01", "2026-09-30");
  await db.resumoDiario("2026-09-01", "2026-10-01");
  await db.resumoMesVsAnterior("2026-09");
  await db.resumoReembolsoAno();
  await db.resumoPorPessoa("2026-09-01", "2026-09-30");
  await db.realizadoPorCategoriaMes("2026-09-01", "2026-10-01");
  assert.equal(sql.chamadas.length, 7);
  for (const c of sql.chamadas) {
    assert.match(c.text, /conta_no_resumo/, c.text);
    assert.doesNotMatch(c.text, /\bcomputa_resumo\b/, c.text);
  }
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/db.test.mjs`
Expected: FAIL em "leituras agregadas filtram por conta_no_resumo" (`The input did not match the regular expression /conta_no_resumo/`).

- [ ] **Step 3: Escrever a migração**

Criar `migrations/0009_grupos.sql`:

```sql
-- 0009: grupos de transações (duplicatas explícitas com representante). Aditiva, idempotente.
--
-- Inc 4.6: um lançamento do Caio e a linha do extrato que o duplica entram no MESMO grupo;
-- exatamente um membro é o representante e só ele conta no Resumo. A regra "quem conta" fica
-- numa coluna gerada (conta_no_resumo) pra viver num lugar só — as leituras agregadas trocam
-- computa_resumo (flag do usuário: "fora do resumo") por ela.

alter table transacoes add column if not exists grupo_id      uuid;
alter table transacoes add column if not exists representante boolean not null default false;

-- representante sem grupo não existe
alter table transacoes drop constraint if exists transacoes_representante_com_grupo;
alter table transacoes add constraint transacoes_representante_com_grupo
  check (not representante or grupo_id is not null);

-- no máximo UM representante por grupo (o "pelo menos um" é garantido pela API/grupos.js)
create unique index if not exists idx_transacoes_grupo_representante
  on transacoes (grupo_id) where representante;

create index if not exists idx_transacoes_grupo
  on transacoes (grupo_id) where grupo_id is not null;

-- quem conta: fora do resumo (flag do usuário) E, se agrupado, só o representante
alter table transacoes add column if not exists conta_no_resumo boolean
  generated always as (computa_resumo and (grupo_id is null or representante)) stored;
```

- [ ] **Step 4: Trocar `computa_resumo` por `conta_no_resumo` nas 7 leituras**

Em `worker/db.js`, nas funções listadas em **Files**, cada `t.computa_resumo` / `computa_resumo` dentro do `where` vira `t.conta_no_resumo` / `conta_no_resumo`. Exemplo (`resumoPorCategoria`):

```js
        where t.data >= ${de} and t.data <= ${ate} and t.conta_no_resumo
```

e (`resumoKPIs`):

```js
        from transacoes where data >= ${de} and data <= ${ate} and conta_no_resumo`;
```

**Não** mexer em `marcarPagamentoFaturaNaoGasto` (ela procura pela flag do usuário, `computa_resumo = true`, de propósito) nem em `atualizarTransacao`/`atualizarTransacoesLote` (escrevem a flag).

Acrescentar um comentário acima do bloco `// ---- resumos` explicando:

```js
    // ---- resumos ---- (join p/ nomes; apelidam c.nome as macro p/ manter a forma que os gráficos usam)
    // Inc 4.6: filtram por conta_no_resumo (coluna gerada: computa_resumo AND (sem grupo OU
    // representante)) — um membro de grupo nunca conta, mesmo com computa_resumo=true.
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test`
Expected: tudo verde (a suíte inteira, não só db.test).

- [ ] **Step 6: Commit**

```bash
git add migrations/0009_grupos.sql worker/db.js worker/db.test.mjs
git commit -m "feat: migração 0009 (grupos) + leituras agregadas por conta_no_resumo"
```

---

### Task 2: `worker/grupos.js` — regras puras

**Files:**
- Create: `worker/grupos.js`
- Test: `worker/grupos.test.mjs`

**Interfaces:**
- Consumes: linhas no formato `{ id: string, fonte: string, criado_em: string|Date, grupo_id: string|null, representante: boolean, valor_final: string|number }` (é o que `db.transacoesPorIds`/`membrosDoGrupo`/`grupoDaTransacao` devolvem na Task 3).
- Produces (todas exportadas):
  - `escolherRepresentante(linhas) → linha`
  - `decidirAgrupar(linhas, novoGrupoId) → { ok:true, grupo_id, representante_id, mudancas } | { ok:false, erro }`
  - `decidirRepresentar(membros, novoId) → { ok:true, mudancas } | { ok:false, erro }`
  - `decidirTirar(membros, id) → { ok:true, mudancas, dissolveu } | { ok:false, erro }`
  - `decidirDesagrupar(membros) → { ok:true, mudancas }`
  - `podeApagar(membros, id) → { ok:true, mudancas } | { ok:false, erro }`
  - `valoresDiferem(representante, membros) → boolean`
  - `mudancas` = `[{ id, grupo_id, representante }]`, **na ordem em que devem ser gravadas**.

- [ ] **Step 1: Escrever os testes que falham**

Criar `worker/grupos.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escolherRepresentante, decidirAgrupar, decidirRepresentar, decidirTirar, decidirDesagrupar,
  podeApagar, valoresDiferem,
} from "./grupos.js";

// fixture: lançamento do Caio (manual), foto, e a linha do extrato que duplica o aluguel
const manual  = { id: "m1", fonte: "manual",  criado_em: "2026-09-02T10:00:00Z", grupo_id: null, representante: false, valor_final: "2500.00" };
const foto    = { id: "f1", fonte: "imagem",  criado_em: "2026-09-01T09:00:00Z", grupo_id: null, representante: false, valor_final: "2500.00" };
const extrato = { id: "e1", fonte: "extrato", criado_em: "2026-09-30T20:00:00Z", grupo_id: null, representante: false, valor_final: "2500.00" };
const extrato2 = { id: "e2", fonte: "extrato", criado_em: "2026-09-30T20:01:00Z", grupo_id: null, representante: false, valor_final: "2500.00" };

test("escolherRepresentante: prefere quem não veio do banco; empate → o mais antigo", () => {
  // a foto é mais antiga que o manual → representa; o extrato nunca ganha de um lançamento do Caio
  assert.equal(escolherRepresentante([extrato, manual, foto]).id, "f1");
  assert.equal(escolherRepresentante([extrato, manual]).id, "m1");
});

test("escolherRepresentante: só linhas do banco → a mais antiga", () => {
  assert.equal(escolherRepresentante([extrato2, extrato]).id, "e1");
});

test("decidirAgrupar: nenhuma em grupo → grupo novo, representante não-extrato, todas com grupo_id", () => {
  const d = decidirAgrupar([extrato, manual], "G1");
  assert.equal(d.ok, true);
  assert.equal(d.grupo_id, "G1");
  assert.equal(d.representante_id, "m1");
  assert.deepEqual(d.mudancas, [
    { id: "e1", grupo_id: "G1", representante: false },
    { id: "m1", grupo_id: "G1", representante: true },
  ]);
});

test("decidirAgrupar: uma já em grupo → as soltas entram nele e o representante NÃO muda", () => {
  const rep = { ...manual, grupo_id: "G0", representante: true };
  const d = decidirAgrupar([rep, extrato], "G-novo-ignorado");
  assert.equal(d.ok, true);
  assert.equal(d.grupo_id, "G0");
  assert.equal(d.representante_id, "m1");
  // só a linha solta muda; a que já estava no grupo não aparece nas mudanças
  assert.deepEqual(d.mudancas, [{ id: "e1", grupo_id: "G0", representante: false }]);
});

test("decidirAgrupar: linhas de dois grupos diferentes → erro 'desagrupe antes'", () => {
  const a = { ...manual, grupo_id: "G0", representante: true };
  const b = { ...extrato, grupo_id: "G9", representante: true };
  const d = decidirAgrupar([a, b], "Gx");
  assert.equal(d.ok, false);
  assert.match(d.erro, /desagrupe antes/i);
});

test("decidirAgrupar: todas já no mesmo grupo → erro (nada a fazer)", () => {
  const a = { ...manual, grupo_id: "G0", representante: true };
  const b = { ...extrato, grupo_id: "G0" };
  const d = decidirAgrupar([a, b], "Gx");
  assert.equal(d.ok, false);
  assert.match(d.erro, /já estão no mesmo grupo/i);
});

test("decidirAgrupar: menos de 2 linhas → erro", () => {
  assert.equal(decidirAgrupar([manual], "G1").ok, false);
  assert.equal(decidirAgrupar([], "G1").ok, false);
});

test("decidirRepresentar: troca atômica — tira do atual ANTES de pôr no novo (índice único)", () => {
  const membros = [
    { ...manual, grupo_id: "G0", representante: true },
    { ...extrato, grupo_id: "G0" },
  ];
  const d = decidirRepresentar(membros, "e1");
  assert.equal(d.ok, true);
  assert.deepEqual(d.mudancas, [
    { id: "m1", grupo_id: "G0", representante: false },
    { id: "e1", grupo_id: "G0", representante: true },
  ]);
});

test("decidirRepresentar: id fora do grupo → erro; já é o representante → sem mudanças", () => {
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  assert.equal(decidirRepresentar(membros, "zzz").ok, false);
  assert.deepEqual(decidirRepresentar(membros, "m1"), { ok: true, mudancas: [] });
});

test("decidirTirar: membro comum sai; sobrando 1, o grupo dissolve (o que sobrou também limpa)", () => {
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  const d = decidirTirar(membros, "e1");
  assert.equal(d.ok, true);
  assert.equal(d.dissolveu, true);
  assert.deepEqual(d.mudancas, [
    { id: "e1", grupo_id: null, representante: false },
    { id: "m1", grupo_id: null, representante: false },
  ]);
});

test("decidirTirar: com 3 membros, tirar um não dissolve", () => {
  const membros = [
    { ...manual, grupo_id: "G0", representante: true },
    { ...extrato, grupo_id: "G0" },
    { ...extrato2, grupo_id: "G0" },
  ];
  const d = decidirTirar(membros, "e2");
  assert.equal(d.dissolveu, false);
  assert.deepEqual(d.mudancas, [{ id: "e2", grupo_id: null, representante: false }]);
});

test("decidirTirar: tirar o representante com outros membros → erro; id fora do grupo → erro", () => {
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  const d = decidirTirar(membros, "m1");
  assert.equal(d.ok, false);
  assert.match(d.erro, /escolha outro representante/i);
  assert.equal(decidirTirar(membros, "nao-existe").ok, false);
});

test("decidirDesagrupar: limpa grupo_id e representante de todos", () => {
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  assert.deepEqual(decidirDesagrupar(membros), { ok: true, mudancas: [
    { id: "m1", grupo_id: null, representante: false },
    { id: "e1", grupo_id: null, representante: false },
  ] });
});

test("podeApagar: sem grupo → ok sem mudanças; representante com outros membros → erro", () => {
  assert.deepEqual(podeApagar([], "m1"), { ok: true, mudancas: [] });
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  const d = podeApagar(membros, "m1");
  assert.equal(d.ok, false);
  assert.match(d.erro, /escolha outro representante/i);
});

test("podeApagar: membro comum → ok; se sobra 1, o que sobrou limpa o grupo", () => {
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  assert.deepEqual(podeApagar(membros, "e1"), { ok: true, mudancas: [{ id: "m1", grupo_id: null, representante: false }] });
});

test("valoresDiferem: acusa 56.200 vs 36.200 e não acusa valores iguais (string ou número)", () => {
  const rep = { ...manual, valor_final: "36200.00" };
  assert.equal(valoresDiferem(rep, [{ ...extrato, valor_final: "56200.00" }]), true);
  assert.equal(valoresDiferem(rep, [{ ...extrato, valor_final: 36200 }]), false);
  assert.equal(valoresDiferem(rep, []), false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/grupos.test.mjs`
Expected: FAIL com `Cannot find module './grupos.js'`.

- [ ] **Step 3: Implementar `worker/grupos.js`**

```js
// Inc 4.6: regras de grupo (duplicatas explícitas com representante). PURO: sem banco, sem
// rede — as linhas entram por parâmetro no formato {id, fonte, criado_em, grupo_id,
// representante, valor_final}. Cada função devolve { ok:true, mudancas:[...] } ou
// { ok:false, erro } com mensagem legível (o Worker responde 400 com ela).
//
// `mudancas` é a lista MÍNIMA de linhas a atualizar ({id, grupo_id, representante}), NA ORDEM
// em que devem ser gravadas: o índice único "um representante por grupo" exige tirar a flag do
// atual antes de pôr no novo, e o db grava a lista em sequência numa única transação.

const ehBanco = (l) => l.fonte === "extrato" || l.fonte === "fatura";
const maisAntiga = (a, b) => (String(a.criado_em) <= String(b.criado_em) ? a : b);

// Quem representa um grupo novo: a linha que NÃO veio do banco — é onde mora o contexto que o
// Caio escreveu na hora (categoria, pessoa, descrição). Havendo várias, a mais antiga. Se todas
// vieram do banco, a mais antiga.
export function escolherRepresentante(linhas) {
  const manuais = linhas.filter((l) => !ehBanco(l));
  const pool = manuais.length ? manuais : linhas;
  return pool.reduce(maisAntiga);
}

export function decidirAgrupar(linhas, novoGrupoId) {
  if (!Array.isArray(linhas) || linhas.length < 2) {
    return { ok: false, erro: "selecione pelo menos 2 lançamentos pra agrupar" };
  }
  const grupos = [...new Set(linhas.map((l) => l.grupo_id).filter(Boolean))];
  if (grupos.length > 1) return { ok: false, erro: "desagrupe antes: a seleção tem linhas de grupos diferentes" };

  const soltas = linhas.filter((l) => !l.grupo_id);
  if (grupos.length === 1) {
    // entra no grupo existente; o representante fica quem era
    if (!soltas.length) return { ok: false, erro: "essas linhas já estão no mesmo grupo" };
    const grupo_id = grupos[0];
    const rep = linhas.find((l) => l.grupo_id === grupo_id && l.representante);
    return {
      ok: true, grupo_id, representante_id: rep ? rep.id : null,
      mudancas: soltas.map((l) => ({ id: l.id, grupo_id, representante: false })),
    };
  }
  const rep = escolherRepresentante(linhas);
  return {
    ok: true, grupo_id: novoGrupoId, representante_id: rep.id,
    mudancas: linhas.map((l) => ({ id: l.id, grupo_id: novoGrupoId, representante: l.id === rep.id })),
  };
}

export function decidirRepresentar(membros, novoId) {
  const novo = membros.find((m) => m.id === novoId);
  if (!novo) return { ok: false, erro: "esse lançamento não está no grupo" };
  const atual = membros.find((m) => m.representante);
  if (atual && atual.id === novoId) return { ok: true, mudancas: [] };
  const mudancas = [];
  if (atual) mudancas.push({ id: atual.id, grupo_id: atual.grupo_id, representante: false }); // tira ANTES
  mudancas.push({ id: novo.id, grupo_id: novo.grupo_id, representante: true });             // põe DEPOIS
  return { ok: true, mudancas };
}

export function decidirTirar(membros, id) {
  const alvo = membros.find((m) => m.id === id);
  if (!alvo) return { ok: false, erro: "esse lançamento não está no grupo" };
  if (alvo.representante && membros.length > 1) {
    return { ok: false, erro: "escolha outro representante antes de tirar este" };
  }
  const restantes = membros.filter((m) => m.id !== id);
  const mudancas = [{ id, grupo_id: null, representante: false }];
  // grupo de 1 não é grupo: dissolve
  if (restantes.length === 1) mudancas.push({ id: restantes[0].id, grupo_id: null, representante: false });
  return { ok: true, mudancas, dissolveu: restantes.length <= 1 };
}

export function decidirDesagrupar(membros) {
  return { ok: true, mudancas: membros.map((m) => ({ id: m.id, grupo_id: null, representante: false })) };
}

// Apagar uma transação que representa um grupo com outros membros deixaria o grupo sem quem
// conta (e sem linha na tela) → recusa; o Caio escolhe outro representante antes.
export function podeApagar(membros, id) {
  if (!membros.length) return { ok: true, mudancas: [] };
  const alvo = membros.find((m) => m.id === id);
  if (!alvo) return { ok: true, mudancas: [] };
  if (alvo.representante && membros.length > 1) {
    return { ok: false, erro: "escolha outro representante antes de apagar este" };
  }
  const restantes = membros.filter((m) => m.id !== id);
  const mudancas = restantes.length === 1 ? [{ id: restantes[0].id, grupo_id: null, representante: false }] : [];
  return { ok: true, mudancas };
}

// Só informa (selo na tela): duplicata com valor diferente do representante é o caso
// "salário + repasse na mesma entrada" — intencional, mas vale o aviso.
export function valoresDiferem(representante, membros) {
  const v = Number(representante.valor_final);
  return membros.some((m) => Number(m.valor_final) !== v);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: verde, 17 testes novos.

- [ ] **Step 5: Commit**

```bash
git add worker/grupos.js worker/grupos.test.mjs
git commit -m "feat: grupos.js — regras puras de agrupamento (representante, tirar, desagrupar, apagar)"
```

---

### Task 3: `db.js` — leituras e escrita de grupo

**Files:**
- Modify: `worker/db.js` (acrescentar 4 funções; remover `apagarTransacao` depois da Task 4 se ficar sem uso)
- Test: `worker/db.test.mjs`

**Interfaces:**
- Produces:
  - `db.transacoesPorIds(ids: string[]) → [{id, fonte, criado_em, grupo_id, representante, valor_final}]`
  - `db.membrosDoGrupo(grupo_id) → mesma forma, ordenado por criado_em`
  - `db.grupoDaTransacao(id) → membros do grupo da transação (ela inclusa); [] se não tem grupo`
  - `db.gravarGrupo({ mudancas, apagarId }) → { alterados, apagados }` — uma única `sql.transaction`

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar ao fim de `worker/db.test.mjs`:

```js
test("transacoesPorIds/membrosDoGrupo/grupoDaTransacao devolvem a forma mínima que grupos.js precisa", async () => {
  const sql = fakeSql([{ id: "t1", fonte: "manual", criado_em: "x", grupo_id: null, representante: false, valor_final: "1.00" }]);
  const db = criarDb(sql);
  await db.transacoesPorIds(["t1", "t2"]);
  assert.match(sql.chamadas[0].text, /select id, fonte, criado_em, grupo_id, representante, valor_final/i);
  assert.match(sql.chamadas[0].text, /id = any\(/i);
  await db.membrosDoGrupo("G0");
  assert.match(sql.chamadas[1].text, /where grupo_id = /i);
  await db.grupoDaTransacao("t1");
  assert.match(sql.chamadas[2].text, /grupo_id = \(select grupo_id from transacoes where id = /i);
  // lista vazia não vai ao banco
  assert.deepEqual(await db.transacoesPorIds([]), []);
  assert.equal(sql.chamadas.length, 3);
});

test("gravarGrupo grava todas as mudanças (na ordem) e o delete opcional numa ÚNICA transação", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const r = await db.gravarGrupo({
    mudancas: [
      { id: "m1", grupo_id: "G0", representante: false },
      { id: "e1", grupo_id: "G0", representante: true },
    ],
    apagarId: "x9",
  });
  assert.deepEqual(r, { alterados: 2, apagados: 1 });
  assert.ok(Array.isArray(sql.transacao), "usa sql.transaction");
  assert.equal(sql.transacao.length, 3);
  // as queries da transação são construídas pelo fakeSql: verificamos a ordem via chamadas
  assert.match(sql.chamadas[0].text, /update transacoes set grupo_id = \?, representante = \? where id = \?/i);
  assert.deepEqual(sql.chamadas[0].values, ["G0", false, "m1"]);
  assert.deepEqual(sql.chamadas[1].values, ["G0", true, "e1"]);
  assert.match(sql.chamadas[2].text, /delete from transacoes where id = \?/i);
  assert.deepEqual(sql.chamadas[2].values, ["x9"]);
});

test("gravarGrupo sem mudanças nem delete não abre transação", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  assert.deepEqual(await db.gravarGrupo({ mudancas: [] }), { alterados: 0, apagados: 0 });
  assert.equal(sql.transacao, undefined);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/db.test.mjs`
Expected: FAIL com `db.transacoesPorIds is not a function`.

- [ ] **Step 3: Implementar em `worker/db.js`**

Acrescentar antes do bloco `// ---- apoio à importação` (dentro do objeto retornado por `criarDb`):

```js
    // ---- Inc 4.6: grupos (duplicatas explícitas com representante) ----
    // As três leituras devolvem a forma mínima que worker/grupos.js consome. Quem decide é o
    // módulo puro; aqui só se lê e se grava.
    async transacoesPorIds(ids) {
      if (!ids || !ids.length) return [];
      return await sql`
        select id, fonte, criado_em, grupo_id, representante, valor_final
        from transacoes where id = any(${ids}::uuid[])`;
    },

    async membrosDoGrupo(grupo_id) {
      return await sql`
        select id, fonte, criado_em, grupo_id, representante, valor_final
        from transacoes where grupo_id = ${grupo_id} order by criado_em`;
    },

    // membros do grupo da transação (ela inclusa); [] quando ela não tem grupo.
    async grupoDaTransacao(id) {
      return await sql`
        select id, fonte, criado_em, grupo_id, representante, valor_final
        from transacoes
        where grupo_id = (select grupo_id from transacoes where id = ${id}) and grupo_id is not null
        order by criado_em`;
    },

    // Grava a lista de mudanças de grupos.js NA ORDEM (o índice único de representante exige
    // tirar antes de pôr) e, se pedido, apaga uma transação — tudo numa única sql.transaction
    // (1 subrequest, atômica: ou o grupo fica consistente ou nada muda).
    async gravarGrupo({ mudancas = [], apagarId = null } = {}) {
      const queries = mudancas.map((m) => sql`
        update transacoes set grupo_id = ${m.grupo_id}, representante = ${m.representante} where id = ${m.id}`);
      if (apagarId) queries.push(sql`delete from transacoes where id = ${apagarId}`);
      if (queries.length) await sql.transaction(queries);
      return { alterados: mudancas.length, apagados: apagarId ? 1 : 0 };
    },
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: verde.

- [ ] **Step 5: Commit**

```bash
git add worker/db.js worker/db.test.mjs
git commit -m "feat: db — leituras de grupo e gravarGrupo (uma transação por ação)"
```

---

### Task 4: Rotas `/api/grupos*` e exclusão protegida (app + Telegram)

**Files:**
- Modify: `worker/index.js` (imports; `tratarUpdate` ramo `del:`; `handleApi` rota `DELETE /api/transacoes/:id`; rotas novas)
- Test: `worker/index.test.mjs`

**Interfaces:**
- Consumes: `grupos.js` (Task 2) e `db.transacoesPorIds/membrosDoGrupo/grupoDaTransacao/gravarGrupo` (Task 3).
- Produces (HTTP, atrás do token):
  - `POST /api/grupos` `{ ids }` → `200 { grupo_id, representante_id }` | `400 { erro }`
  - `DELETE /api/grupos/:grupo_id` → `200 { ok, desagrupados }`
  - `PATCH /api/grupos/:grupo_id` `{ representante_id }` → `200 { ok }` | `400 { erro }`
  - `DELETE /api/grupos/:grupo_id/membros/:id` → `200 { ok, dissolveu }` | `400 { erro }`
  - `DELETE /api/transacoes/:id` → `200 { ok }` | `400 { erro }` (representante com membros)
  - `deps.db` do Telegram passa a precisar de `grupoDaTransacao` e `gravarGrupo` (em vez de `apagarTransacao`).

- [ ] **Step 1: Escrever os testes que falham**

Em `worker/index.test.mjs`, **substituir** no `dbFake()` a linha `apagarTransacao: async (id) => { estado.apagados.push(id); },` por:

```js
    // Inc 4.6: apagar passa por podeApagar; sem grupo → gravarGrupo só apaga
    grupoDaTransacao: async () => [],
    gravarGrupo: async ({ apagarId }) => { if (apagarId) estado.apagados.push(apagarId); return { alterados: 0, apagados: 1 }; },
```

Acrescentar ao fim do arquivo:

```js
// ---------- Inc 4.6: grupos ----------
function dbGruposFake(linhas) {
  // `linhas`: o que transacoesPorIds/membrosDoGrupo/grupoDaTransacao devolvem (mesmo conjunto,
  // pra simplificar); `gravado` guarda o que gravarGrupo recebeu.
  const f = {
    gravado: null,
    transacoesPorIds: async (ids) => linhas.filter((l) => ids.includes(l.id)),
    membrosDoGrupo: async (g) => linhas.filter((l) => l.grupo_id === g),
    grupoDaTransacao: async (id) => { const t = linhas.find((l) => l.id === id); return t && t.grupo_id ? linhas.filter((l) => l.grupo_id === t.grupo_id) : []; },
    gravarGrupo: async (arg) => { f.gravado = arg; return { alterados: arg.mudancas.length, apagados: arg.apagarId ? 1 : 0 }; },
  };
  return f;
}
const envApi = { APP_TOKEN: "token123", DATABASE_URL: "" };
const reqApi = (path, method, body) => new Request(`http://localhost${path}`, {
  method, headers: { "Cookie": "token=token123", "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});
const manualG = { id: "m1", fonte: "manual",  criado_em: "2026-09-02", grupo_id: null, representante: false, valor_final: "2500.00" };
const extratoG = { id: "e1", fonte: "extrato", criado_em: "2026-09-30", grupo_id: null, representante: false, valor_final: "2500.00" };

test("POST /api/grupos agrupa e grava as mudanças; representante = o lançamento manual", async () => {
  const db = dbGruposFake([manualG, extratoG]);
  const r = await handleApi(reqApi("/api/grupos", "POST", { ids: ["m1", "e1"] }), envApi, new URL("http://localhost/api/grupos"), db);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.representante_id, "m1");
  assert.ok(data.grupo_id, "gera um grupo_id");
  assert.equal(db.gravado.mudancas.length, 2);
  assert.ok(db.gravado.mudancas.every((m) => m.grupo_id === data.grupo_id));
});

test("POST /api/grupos com ids repetidos/inexistentes → 400 legível (não cria grupo de 1)", async () => {
  const db = dbGruposFake([manualG, extratoG]);
  const r = await handleApi(reqApi("/api/grupos", "POST", { ids: ["m1", "m1", "nao-existe"] }), envApi, new URL("http://localhost/api/grupos"), db);
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro, /pelo menos 2/i);
  assert.equal(db.gravado, null);
});

test("PATCH /api/grupos/:g troca o representante; id fora do grupo → 400", async () => {
  const db = dbGruposFake([{ ...manualG, grupo_id: "G0", representante: true }, { ...extratoG, grupo_id: "G0" }]);
  const ok = await handleApi(reqApi("/api/grupos/G0", "PATCH", { representante_id: "e1" }), envApi, new URL("http://localhost/api/grupos/G0"), db);
  assert.equal(ok.status, 200);
  assert.deepEqual(db.gravado.mudancas.map((m) => [m.id, m.representante]), [["m1", false], ["e1", true]]);
  const bad = await handleApi(reqApi("/api/grupos/G0", "PATCH", { representante_id: "zzz" }), envApi, new URL("http://localhost/api/grupos/G0"), db);
  assert.equal(bad.status, 400);
});

test("DELETE /api/grupos/:g/membros/:id tira o membro; tirar o representante → 400", async () => {
  const db = dbGruposFake([{ ...manualG, grupo_id: "G0", representante: true }, { ...extratoG, grupo_id: "G0" }]);
  const bad = await handleApi(reqApi("/api/grupos/G0/membros/m1", "DELETE"), envApi, new URL("http://localhost/api/grupos/G0/membros/m1"), db);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).erro, /escolha outro representante/i);
  const ok = await handleApi(reqApi("/api/grupos/G0/membros/e1", "DELETE"), envApi, new URL("http://localhost/api/grupos/G0/membros/e1"), db);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).dissolveu, true);
});

test("DELETE /api/grupos/:g desagrupa todos", async () => {
  const db = dbGruposFake([{ ...manualG, grupo_id: "G0", representante: true }, { ...extratoG, grupo_id: "G0" }]);
  const r = await handleApi(reqApi("/api/grupos/G0", "DELETE"), envApi, new URL("http://localhost/api/grupos/G0"), db);
  assert.equal(r.status, 200);
  assert.ok(db.gravado.mudancas.every((m) => m.grupo_id === null && m.representante === false));
});

test("DELETE /api/transacoes/:id recusa apagar representante com membros; membro comum apaga e dissolve", async () => {
  const db = dbGruposFake([{ ...manualG, grupo_id: "G0", representante: true }, { ...extratoG, grupo_id: "G0" }]);
  const bad = await handleApi(reqApi("/api/transacoes/m1", "DELETE"), envApi, new URL("http://localhost/api/transacoes/m1"), db);
  assert.equal(bad.status, 400);
  const ok = await handleApi(reqApi("/api/transacoes/e1", "DELETE"), envApi, new URL("http://localhost/api/transacoes/e1"), db);
  assert.equal(ok.status, 200);
  assert.equal(db.gravado.apagarId, "e1");
  assert.deepEqual(db.gravado.mudancas, [{ id: "m1", grupo_id: null, representante: false }]);
});

test("Telegram del: recusa apagar representante com membros e avisa no chat", async () => {
  const respostas = [];
  const db = dbGruposFake([{ ...manualG, grupo_id: "G0", representante: true }, { ...extratoG, grupo_id: "G0" }]);
  const deps = { db, confirmar: async () => {}, responderImpl: async (c, t) => respostas.push(t) };
  const update = { callback_query: { message: { chat: { id: 7 }, message_id: 3 }, data: "del:m1" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.gravado, null);
  assert.match(respostas[0], /escolha outro representante/i);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/index.test.mjs`
Expected: os 7 testes novos falham (rotas caem no `ASSETS`/404 ou `db.transacoesPorIds is not a function`); o teste antigo do `del:` deve **continuar passando** (o `dbFake` novo apaga via `gravarGrupo`) — se falhar, é porque o ramo `del:` ainda chama `apagarTransacao`, que é o que a implementação corrige.

- [ ] **Step 3: Implementar em `worker/index.js`**

Import:

```js
import { decidirAgrupar, decidirRepresentar, decidirTirar, decidirDesagrupar, podeApagar } from "./grupos.js";
```

Ramo `del:` em `tratarUpdate` (substitui o bloco atual):

```js
  if (ev.tipo === "callback" && ev.data?.startsWith("del:")) {
    const idTx = ev.data.slice(4);
    // Inc 4.6: apagar o representante de um grupo deixaria o grupo sem quem conta → recusa
    const d = podeApagar(await deps.db.grupoDaTransacao(idTx), idTx);
    if (!d.ok) { await deps.responderImpl(ev.chatId, `⚠ ${d.erro} (no app).`, env); return; }
    await deps.db.gravarGrupo({ mudancas: d.mudancas, apagarId: idTx });
    await deps.responderImpl(ev.chatId, "🗑 Apagado.", env);
    return;
  }
```

Em `handleApi`, substituir a rota `DELETE /api/transacoes/` por:

```js
  if (url.pathname.startsWith("/api/transacoes/") && request.method === "DELETE") {
    const idTx = id();
    const d = podeApagar(await db.grupoDaTransacao(idTx), idTx);
    if (!d.ok) return erroJson(d.erro, 400);
    await db.gravarGrupo({ mudancas: d.mudancas, apagarId: idTx });
    return j({ ok: true });
  }

  // ---- Inc 4.6: grupos (duplicatas explícitas com representante) ----
  // Fluxo de cada rota: lê a forma mínima → grupos.js decide (puro) → gravarGrupo aplica numa
  // única transação. Erro de regra → 400 legível.
  if (url.pathname === "/api/grupos" && request.method === "POST") {
    const b = await body();
    const ids = [...new Set((b.ids || []).map(String))];
    const linhas = await db.transacoesPorIds(ids);
    const d = decidirAgrupar(linhas, crypto.randomUUID());
    if (!d.ok) return erroJson(d.erro, 400);
    await db.gravarGrupo({ mudancas: d.mudancas });
    return j({ grupo_id: d.grupo_id, representante_id: d.representante_id });
  }
  const mMembro = url.pathname.match(/^\/api\/grupos\/([^/]+)\/membros\/([^/]+)$/);
  if (mMembro && request.method === "DELETE") {
    const d = decidirTirar(await db.membrosDoGrupo(mMembro[1]), mMembro[2]);
    if (!d.ok) return erroJson(d.erro, 400);
    await db.gravarGrupo({ mudancas: d.mudancas });
    return j({ ok: true, dissolveu: d.dissolveu });
  }
  if (url.pathname.startsWith("/api/grupos/") && request.method === "PATCH") {
    const b = await body();
    const d = decidirRepresentar(await db.membrosDoGrupo(id()), String(b.representante_id));
    if (!d.ok) return erroJson(d.erro, 400);
    await db.gravarGrupo({ mudancas: d.mudancas });
    return j({ ok: true });
  }
  if (url.pathname.startsWith("/api/grupos/") && request.method === "DELETE") {
    const d = decidirDesagrupar(await db.membrosDoGrupo(id()));
    await db.gravarGrupo({ mudancas: d.mudancas });
    return j({ ok: true, desagrupados: d.mudancas.length });
  }
```

Nota: `crypto.randomUUID()` existe como global no Worker e no Node ≥ 19 (os testes rodam em Node 24).

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: verde. Depois: `grep -n "apagarTransacao" worker/*.js worker/*.mjs` — se só sobrar a definição em `db.js` e o teste dela, **remover a função e o teste** (código morto); se algum teste ainda a usar, deixar.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/index.test.mjs worker/db.js worker/db.test.mjs
git commit -m "feat: rotas /api/grupos (agrupar, representar, tirar, desagrupar) + exclusão protegida"
```

---

### Task 5: `public/app.js` — `montarLinhas` e `filtrarLinhas` (puros)

**Files:**
- Modify: `public/app.js` (seção `// ---------- funções puras`, logo após `filtrarTransacoes`)
- Test: `public/app.test.mjs`

**Interfaces:**
- Consumes: linhas de `GET /api/transacoes` (agora com `grupo_id`, `representante`, `valor_final`, e os nomes `categoria`/`subcategoria`/`pessoa` do join).
- Produces (exportadas):
  - `montarLinhas(rows) → [{ t, membros, grupo_id, diferem, orfao }]`
  - `filtrarLinhas(linhas, filtro) → linhas` (mesmo `filtro` de `filtrarTransacoes`; `computa === "agrupados"` lista só grupos)

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar ao fim de `public/app.test.mjs` (ajustar o `import { ... } from "./app.js"` do topo pra incluir `montarLinhas, filtrarLinhas`):

```js
// ---------- Inc 4.6: montarLinhas / filtrarLinhas ----------
// rows já vêm ordenadas por data desc do servidor; o grupo aparece na posição do representante.
const R = [
  { id: "a", data: "2026-09-30", descricao: "PIX ALUGUEL", contraparte_nome: null, categoria: "Casa", pessoa: null, pessoa_id: null, origem_categoria: "regra", computa_resumo: true, grupo_id: "G1", representante: false, valor_final: "2500.00", fonte: "extrato" },
  { id: "b", data: "2026-09-15", descricao: "Cinema", contraparte_nome: null, categoria: "Lazer", pessoa: "Caio", pessoa_id: 1, origem_categoria: "manual", computa_resumo: true, grupo_id: null, representante: false, valor_final: "60.00", fonte: "manual" },
  { id: "c", data: "2026-09-02", descricao: "Aluguel", contraparte_nome: "Imobiliária X", categoria: "Casa", pessoa: "Casa", pessoa_id: 5, origem_categoria: "manual", computa_resumo: true, grupo_id: "G1", representante: true, valor_final: "2500.00", fonte: "manual" },
];

test("montarLinhas: grupo vira uma linha na posição do representante, com os membros dentro", () => {
  const L = montarLinhas(R);
  assert.deepEqual(L.map((l) => l.t.id), ["b", "c"]);       // "a" (membro) não vira linha própria
  const g = L.find((l) => l.grupo_id === "G1");
  assert.deepEqual(g.membros.map((m) => m.id), ["a"]);
  assert.equal(g.diferem, false);
  assert.equal(g.orfao, false);
});

test("montarLinhas: valores diferentes marcam diferem", () => {
  const rows = R.map((r) => (r.id === "a" ? { ...r, valor_final: "56200.00" } : r));
  assert.equal(montarLinhas(rows).find((l) => l.grupo_id === "G1").diferem, true);
});

test("montarLinhas: membros órfãos (representante fora do período carregado) viram linhas soltas", () => {
  const semRep = R.filter((r) => r.id !== "c"); // o representante ficou fora da janela
  const L = montarLinhas(semRep);
  assert.deepEqual(L.map((l) => l.t.id), ["a", "b"]); // nada some da tela
  assert.equal(L[0].orfao, true);
  assert.deepEqual(L[0].membros, []);
});

test("filtrarLinhas: dimensões pelo representante; texto acha o grupo por membro; 'agrupados' lista só grupos", () => {
  const L = montarLinhas(R);
  assert.deepEqual(filtrarLinhas(L, { categoria: "Casa" }).map((l) => l.t.id), ["c"]);
  assert.deepEqual(filtrarLinhas(L, { texto: "pix aluguel" }).map((l) => l.t.id), ["c"]); // bateu no membro "a"
  assert.deepEqual(filtrarLinhas(L, { texto: "cinema" }).map((l) => l.t.id), ["b"]);
  assert.deepEqual(filtrarLinhas(L, { computa: "agrupados" }).map((l) => l.t.id), ["c"]);
  assert.deepEqual(filtrarLinhas(L, { computa: "gasto" }).map((l) => l.t.id), ["b", "c"]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test public/app.test.mjs`
Expected: FAIL com `does not provide an export named 'montarLinhas'`.

- [ ] **Step 3: Implementar em `public/app.js`** (logo após `filtrarTransacoes`)

```js
// ---------- Inc 4.6: grupos (duplicatas explícitas com representante) ----------
// Transforma a lista plana do servidor em linhas de tabela: { t, membros, grupo_id, diferem, orfao }.
// t = a transação solta ou o REPRESENTANTE do grupo; membros = os outros do grupo (nunca viram
// linha própria — aparecem só ao expandir). O grupo fica na posição do representante (a lista já
// vem ordenada por data). Grupo cujo representante NÃO veio na lista (Lançamentos carrega um mês;
// a linha do banco pode estar em outro) mostra os membros como linhas soltas com orfao=true —
// nada some da tela.
export function montarLinhas(rows) {
  const porGrupo = new Map();
  for (const r of rows) {
    if (!r.grupo_id) continue;
    if (!porGrupo.has(r.grupo_id)) porGrupo.set(r.grupo_id, []);
    porGrupo.get(r.grupo_id).push(r);
  }
  const out = [];
  for (const r of rows) {
    if (!r.grupo_id) { out.push({ t: r, membros: [], grupo_id: null, diferem: false, orfao: false }); continue; }
    const grupo = porGrupo.get(r.grupo_id);
    const rep = grupo.find((g) => g.representante);
    if (!rep) { out.push({ t: r, membros: [], grupo_id: r.grupo_id, diferem: false, orfao: true }); continue; }
    if (r.id !== rep.id) continue; // membro: só dentro do grupo
    const membros = grupo.filter((g) => g.id !== rep.id);
    const diferem = membros.some((m) => Number(m.valor_final) !== Number(r.valor_final));
    out.push({ t: r, membros, grupo_id: r.grupo_id, diferem, orfao: false });
  }
  return out;
}

// Filtro por cima das linhas montadas: categoria/pessoa/origem/gasto pelo representante (é a
// linha que conta); TEXTO bate no representante OU em qualquer membro — é assim que se acha uma
// linha do banco que "sumiu" dentro de um grupo; computa="agrupados" lista só grupos.
export function filtrarLinhas(linhas, filtro = {}) {
  const { texto, computa, ...dims } = filtro;
  const txt = texto && texto.trim() ? normalizarBusca(texto.trim()) : "";
  const soGrupos = computa === "agrupados";
  return linhas.filter((l) => {
    if (soGrupos && !l.membros.length) return false;
    if (!filtrarTransacoes([l.t], { ...dims, computa: soGrupos ? "" : computa }).length) return false;
    if (txt) {
      const alvo = [l.t, ...l.membros]
        .map((x) => normalizarBusca((x.descricao ?? "") + " " + (x.contraparte_nome ?? ""))).join(" | ");
      if (!alvo.includes(txt)) return false;
    }
    return true;
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: verde.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/app.test.mjs
git commit -m "feat: app — montarLinhas/filtrarLinhas (grupos na tabela, busca por membro, chip agrupados)"
```

---

### Task 6: UI de grupo em Lançamentos (render, ações, botão Agrupar, estilos)

**Files:**
- Modify: `public/app.js` (`estado`, `apiPatch`/`apiDelete`, `drawRows`, `idsFiltrados`, `atualizarMassaBar`, handlers de `#rows` e da barra de massa)
- Modify: `public/index.html` (select `#fcomputa`, barra `#massabar`)
- Modify: `public/shell.css`
- Test: nenhum unitário novo (DOM); a lógica está coberta na Task 5. Verificação no smoke da Task 7.

**Interfaces:**
- Consumes: `montarLinhas`/`filtrarLinhas` (Task 5); rotas da Task 4.

- [ ] **Step 1: Estado e helpers de rede**

Em `estado`, acrescentar:

```js
    expandidos: new Set(), // Inc 4.6: grupo_ids abertos na tabela (só de tela, não persiste)
```

Substituir as definições atuais de `apiPatch` e `apiDelete` por versões que leem `{erro}` (as rotas de grupo devolvem 400 com mensagem legível, e o `alert` deve mostrá-la):

```js
  // lê {erro} do corpo p/ mostrar a mensagem real (400 de regra de grupo, etc.), senão o status
  const erroDe = async (r, padrao) => { let msg = padrao; try { const e = await r.json(); if (e && e.erro) msg = e.erro; } catch { /* corpo não-JSON */ } return new Error(msg); };
  const apiPatch = async (p, body) => {
    const r = await fetch(p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw await erroDe(r, `PATCH ${p} ${r.status}`);
    return r;
  };
  const apiDelete = async (p) => {
    const r = await fetch(p, { method: "DELETE" });
    if (!r.ok) throw await erroDe(r, `DELETE ${p} ${r.status}`);
    return r;
  };
```

(Hoje `apiDelete` está em `public/app.js:247` como `const apiDelete = p => fetch(p, { method: "DELETE" }).then(...)`; `apiPatch` logo acima dela. Substituir as duas.)

- [ ] **Step 2: `drawRows` com grupos**

Substituir a função `drawRows` inteira por:

```js
  function drawRows() {
    const cats = estado.catalogo.categorias;
    const linhas = filtrarLinhas(montarLinhas(estado.transacoes), estado.filtro);
    const contador = $("#fcontador");
    if (contador) contador.textContent = `${linhas.length} de ${estado.transacoes.length}`;
    if (!linhas.length) {
      $("#rows").innerHTML = `<tr><td colspan="9" class="vazio">nenhum lançamento com esses filtros</td></tr>`;
      atualizarMassaBar();
      return;
    }
    $("#rows").innerHTML = linhas.map(l => {
      const t = l.t;
      const rec = t.natureza === "receita";
      const sel = estado.selecao.has(t.id) ? "checked" : "";
      const catOpts = cats.map(c => `<option value="${esc(c.id)}" ${c.id === t.categoria_id ? "selected" : ""}>${esc(c.nome)}</option>`).join("");
      const subOpts = `<option value="">—</option>` +
        subsDaCat(estado.catalogo, t.categoria_id).map(s => `<option value="${esc(s.id)}" ${s.id === t.subcategoria_id ? "selected" : ""}>${esc(s.nome)}</option>`).join("");
      const pessoaOpts = `<option value="">—</option>` +
        estado.pessoas.map(p => `<option value="${esc(p.id)}" ${p.id === t.pessoa_id ? "selected" : ""}>${esc(p.nome)}</option>`).join("");
      const selo = !t.computa_resumo ? `<span class="selo-fora">fora do resumo</span>` : "";
      // Inc 4.6: linha de grupo = o representante + controle pra expandir os membros + selos
      const nMem = l.membros.length;
      const aberto = estado.expandidos.has(l.grupo_id);
      const seloGrupo = nMem
        ? `<button class="grpToggle" type="button" title="${aberto ? "Recolher" : "Ver"} os lançamentos agrupados">${aberto ? "▾" : "▸"} ${nMem}</button>` +
          `<span class="selo-grupo">grupo</span>` +
          (l.diferem ? `<span class="selo-diferem" title="algum membro tem valor diferente do representante">valores diferem</span>` : "")
        : (l.orfao ? `<span class="selo-grupo" title="o representante deste grupo está fora do período carregado">membro de grupo</span>` : "");
      const acaoGrupo = nMem ? `<button class="desagrupar" title="Desagrupar">⛓</button>` : "";
      const principal = `<tr data-id="${t.id}" data-grupo="${l.grupo_id || ""}">
        <td class="selcol"><input type="checkbox" class="selrow" ${sel}></td>
        <td class="dt">${fmtData(t.data)}</td>
        <td><input class="eddesc" value="${esc(t.descricao || "")}" placeholder="—">${selo}${seloGrupo}</td>
        <td><span class="macrochip"><i class="dot" style="background:var(${corDe(t.categoria)})"></i><select class="edcat">${catOpts}</select></span></td>
        <td><select class="edsub">${subOpts}</select></td>
        <td><select class="edpessoa">${pessoaOpts}</select></td>
        <td class="val" style="color:${rec ? "var(--receita)" : "var(--ink)"}">${rec ? "+" : ""}R$ ${centavosBR(t.valor_total)}</td>
        <td class="val" style="color:var(--mut)">${+t.valor_reembolso ? "R$ " + centavosBR(t.valor_reembolso) : "—"}</td>
        <td>
          ${acaoGrupo}
          <button class="toggle-computa" title="${t.computa_resumo ? "Marcar fora do resumo" : "Incluir no resumo"}">${t.computa_resumo ? "⊘" : "↩"}</button>
          <button class="del" title="Apagar">✕</button>
        </td>
      </tr>`;
      if (!nMem || !aberto) return principal;
      // membros: só leitura (pra editar, tire do grupo ou torne representante) + 2 ações
      const membros = l.membros.map(m => `<tr class="membro" data-id="${m.id}" data-grupo="${l.grupo_id}">
        <td class="selcol"></td>
        <td class="dt">${fmtData(m.data)}</td>
        <td>${esc(m.descricao || "—")}<span class="selo-grupo">${esc(m.fonte)}</span>${!m.computa_resumo ? `<span class="selo-fora">fora do resumo</span>` : ""}</td>
        <td>${esc(m.categoria || "—")}</td>
        <td>${esc(m.subcategoria || "—")}</td>
        <td>${esc(m.pessoa || "—")}</td>
        <td class="val">${m.natureza === "receita" ? "+" : ""}R$ ${centavosBR(m.valor_total)}</td>
        <td class="val" style="color:var(--mut)">—</td>
        <td>
          <button class="miniBtn representar" title="Tornar representante (passa a ser o que conta)">★</button>
          <button class="miniBtn tirar" title="Tirar do grupo">⤴</button>
        </td>
      </tr>`).join("");
      return principal + membros;
    }).join("");
    atualizarMassaBar();
  }
```

Substituir `idsFiltrados`:

```js
  // ids atualmente visíveis (respeitando o filtro) — base do "selecionar todos". Linha de grupo
  // conta pelo representante (membros não são selecionáveis).
  function idsFiltrados() {
    return filtrarLinhas(montarLinhas(estado.transacoes), estado.filtro).map(l => l.t.id);
  }
```

Em `atualizarMassaBar`, acrescentar após `const n = estado.selecao.size;`:

```js
    const mg = $("#magrupar");
    if (mg) mg.disabled = n < 2; // agrupar precisa de 2+
```

- [ ] **Step 3: Handlers**

No handler `$("#rows").addEventListener("click", ...)`, acrescentar ramos depois do `toggle-computa`:

```js
    } else if (e.target.classList.contains("grpToggle")) {
      const g = tr.dataset.grupo;
      if (estado.expandidos.has(g)) estado.expandidos.delete(g); else estado.expandidos.add(g);
      drawRows();
    } else if (e.target.classList.contains("desagrupar")) {
      if (!confirm("Desagrupar? Cada lançamento volta a contar sozinho no Resumo.")) return;
      try { await apiDelete(`/api/grupos/${tr.dataset.grupo}`); carregar(); }
      catch (err) { alert("Falha ao desagrupar: " + err.message); }
    } else if (e.target.classList.contains("representar")) {
      try { await apiPatch(`/api/grupos/${tr.dataset.grupo}`, { representante_id: tr.dataset.id }); carregar(); }
      catch (err) { alert("Falha ao trocar o representante: " + err.message); }
    } else if (e.target.classList.contains("tirar")) {
      try { await apiDelete(`/api/grupos/${tr.dataset.grupo}/membros/${tr.dataset.id}`); carregar(); }
      catch (err) { alert("Falha ao tirar do grupo: " + err.message); }
    }
```

Na seção `// ----- edição em massa -----`, acrescentar:

```js
  // Inc 4.6: agrupar a seleção (2+). O servidor decide o representante e recusa misturar grupos.
  $("#magrupar").addEventListener("click", async () => {
    const ids = [...estado.selecao];
    if (ids.length < 2) { alert("Selecione pelo menos 2 lançamentos pra agrupar."); return; }
    try {
      const r = await apiPost("/api/grupos", { ids });
      estado.selecao.clear();
      estado.expandidos.add(r.grupo_id); // abre o grupo recém-criado pra conferir
      await carregar();
    } catch (err) { alert("Falha ao agrupar: " + err.message); }
  });
```

- [ ] **Step 4: HTML e CSS**

`public/index.html` — no select `#fcomputa`, acrescentar a opção:

```html
        <option value="agrupados">Só agrupados</option>
```

Na `#massabar`, antes de `<button id="maplicar" ...>`:

```html
      <button id="magrupar" class="chip" type="button" title="Agrupar os selecionados (duplicatas: só o representante conta)" disabled>Agrupar</button>
```

`public/shell.css` — acrescentar após `.selo-fora{...}`:

```css
/* Inc 4.6: grupos */
.selo-grupo{font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:1px 7px;margin-left:6px;white-space:nowrap}
.selo-diferem{font-size:11px;color:var(--ink);border:1px solid var(--ink);border-radius:999px;padding:1px 7px;margin-left:6px;white-space:nowrap;font-weight:600}
.grpToggle{border:1px solid var(--line);background:var(--accent-soft);color:var(--ink);border-radius:999px;padding:1px 8px;margin-left:8px;cursor:pointer;font:inherit;font-size:12px}
tr.membro td{color:var(--mut);font-size:12px}
tr.membro td.dt{padding-left:28px}
.desagrupar{border:0;background:transparent;color:var(--mut);cursor:pointer;font:inherit}
.desagrupar:hover{color:var(--ink)}
```

- [ ] **Step 5: Rodar a suíte e conferir no navegador local**

Run: `npm test` → verde (nada de novo, mas garante que `app.js` ainda importa).
Run: `npx wrangler dev` → abrir `http://localhost:8787/app?token=<APP_TOKEN de .dev.vars>` → em Lançamentos: selecionar 2 linhas → botão **Agrupar** habilita → agrupar → a linha do grupo aparece com `▸ 1` e selo "grupo" → expandir → ★ troca o representante → ⤴ tira → ⛓ desagrupa → "Só agrupados" no filtro → busca por texto de membro acha o grupo. (Isso grava no banco apontado por `.dev.vars` — hoje é o de produção; use dois lançamentos de teste e desagrupe ao final.)

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/index.html public/shell.css
git commit -m "feat: Lançamentos — linha de grupo expansível, agrupar/desagrupar/representar/tirar, chip agrupados"
```

---

### Task 7: Fase A ao vivo — migração, deploy, smoke e docs

**Files:**
- Modify: `CLAUDE.md` (seção nova + linha no roadmap), `CONTEXTO.md` (§16), `BACKLOG.md` (X1)

- [ ] **Step 1: Aplicar a migração 0009 no Neon e validar a coluna gerada**

Run (mesmo padrão usado na 0008; `DATABASE_URL` vem de `.dev.vars`):

```bash
cd /c/Users/caioc/Caio/financas && DATABASE_URL=$(grep '^DATABASE_URL=' .dev.vars | cut -d= -f2- | tr -d '"\r') node -e '
const { neon } = require("@neondatabase/serverless"); const fs = require("fs");
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const stmts = fs.readFileSync("migrations/0009_grupos.sql","utf8").split(/;\s*\n/).map(s=>s.replace(/^\s*--.*$/gm,"").trim()).filter(Boolean);
  for (const s of stmts) { console.log(">>", s.split("\n")[0].slice(0,80)); await sql(s); }
  // validação: sem nenhum grupo ainda, conta_no_resumo tem que ser idêntica a computa_resumo
  console.table(await sql`select sum(valor_final) filter (where computa_resumo) as por_flag, sum(valor_final) filter (where conta_no_resumo) as por_gerada, count(*) filter (where computa_resumo <> conta_no_resumo) as divergentes from transacoes`);
})().catch(e => { console.error("ERRO:", e.message); process.exit(1); });'
```

Expected: `por_flag == por_gerada` e `divergentes = 0`. Se divergir, **parar** antes do deploy.

- [ ] **Step 2: Deploy e smoke**

Run: `npx wrangler deploy`
Smoke em produção: Resumo do mês abre com os mesmos números de antes; em Lançamentos, agrupar dois lançamentos reais duplicados (ou dois de teste), ver o Resumo cair pelo valor do membro, desagrupar e ver voltar; tentar apagar o representante → alerta legível; buscar texto de um membro → acha o grupo.

- [ ] **Step 3: Docs**

`CLAUDE.md` — acrescentar após a seção "Categoria padrão por flag":

```markdown
### Grupos de transações (Incremento 4.6)

Duplicatas (lançamento do Caio × linha do extrato) ficam **ligadas explicitamente**: mesmo
`grupo_id`, exatamente um membro `representante`, e só ele conta. A regra "quem conta" mora na
coluna gerada `conta_no_resumo = computa_resumo and (grupo_id is null or representante)`; **toda
leitura agregada filtra por `conta_no_resumo`**, nunca por `computa_resumo` (que segue sendo a
flag do usuário, "fora do resumo").

| Coluna | Tabela | Descrição |
|---|---|---|
| `grupo_id` | `transacoes` | uuid compartilhado pelos membros; null = solta |
| `representante` | `transacoes` | o membro que conta e que aparece como a linha do grupo (um por grupo, índice parcial) |
| `conta_no_resumo` | `transacoes` | gerada; a única coluna que as agregações consultam |

Regras em `worker/grupos.js` (puro): agrupar (representante = não-extrato mais antigo; entrar
num grupo existente não troca o representante; dois grupos → recusa), representar (troca
atômica), tirar (representante com outros membros → recusa; sobra 1 → dissolve), desagrupar,
apagar (representante com membros → recusa). Cada ação grava numa única `sql.transaction`
(`db.gravarGrupo`). Rotas: `POST/DELETE/PATCH /api/grupos[...]`. Na tela, o grupo é uma linha
expansível na posição do representante; membros não são editáveis; busca por texto acha o grupo
por qualquer membro; chip "Só agrupados". Não há regra de soma: valores diferentes só geram o
selo "valores diferem". `Outros`/`Não Identificado` seguem como na seção anterior.
```

Na tabela do roadmap, acrescentar a linha `| 4.6 | Agrupamento | duplicatas explícitas com representante; import grava o grupo | Fase A implementada |`.

`CONTEXTO.md` — acrescentar `## 16. Incremento 4.6 — grupos com representante (duplicatas explícitas)` antes de "Não fizemos", com: o problema (casamento invisível; salário + repasse "fora do resumo" sem memória); por que **grupo com representante** e não "soma que fecha" nem tabela N:M (o Caio: "um grupo funciona como uma linha; só um representa"); por que a regra "quem conta" virou coluna gerada (um lugar só, auditável, e as 7 leituras mudam um identificador); por que apagar/tirar o representante recusa em vez de promover alguém (ambíguo — o Caio escolhe); por que membros não são editáveis (evita editar "o lado que não conta" achando que conta); por que o caso salário ficou fora do modelo e como o modelo o cobre mesmo assim.

`BACKLOG.md` — em "Em andamento", X1 passa a "Fase A entregue (dd/mm); Fase B (import grava grupo) em andamento".

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CONTEXTO.md BACKLOG.md
git commit -m "docs: Inc 4.6 Fase A — grupos com representante (CLAUDE, CONTEXTO §16, BACKLOG)"
```

---

# FASE B — import do extrato grava o grupo

### Task 8: `db.js` — candidatos ao casamento e `aplicarImportacao` com grupo

**Files:**
- Modify: `worker/db.js` (`qInserirTransacao`, `transacoesNaJanela`, `aplicarImportacao`)
- Test: `worker/db.test.mjs`

**Interfaces:**
- Produces:
  - `qInserirTransacao(t)` aceita `t.grupo_id` (default null) e `t.representante` (default false).
  - `db.transacoesNaJanela(de, ate) → [{ id, data, valorCents, grupo_id }]`, só candidatas legítimas.
  - `db.aplicarImportacao({ novos, naoGasto, casados })` com `casados: [{ linha, matchId, grupoExistente }]` → `{ gravados, agrupados, naoGasto }`.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar ao fim de `worker/db.test.mjs`:

```js
test("transacoesNaJanela: só candidatas legítimas ao casamento (nem extrato/fatura, nem hash antigo, nem grupo que já tem extrato) e devolve grupo_id", async () => {
  const sql = fakeSql([{ id: "m1", data: "2026-09-02", valor_cents: "250000", grupo_id: "G0" }]);
  const db = criarDb(sql);
  const r = await db.transacoesNaJanela("2026-09-01", "2026-09-30");
  const q = sql.chamadas[0].text;
  assert.match(q, /fonte not in \('extrato', ?'fatura'\)/i);
  assert.match(q, /linha_hash is null/i);
  assert.match(q, /not exists \(select 1 from transacoes x where x\.grupo_id = t\.grupo_id and x\.fonte = 'extrato'\)/i);
  assert.deepEqual(r, [{ id: "m1", data: "2026-09-02", valorCents: 250000, grupo_id: "G0" }]);
});

test("aplicarImportacao: casado insere a linha do extrato no grupo e põe o casado como representante (grupo novo) — tudo numa transação", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const linha = { dataISO: "2026-09-30", natureza: "despesa", esfera: "pessoal", valorCents: 250000, reembolsoCents: 0,
    categoria_id: "cCasa", subcategoria_id: null, descricao: "PIX ALUGUEL", fonte: "extrato", origem_categoria: "modelo",
    computa_resumo: true, linha_hash: "h1", grupo_id: "G1", representante: false };
  const r = await db.aplicarImportacao({ novos: [], naoGasto: [], casados: [{ linha, matchId: "m1", grupoExistente: false }] });
  assert.deepEqual(r, { gravados: 0, agrupados: 1, naoGasto: 0 });
  assert.equal(sql.transacao.length, 2);
  assert.match(sql.chamadas[0].text, /insert into transacoes/i);
  assert.match(sql.chamadas[0].text, /grupo_id, representante\)/i);
  assert.ok(sql.chamadas[0].values.includes("G1") && sql.chamadas[0].values.includes(false));
  assert.match(sql.chamadas[1].text, /update transacoes set grupo_id = \?, representante = true where id = \? and grupo_id is null/i);
  assert.deepEqual(sql.chamadas[1].values, ["G1", "m1"]);
});

test("aplicarImportacao: casado com grupoExistente só insere a linha do extrato (representante fica quem era)", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const linha = { dataISO: "2026-09-30", natureza: "despesa", esfera: "pessoal", valorCents: 250000, categoria_id: "cCasa",
    descricao: "PIX ALUGUEL", fonte: "extrato", origem_categoria: "modelo", computa_resumo: true, linha_hash: "h1", grupo_id: "G0", representante: false };
  await db.aplicarImportacao({ casados: [{ linha, matchId: "m1", grupoExistente: true }] });
  assert.equal(sql.transacao.length, 1);
  assert.match(sql.chamadas[0].text, /insert into transacoes/i);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test worker/db.test.mjs`
Expected: 3 falhas (regex de `fonte not in`, `grupo_id` ausente no insert, `linhaHash` esperado pelo formato antigo). Os testes antigos de `aplicarImportacao` em `worker/db.test.mjs` (linhas ~374 e ~392) usam `casados: [{matchId, linhaHash}]` e esperam a chave `conciliados` no retorno — **atualizá-los** no Step 3 pro formato novo `{ linha, matchId, grupoExistente }` e pra chave `agrupados`. Os fakes de `aplicarImportacao` em `worker/importar.test.mjs:152` e `worker/index.test.mjs:314` (e o assert em `importar.test.mjs:165`) também devolvem `conciliados` → trocar por `agrupados`.

- [ ] **Step 3: Implementar**

`qInserirTransacao` — acrescentar as duas colunas (lista de colunas e `values`):

```js
       contraparte_nome, contraparte_chave, computa_resumo, linha_hash, grupo_id, representante)
    ...
       ${t.computa_resumo ?? true}, ${t.linha_hash ?? null}, ${t.grupo_id ?? null}, ${t.representante ?? false})
```

`transacoesNaJanela`:

```js
    // Candidatas ao casamento do import (Inc 4.6): lançamentos do Caio (não extrato/fatura), sem
    // hash antigo carimbado (= já conciliado no modelo velho) e que não estejam num grupo que já
    // tem uma linha de extrato (um lançamento casa com o banco UMA vez). Devolve grupo_id pra o
    // app decidir "entra no grupo existente" vs "grupo novo".
    async transacoesNaJanela(de, ate) {
      const rows = await sql`
        select id, to_char(data,'YYYY-MM-DD') as data,
          (round(valor_final*100))::bigint as valor_cents, grupo_id
        from transacoes t
        where data between ${de} and ${ate}
          and fonte not in ('extrato','fatura')
          and linha_hash is null
          and not exists (select 1 from transacoes x where x.grupo_id = t.grupo_id and x.fonte = 'extrato')`;
      return rows.map(r => ({ id: String(r.id), data: r.data, valorCents: Number(r.valor_cents), grupo_id: r.grupo_id ?? null }));
    },
```

`aplicarImportacao`:

```js
    // Inc 4.6: um "casado" não carimba mais o hash no lançamento do Caio — INSERE a linha do
    // extrato (com o hash, dentro do grupo, sem ser representante) e, se o grupo é novo, põe o
    // lançamento casado como representante. Se ele já estava num grupo, só a linha entra nele.
    async aplicarImportacao({ novos = [], naoGasto = [], casados = [] }) {
      const queries = [];
      for (const t of [...novos, ...naoGasto]) queries.push(qInserirTransacao(t));
      for (const c of casados) {
        queries.push(qInserirTransacao(c.linha));
        if (!c.grupoExistente) {
          queries.push(sql`update transacoes set grupo_id = ${c.linha.grupo_id}, representante = true where id = ${c.matchId} and grupo_id is null`);
        }
      }
      if (queries.length) await sql.transaction(queries);
      return { gravados: novos.length + naoGasto.length, agrupados: casados.length, naoGasto: naoGasto.length };
    },
```

Remover `carimbarLinhaHash` de `db.js` se nada mais a referenciar (`grep -n carimbarLinhaHash worker/ public/`); ajustar/remover o teste dela.

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: verde (com o teste antigo de `aplicarImportacao` atualizado pro formato novo).

- [ ] **Step 5: Commit**

```bash
git add worker/db.js worker/db.test.mjs
git commit -m "feat: import — candidatos ao casamento por grupo e aplicarImportacao grava a linha do extrato no grupo"
```

---

### Task 9: `matchGrupoId` no casamento e `montarDecisao` com linha do extrato

**Files:**
- Modify: `worker/reconciliar.js`, `worker/reconciliar.test.mjs`, `worker/importar.js`, `worker/importar.test.mjs`
- Modify: `public/app.js` (`montarDecisao`, `resumoTexto`, mensagem de resultado da aba Importar)
- Test: `worker/reconciliar.test.mjs`, `worker/importar.test.mjs`, `public/app.test.mjs`

**Interfaces:**
- `reconciliarLinha(linha, existentes) → { status, matchId, matchGrupoId }` (existentes agora trazem `grupo_id`).
- Itens do preview de extrato ganham `matchGrupoId` (null exceto em `casado` com candidata já agrupada).
- `montarDecisao(preview, catalogo, fonte, gerarId = () => crypto.randomUUID()) → { novos, naoGasto, casados: [{ linha, matchId, grupoExistente }] }`.

- [ ] **Step 1: Testes que falham**

`worker/reconciliar.test.mjs` — acrescentar (e ajustar os `deepEqual` existentes pra incluir `matchGrupoId: null`):

```js
test("reconciliarLinha: casado devolve matchGrupoId da candidata (null se ela não tem grupo)", () => {
  const linha = { data: "2026-09-30", valorCents: 250000 };
  const semGrupo = [{ id: "m1", data: "2026-09-29", valorCents: 250000, grupo_id: null }];
  assert.deepEqual(reconciliarLinha(linha, semGrupo), { status: "casado", matchId: "m1", matchGrupoId: null });
  const comGrupo = [{ id: "m1", data: "2026-09-29", valorCents: 250000, grupo_id: "G0" }];
  assert.deepEqual(reconciliarLinha(linha, comGrupo), { status: "casado", matchId: "m1", matchGrupoId: "G0" });
});
```

`worker/importar.test.mjs` — acrescentar (usa `TXT`/`catalogo` já definidos no topo do arquivo; a existente `t9` de 2025-12-10/R$ 100,00 casa com a 1ª linha do `TXT`, como no teste de reconciliação que já existe na linha ~21):

```js
test("montarPreviewExtrato: item casado carrega o matchGrupoId da candidata (null se ela está solta)", () => {
  const solta = montarPreviewExtrato(TXT, "c1", { catalogo, associacoes: {}, existentes: [{ id: "t9", data: "2025-12-10", valorCents: 10000 }], hashes: [] });
  const casado = solta.itens.find(i => i.status === "casado");
  assert.equal(casado.matchId, "t9");
  assert.equal(casado.matchGrupoId, null);
  assert.ok(solta.itens.filter(i => i.status !== "casado").every(i => i.matchGrupoId === null), "não-casados levam null");
  const agrupada = montarPreviewExtrato(TXT, "c1", { catalogo, associacoes: {}, existentes: [{ id: "t9", data: "2025-12-10", valorCents: 10000, grupo_id: "G0" }], hashes: [] });
  assert.equal(agrupada.itens.find(i => i.status === "casado").matchGrupoId, "G0");
});
```

`public/app.test.mjs` — acrescentar:

```js
test("montarDecisao: casado vira linha do extrato dentro do grupo (novo ou existente), nunca só um carimbo", () => {
  const preview = previewFixture();
  // o item "casado" da fixture é o de status "casado" (h3): com matchGrupoId null → grupo novo
  const d = montarDecisao(preview, CATALOGO_IMPORT, "extrato", () => "G-novo");
  assert.equal(d.casados.length, 1);
  const c = d.casados[0];
  assert.equal(c.matchId, "m1");
  assert.equal(c.grupoExistente, false);
  assert.equal(c.linha.grupo_id, "G-novo");
  assert.equal(c.linha.representante, false);
  assert.equal(c.linha.fonte, "extrato");
  assert.equal(c.linha.linha_hash, "h3");
  assert.equal(c.linha.computa_resumo, true);
  assert.ok(c.linha.categoria_id, "categoria resolvida como um novo (cai na padrão se não houver nome)");
  // com matchGrupoId → reutiliza o grupo e marca grupoExistente
  const p2 = previewFixture();
  p2.itens.find(i => i.status === "casado").matchGrupoId = "G0";
  const d2 = montarDecisao(p2, CATALOGO_IMPORT, "extrato", () => "ignorado");
  assert.equal(d2.casados[0].grupoExistente, true);
  assert.equal(d2.casados[0].linha.grupo_id, "G0");
});
```

(Se o teste existente "montarDecisao: item casado vira {matchId,linhaHash}" ainda existir, **substituí-lo** por este.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: falhas em reconciliar (chave `matchGrupoId` ausente), importar (idem) e app (`casados[0].linha` undefined).

- [ ] **Step 3: Implementar**

`worker/reconciliar.js`:

```js
export function reconciliarLinha(linha, existentes) {
  const cand = existentes.filter(e => e.valorCents === linha.valorCents && dias(linha.data, e.data) <= 3);
  // Inc 4.6: matchGrupoId = grupo da candidata (se já agrupada) — o app usa pra entrar nele.
  if (cand.length === 1) return { status: "casado", matchId: cand[0].id, matchGrupoId: cand[0].grupo_id ?? null };
  if (cand.length > 1) return { status: "ambiguo", matchId: null, matchGrupoId: null };
  return { status: "novo", matchId: null, matchGrupoId: null };
}
```

`worker/importar.js` (`montarPreviewExtrato`): declarar `let matchGrupoId = null;` junto de `matchId`, no ramo `casado` fazer `matchGrupoId = rec.matchGrupoId;`, e incluir `matchGrupoId` no `itens.push({...})` (e `matchGrupoId: null` no push de `jaTem`).

`public/app.js` — `montarDecisao` inteira:

```js
export function montarDecisao(preview, catalogo, fonte, gerarId = () => crypto.randomUUID()) {
  const novos = [], naoGasto = [], casados = [];
  // linha de inserirTransacao a partir de um item do preview (paridade com _gravar do Python)
  const linhaDe = (item) => {
    const nomeCat = item.categoriaOrg || item.categoriaNome || null; // null → padrão
    const { categoria_id, subcategoria_id } = resolverCategoriaImport(nomeCat, item.subNome, catalogo);
    return {
      dataISO: item.data, natureza: item.natureza, esfera: "pessoal",
      valorCents: item.valorCents, reembolsoCents: 0,
      categoria_id, subcategoria_id,
      descricao: item.descricaoFinal ?? item.descricao,
      fonte, origem_categoria: item.categoriaNome ? "regra" : "modelo",
      contraparte_nome: item.contraparteNome,
      computa_resumo: item.computaResumo, linha_hash: item.linhaHash,
    };
  };
  for (const item of preview.itens) {
    if (item.status === "casado") {
      // Inc 4.6: a linha do extrato ENTRA como transação, dentro do grupo do lançamento casado
      // (grupo novo, ou o que ele já tinha); ela nunca é o representante — quem conta é o que o
      // Caio lançou. computa_resumo=true de propósito: se um dia desagrupar, ela volta a contar.
      const grupo_id = item.matchGrupoId || gerarId();
      casados.push({
        matchId: item.matchId, grupoExistente: !!item.matchGrupoId,
        linha: { ...linhaDe(item), computa_resumo: true, grupo_id, representante: false },
      });
      continue;
    }
    if (item.status !== "novo" && item.status !== "naoGasto") continue; // ambiguo/jaTem: skip
    (item.status === "novo" ? novos : naoGasto).push(linhaDe(item));
  }
  return { novos, naoGasto, casados };
}
```

`resumoTexto` (`public/app.js:197`): trocar `conciliados ${r.casados ?? 0}` por `a agrupar ${r.casados ?? 0}`; na mensagem de resultado (`public/app.js:973`), trocar `conciliados ${r.conciliados}` por `agrupados ${r.agrupados ?? 0}`. Rodar `grep -n conciliados public/ worker/` e ajustar os asserts de teste que ainda checarem esse texto. O `carimbarLinhaHash: async () => {}` do fake em `worker/index.test.mjs:403` pode sair (ninguém mais chama).

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test` e `python -m pytest tests/ -q` (o Python não mudou; confirma que continua verde).
Expected: tudo verde.

- [ ] **Step 5: Commit**

```bash
git add worker/reconciliar.js worker/reconciliar.test.mjs worker/importar.js worker/importar.test.mjs public/app.js public/app.test.mjs
git commit -m "feat: import — casado vira linha do extrato dentro do grupo (montarDecisao com grupo_id)"
```

---

### Task 10: Fase B ao vivo — deploy, smoke e docs

**Files:**
- Modify: `CLAUDE.md` (roadmap: 4.6 implementado; parágrafo do import), `CONTEXTO.md` (§16, parágrafo do import), `BACKLOG.md` (X1 sai de "Em andamento")

- [ ] **Step 1: Deploy** — `npx wrangler deploy` (sem migração: a 0009 já está aplicada desde a Fase A).

- [ ] **Step 2: Smoke** — na aba Importar, um extrato com pelo menos um casado: o preview mostra "a agrupar N"; aplicar; em Lançamentos o grupo nasce com a linha do extrato como membro e o lançamento do Caio como representante; Resumo não dobra. Reaplicar o mesmo PDF → "já tinha" (idempotência pelo hash na linha do extrato). Se o lançamento casado já estava num grupo, a linha entra nele e o representante não muda.

- [ ] **Step 3: Docs** — `CLAUDE.md`: na seção "Grupos de transações", acrescentar o parágrafo "**Import:** um casado insere a linha do extrato no grupo do lançamento (novo ou existente), nunca carimba o hash nele; candidatos ao casamento excluem extrato/fatura, hash antigo e grupo que já tem extrato; os importadores Python seguem no modelo antigo (BACKLOG C6)". Roadmap: 4.6 → "implementado (A+B)". `CONTEXTO.md` §16: parágrafo "por que a linha do extrato entra com `computa_resumo=true` (desagrupar tem que devolver a contagem) e por que o grupo nasce no navegador (o servidor só grava, como o resto do fluxo de import)". `BACKLOG.md`: remover X1 de "Em andamento".

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CONTEXTO.md BACKLOG.md
git commit -m "docs: Inc 4.6 Fase B — import grava o grupo (CLAUDE, CONTEXTO §16, BACKLOG)"
```

---

## Ordem e paralelismo

- Tasks 1 → 2 → 3 → 4 em série (cada uma consome a anterior). Task 5 pode rodar em paralelo com 3–4 (só `public/`). Task 6 depende de 4 e 5. Task 7 fecha a Fase A.
- Tasks 8 → 9 em série; Task 10 fecha a Fase B.
- Pares que tocam o mesmo arquivo de teste (`db.test.mjs`: 1, 3, 8; `index.test.mjs`: 4; `app.test.mjs`: 5, 9) não devem ter dois implementadores ao mesmo tempo.
