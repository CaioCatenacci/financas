# Gestão de categorias (FK) + Pessoa (Inc 2.5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) para executar task-a-task. Steps usam checkbox (`- [ ]`).

**Goal:** Migrar categorias para modelo ID/FK (renome/merge triviais), genericizar os termos, e trazer Pessoa como dropdown gerenciável — editável na tabela e com corte no Resumo.

**Architecture:** Duas fases. Fase A entrega Pessoa (tabela `pessoas` + `pessoa_id` FK + UI + corte). Fase B migra categorias/subcategorias para tabelas por id (com genericização no backfill), refatora db/extração/app para usar ids, e adiciona a tela de gestão (CRUD + merge). Migração em duas etapas (aditiva → cutover → limpeza) pra não quebrar produção.

**Tech Stack:** Cloudflare Workers (JS ESM), `@neondatabase/serverless`, Neon Postgres, Gemini/Claude, HTML+JS vanilla, Python (import/lote). Testes: `node --test` + `pytest`.

**Spec:** `docs/superpowers/specs/2026-09-03-gestao-categorias-pessoa-design.md`

## Global Constraints
- Branch novo `inc25-categorias` (não no master direto). Dinheiro em centavos/SQL. ES modules. Comentários/testes em português (o *porquê*).
- Migração aplicada no Neon nos checkpoints de infra (controller), como nos Incs anteriores; `DATABASE_URL` do `.dev.vars`, sem exibir.
- **Migração em 2 etapas:** aditiva (ids convivem com strings) → cutover do código → limpeza (drop das strings). Nunca dropar coluna antes do código usar ids.
- UI: "Categoria/Subcategoria/Pessoa". Vocabulário fixo de `origem_categoria` segue {modelo,manual,regra}.
- Extração: modelo devolve NOMES; grava resolvendo nome→id; nome desconhecido → fallback `Outros` (garantir que exista). Logar fallback.
- `npm test` (auto-discovery) e `python -m pytest tests/` antes de cada commit.
- Genericização: o **mapa** é gerado das categorias vivas na execução e **aprovado pelo Caio** antes de aplicar (B1). Não inventar aqui.

## Estrutura de arquivos
```
migrations/0003_pessoas.sql          NOVO — pessoas + transacoes.pessoa_id + backfill (Fase A)
migrations/0004_categorias_fk.sql    NOVO — categorias/subcategorias + *_id + backfill genericizado (Fase B)
migrations/0005_drop_strings.sql     NOVO — limpeza (drop colunas string) após cutover
worker/categorias.js                 NOVO — resolver nome→id, montar selects (puro, testável)
worker/categorias.test.mjs           NOVO
worker/db.js                         MOD — ids/joins, CRUD, merge, resumo por pessoa, associacoes por id
worker/index.js                      MOD — resolve nome→id na captura; regra por id
public/index.html / app.js / shell.css  MOD — selects por id, Pessoa dropdown, aba de gestão, corte por pessoa
tools/import_planilha.py / ensino_*.py   MOD — resolver nome→id
CLAUDE.md / CONTEXTO.md              MOD
```

---

## FASE A — Pessoa

### Task A1: Migração 0003 (pessoas + pessoa_id + backfill)
**Files:** Create `migrations/0003_pessoas.sql`; Modify `schema.sql`. (Controller-authored: DDL + aplicar/verificar no Neon.)
- [ ] **Step 1:** Escrever `migrations/0003_pessoas.sql`:
```sql
create table if not exists pessoas (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  ativa boolean not null default true
);
insert into pessoas (nome) values ('Caio'),('Paola'),('Lucca'),('Manuela'),('Casa')
  on conflict (nome) do nothing;
-- traz nomes de pessoa já existentes nas transacoes
insert into pessoas (nome)
  select distinct pessoa from transacoes where pessoa is not null and pessoa <> ''
  on conflict (nome) do nothing;
alter table transacoes add column if not exists pessoa_id uuid references pessoas(id);
update transacoes t set pessoa_id = p.id from pessoas p
  where t.pessoa is not null and t.pessoa = p.nome and t.pessoa_id is null;
```
- [ ] **Step 2:** Refletir no `schema.sql` (tabela `pessoas` + coluna `pessoa_id`). (Confirmar semente de pessoas com o Caio — §11 da spec — antes de aplicar.)
- [ ] **Step 3:** Aplicar no Neon (via psycopg, `DATABASE_URL` do `.dev.vars`) e verificar: `pessoas` existe; `select count(*) from transacoes where pessoa_id is not null` ≥ nº de linhas que tinham `pessoa`.
- [ ] **Step 4:** Commit `feat: migração 0003 (pessoas + pessoa_id + backfill)`.

### Task A2: db.js — pessoa por id + resumo por pessoa
**Files:** Modify `worker/db.js`, `worker/db.test.mjs`.
**Interfaces produces:** `listarPessoas()`; `atualizarTransacao` aceita `c.pessoa_id`; `listarTransacoes` retorna `pessoa` (nome via join); `resumoPorPessoa(de, ate)` → `[{pessoa, natureza, total}]`.
- [ ] **Step 1 (RED):** testes em `db.test.mjs` (fakeSql): `listarPessoas` consulta `from pessoas where ativa`; `atualizarTransacao` com `{pessoa_id}` inclui o valor no UPDATE; `resumoPorPessoa` filtra por intervalo e agrupa por pessoa+natureza (join pessoas).
- [ ] **Step 2 (GREEN):** implementar:
  - `listarPessoas()` → ``sql`select id, nome from pessoas where ativa order by nome` ``
  - em `atualizarTransacao`, tratar `pessoa_id` (undefined = manter; incluir no set).
  - `listarTransacoes` → `left join pessoas p on p.id = t.pessoa_id`, retornando `p.nome as pessoa`.
  - `resumoPorPessoa(de,ate)` → ``sql`select coalesce(p.nome,'—') as pessoa, t.natureza, sum(t.valor_final) as total from transacoes t left join pessoas p on p.id=t.pessoa_id where t.data>=${de} and t.data<=${ate} group by 1,2 order by 3 desc` ``
- [ ] **Step 3:** `npm test` PASS. Commit `feat: db pessoa por id + resumo por pessoa`.

### Task A3: /api — pessoas + resumo por pessoa
**Files:** Modify `worker/index.js`, `worker/index.test.mjs`.
**Interfaces:** `GET /api/pessoas` → lista; `/api/resumo` passa a incluir `porPessoa`; PATCH `/api/transacoes/:id` aceita `pessoa_id` (já passa `request.json()` → `atualizarTransacao`, então só depende da A2).
- [ ] **Step 1 (RED):** teste (handleApi) — `GET /api/pessoas` retorna a lista (mock db.listarPessoas); `/api/resumo` inclui `porPessoa`.
- [ ] **Step 2 (GREEN):** adicionar rota `/api/pessoas` e `porPessoa: await db.resumoPorPessoa(de, ate)` no `/api/resumo`.
- [ ] **Step 3:** `npm test` PASS. Commit `feat: /api pessoas + resumo por pessoa`.

### Task A4: App — Pessoa na tabela + corte no Resumo
**Files:** Modify `public/index.html`, `public/app.js`, `public/app.test.mjs`, `public/shell.css`.
**Interfaces:** `agruparPorPessoa(rows)` (puro, testado) → `[{pessoa, despesa, receita, saldo}]`.
- [ ] **Step 1 (RED):** teste de `agruparPorPessoa` em `app.test.mjs`.
- [ ] **Step 2 (GREEN):** implementar `agruparPorPessoa`; carregar `estado.pessoas` de `/api/pessoas`; em `drawRows`, adicionar coluna **Pessoa** como `<select>` (opções de pessoas + vazio) → `PATCH {pessoa_id}`; cabeçalho "Pessoa".
- [ ] **Step 3:** Resumo — novo painel **"Gasto por pessoa"** (barras) a partir de `resumo.porPessoa` (usar `agruparPorPessoa`); cores dos tokens; hover.
- [ ] **Step 4:** `npm test` PASS. Verificação visual (controller, mock). Commit `feat: app — Pessoa editável na tabela + corte por pessoa no Resumo`.

### Task A5: Docs Fase A
- [ ] Atualizar CLAUDE.md (tabela `pessoas`, `pessoa_id`) e CONTEXTO.md (decisão dropdown fixo + corte por pessoa). Commit.

**Checkpoint infra Fase A:** aplicar 0003 no Neon (A1), `npm test`+`pytest`, deploy, conferir dropdown/edição/corte no app ao vivo.

---

## FASE B — Categorias FK + genericização + tela de gestão

### Task B1: Mapa de genericização (execução, com aprovação)
**Files:** gera `docs/genericizacao-map.csv` (não versionar dados sensíveis? é só nomes de categoria — ok versionar).
- [ ] **Step 1:** Consultar as categorias/subs vivas (controller, via psycopg): `select distinct macro, sub from transacoes order by 1,2`.
- [ ] **Step 2:** Propor um CSV `macro_atual, sub_atual, categoria_nova, subcategoria_nova, descricao_sugerida` (assistente preenche o alvo genérico; ex.: "Mensalidade Escola Iguatemi"→ Educação/Escola/Colégio Iguatemi).
- [ ] **Step 3:** Caio revisa/edita e **aprova**. Este CSV alimenta o backfill da B2. (Sem aprovação, B2 não roda.)

### Task B2: Migração 0004 (categorias/subcategorias FK + backfill genericizado)
**Files:** Create `migrations/0004_categorias_fk.sql`; Modify `schema.sql`. (Controller-authored + script de backfill que lê o CSV aprovado.)
- [ ] **Step 1:** DDL aditiva: criar `categorias`(nova, `id,nome,natureza,ativa`), `subcategorias`(`id,categoria_id,nome,ativa`); adicionar `transacoes.categoria_id/subcategoria_id`, `associacoes.categoria_id/subcategoria_id`. Garantir categoria `Outros` (fallback).
- [ ] **Step 2:** Backfill (script Python, lê o CSV aprovado): inserir categorias/subs genéricas; mapear cada `(macro,sub)` das `transacoes`→`categoria_id/subcategoria_id`; onde o mapa indicar, mover favorecido pra `descricao` (só se `descricao` vazia/redundante); idem para `associacoes`. **Relatório**: nº de transações remapeadas por par; linhas sem mapa (viram `Outros`).
- [ ] **Step 3:** Verificar: toda transação com `categoria_id` preenchido; contagem antes/depois por categoria coerente.
- [ ] **Step 4:** Commit `feat: migração 0004 (categorias/subcategorias FK + backfill genericizado)`.

### Task B3: `categorias.js` — resolução e selects (puro)
**Files:** Create `worker/categorias.js`, `worker/categorias.test.mjs`.
**Interfaces:** `resolverCategoria(nomeMacro, nomeSub, catalogo) -> {categoria_id, subcategoria_id}` (fallback `Outros` quando macro não existe; sub null se não casar); `subsDaCategoria(catalogo, categoria_id) -> [{id,nome}]`. `catalogo` = `{categorias:[{id,nome}], subcategorias:[{id,categoria_id,nome}]}`.
- [ ] TDD RED→GREEN com casos: nome existente → ids; macro inexistente → Outros; sub inexistente → null.

### Task B4: db.js — ids, joins, CRUD, merge, associacoes por id
**Files:** Modify `worker/db.js`, `worker/db.test.mjs`.
**Interfaces:** `catalogo()` (categorias+subcategorias); `listarTransacoes` join → nomes; `inserirTransacao`/`atualizarTransacao` por `categoria_id/subcategoria_id`; `buscarAssociacao`/`upsertAssociacao` por id; CRUD `criarCategoria/renomearCategoria/criarSub/renomearSub/mergeSub(origem_id,destino_id)/desativar*`; `resumoPorCategoria` por join.
- [ ] TDD (fakeSql) para cada: em especial `mergeSub` deve `update transacoes set subcategoria_id=destino where subcategoria_id=origem` **e** o mesmo em `associacoes`, depois desativar/remover a origem. Commit.

### Task B5: index.js + /api — captura por id + endpoints de gestão
**Files:** Modify `worker/index.js`, `worker/index.test.mjs`.
- [ ] Captura: após extração, `resolverCategoria(n.macro, n.sub, catalogo)` → ids; regra aprendida sobrepõe por id; `inserirTransacao` por id. Teach idem (grava associação por id).
- [ ] `/api`: `GET /api/catalogo`; POST/PATCH/DELETE `/api/categorias`, `/api/subcategorias` (incl. merge), `/api/pessoas`; transação PATCH aceita `categoria_id/subcategoria_id`. TDD. Commit.

### Task B6: App — selects por id + tela de gestão
**Files:** Modify `public/index.html`, `public/app.js`, `public/app.test.mjs`, `public/shell.css`.
- [ ] Lançamentos: Categoria/Subcategoria viram selects por id (sub filtrada pela categoria via catálogo); mantém Pessoa (Fase A).
- [ ] Nova aba **"Ajustes"**: gerir categorias (add/rename/ativar), subcategorias (add/rename/**merge**/mover/ativar), pessoas (add/rename/ativar) — chamando os endpoints da B5.
- [ ] Pure test: `subsDaCategoria`/montagem dos selects. Verificação visual (controller). Commit.

### Task B7: import & lote por id
**Files:** Modify `tools/import_planilha.py`, `tools/ensino_extrair.py`, `tools/ensino_aplicar.py`.
- [ ] Resolver nome→id (consultando as tabelas) ao inserir transações/associações. Testes das funções puras de resolução. Commit.

### Task B8: Migração 0005 (limpeza) — após cutover validado
**Files:** Create `migrations/0005_drop_strings.sql`; Modify `schema.sql`.
- [ ] Tornar `transacoes.categoria_id` NOT NULL; **drop** `transacoes.macro/sub` (e `pessoa` string, já coberta por pessoa_id), `associacoes.macro/sub`; substituir a `categorias` antiga. Só depois de B5/B6 em produção OK. Commit.

### Task B9: Docs Fase B
- [ ] CLAUDE.md (modelo FK: categorias/subcategorias/pessoas; extração resolve nome→id; fallback Outros) e CONTEXTO.md (decisão FK + genericização). Commit.

**Checkpoint infra Fase B:** aprovar mapa (B1) → aplicar 0004 → cutover (deploy B4–B7) → validar em produção → aplicar 0005 (limpeza).

---

## Self-Review (a completar ao finalizar a escrita)
- Cobertura da spec: Pessoa (A1–A5) ✓; FK/genericização/tela (B1–B9) ✓; migração 2 etapas (0003 aditiva / 0004 aditiva / 0005 limpeza) ✓; extração nome→id + fallback (B3–B5) ✓; corte por pessoa (A2–A4) ✓.
- Ordem/segurança: nada dropa string antes do código por id (0005 por último).
- **Nota de tamanho:** é um incremento grande; Fase A é entregável sozinha (deploy independente) antes de começar a Fase B. Reavaliar decompor a Fase B se necessário na hora.
