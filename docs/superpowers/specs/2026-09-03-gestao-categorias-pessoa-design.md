# Incremento 2.5 — Gestão de categorias (ID/FK), genericização e Pessoa

**Data:** 2026-09-03
**Status:** desenho aprovado na conversa; aguardando execução (quota) → depois vira plano
**Projeto:** `C:\Users\caioc\Caio\financas` (Inc 1 e Inc 2 em produção)

---

## 1. Contexto e problema

As categorias foram **semeadas automaticamente** da planilha (10 macros + ~subs recorrentes),
com termos específicos demais ("Mensalidade Escola Iguatemi", "Fatura Cartão de Crédito
Nubank"). Hoje:
- Categoria/subcategoria são **strings** guardadas em `transacoes` e em `associacoes` → renomear/
  mesclar exige cascata frágil e não há tela pra gerenciar.
- O campo **`pessoa`** existe no banco e foi importado, mas **não aparece nem é editável** na
  interface — o Caio usa pra separar, p.ex., escola do Lucca vs da Manuela.

O Caio quer: (a) **migrar categorias pra ID/FK** (renome/merge triviais), (b) **genericizar** os
termos agora, e (c) trazer **Pessoa** como dropdown de lista fixa, editável, com **corte no Resumo**.

Modelo mental alvo (exemplo escola): `categoria=Educação`, `subcategoria=Escola`,
`pessoa=Lucca|Manuela`, `descrição=Colégio Iguatemi` (o favorecido vai pra descrição).

## 2. Decisões

| Tema | Decisão |
|---|---|
| Modelo de categoria | **ID/FK** — tabelas `categorias` e `subcategorias`; `transacoes` e `associacoes` referenciam por id. |
| Pessoa | **Lista fixa gerenciável** (tabela `pessoas`); `transacoes.pessoa_id` FK; editável na tabela; **corte no Resumo**. |
| Genericização | **Agora**, durante a migração. Favorecido específico vai pra `descricao`; subcategoria vira genérica. |
| Mapa de genericização | **Produzido na execução** a partir das categorias vivas (o assistente propõe, o Caio aprova) — não inventado agora. |
| Renome/merge depois | Trivial no modelo FK (muda o `nome` da linha; as transações seguem por id). |

## 3. Modelo de dados alvo (migração 0003)

```sql
-- macros
create table categorias (
  id       uuid primary key default gen_random_uuid(),
  nome     text not null unique,
  natureza text not null default 'despesa' check (natureza in ('despesa','receita')),
  ativa    boolean not null default true
);
-- subs (pertencem a uma categoria)
create table subcategorias (
  id           uuid primary key default gen_random_uuid(),
  categoria_id uuid not null references categorias(id),
  nome         text not null,
  ativa        boolean not null default true,
  unique (categoria_id, nome)
);
-- pessoas (dropdown gerenciável)
create table pessoas (
  id    uuid primary key default gen_random_uuid(),
  nome  text not null unique,
  ativa boolean not null default true
);
```
`transacoes` ganha (mantendo as colunas string durante a transição):
```sql
alter table transacoes add column categoria_id    uuid references categorias(id);
alter table transacoes add column subcategoria_id uuid references subcategorias(id);
alter table transacoes add column pessoa_id        uuid references pessoas(id);
```
`associacoes` migra de (macro, sub) string para:
```sql
alter table associacoes add column categoria_id    uuid references categorias(id);
alter table associacoes add column subcategoria_id uuid references subcategorias(id);
```
Após o corte completo (código usando ids), uma migração posterior **remove** as colunas string
(`transacoes.macro/sub/pessoa`, `associacoes.macro/sub`, a tabela `categorias` antiga é
substituída pela nova). Ver §7 (estratégia de migração em duas etapas).

**Semente `pessoas`** (inicial, editável na tela — confirmar): Caio, Paola, Lucca, Manuela, Casa.

## 4. Genericização (reshape dos dados)

Na migração, cada `(macro, sub)` string atual é mapeado para `(categoria, subcategoria)` genérico,
e o **favorecido específico** vai pra `descricao` quando fizer sentido. Exemplos do tipo alvo:

| Atual (macro › sub) | Vira categoria › sub | descrição (favorecido) |
|---|---|---|
| Educação › Mensalidade Escola Iguatemi | Educação › Escola | Colégio Iguatemi |
| Educação › Mensalidade Escola +Educar | Educação › Escola | +Educar |
| Pessoal › Fatura Cartão de Crédito Nubank | Pessoal › Fatura de cartão | Nubank |
| Saúde › Plano de Saúde Amil | Saúde › Plano de saúde | Amil |

- O **mapa completo** dos pares vivos é gerado na execução (consulta as `categorias` atuais),
  apresentado como CSV/tabela pro Caio **aprovar/ajustar** antes de aplicar.
- A `descricao` histórica hoje repete o rótulo do Gasto; a migração move o favorecido pra
  `descricao` e aponta a `subcategoria_id` genérica. Onde a `descricao` já for específica, mantém.
- Idempotente/reversível: guardar o mapa aplicado (arquivo versionado em `migrations/` ou um
  dump) pra auditar.

## 5. Interface

### Tela de gestão (nova aba "Categorias" / "Ajustes")
- **Categorias:** listar, adicionar, renomear, ativar/desativar. (Renome = muda `nome`; nada mais.)
- **Subcategorias:** por categoria — adicionar, renomear, **mesclar** (mover transações da sub A→B),
  mover pra outra categoria, ativar/desativar.
- **Pessoas:** listar, adicionar, renomear, ativar/desativar.
- **Merge** é a operação-chave da genericização contínua: escolher sub origem → sub destino →
  as `transacoes` e `associacoes` que apontam pra origem passam a apontar pro destino (por id;
  trivial), e a origem é desativada/removida.

### Lançamentos (tabela)
- **Categoria** e **Subcategoria** viram selects vindos das tabelas (sub filtrada pela categoria).
- **Pessoa**: novo select (dropdown) de `pessoas`, **editável** (PATCH `pessoa_id`).
- **Descrição** segue editável (já é).

### Resumo
- Novo **corte por pessoa** (gasto por Lucca/Manuela/…): um painel (barras ou dumbbell) e/ou um
  filtro de pessoa aplicável aos painéis existentes.

## 6. Backend / código afetado

- **db.js:** inserts/updates passam a gravar `categoria_id`/`subcategoria_id`/`pessoa_id`;
  listagens fazem **join** pra devolver os nomes; novas queries de gestão (CRUD + merge) e o
  **corte por pessoa** no resumo; `associacoes` por id.
- **extração/index.js:** o modelo devolve **nomes** de categoria/sub; ao gravar, resolve
  **nome→id** (via tabelas); se o nome não existir, cai num default (`Outros`, que deve existir).
  A regra aprendida (`buscarAssociacao`) passa a devolver ids.
- **/api:** endpoints de gestão (`/api/categorias`, `/api/subcategorias`, `/api/pessoas` com
  POST/PATCH/DELETE) e o resumo por pessoa; os payloads de transação passam a usar ids.
- **import & lote (tools):** `import_planilha.py` e `ensino_*.py` passam a resolver nome→id;
  `contraparte.py` inalterado.
- **Vocabulário:** o CLAUDE.md deixa de tratar macro/sub como o identificador; documenta o modelo
  FK e a UI ("Categoria/Subcategoria/Pessoa").

## 7. Estratégia de migração (duas etapas, segura)

Pra não quebrar o app em produção durante a troca:
1. **0003 — aditiva:** cria `categorias`(nova)/`subcategorias`/`pessoas`, adiciona as colunas
   `*_id` (nullable), e **backfill**: popula as tabelas a partir dos strings atuais + aplica o
   **mapa de genericização aprovado**; preenche `categoria_id`/`subcategoria_id`/`pessoa_id` das
   `transacoes` e `associacoes`. Nesse ponto strings e ids coexistem.
2. **Cutover:** o código passa a **ler/gravar por id** (com join pros nomes). Testar em produção.
3. **0004 — limpeza:** torna `categoria_id` NOT NULL, remove as colunas string
   (`transacoes.macro/sub/pessoa`, `associacoes.macro/sub`) e a tabela `categorias` antiga.

## 8. Testes
- Puros: resolução nome→id (fallback pra Outros), merge (remapeamento), agrupamento do corte por
  pessoa, montagem dos selects (sub por categoria).
- db (fakeSql): inserts com ids, joins de listagem, CRUD e merge, resumo por pessoa, associacoes por id.
- Migração: backfill idempotente + relatório (quantas transações remapeadas por par); um teste do
  mapa de genericização (entrada→saída) com casos representativos.
- Integração: capturar imagem → nome→id; corrigir no app → regra por id; próximo → auto-aplica.

## 9. Escopo / faseamento

Grande — dá pra fasear no plano:
- **Fase A (Pessoa):** `pessoas` + `pessoa_id` + dropdown editável na tabela + corte no Resumo.
  Menor e independente; entrega "gasto por filho" cedo.
- **Fase B (Categorias FK + genericização + tela de gestão):** o grosso — migração 0003/0004,
  refactor pra id, tela de gestão (categorias/subs/merge), mapa de genericização aprovado.

## 10. Fora de escopo / riscos
- **Fora:** relatórios avançados por pessoa (só o corte básico); PJ (Inc 5); investimentos (Inc 6).
- **Risco (migração):** backfill precisa casar strings→ids sem perder linha; mitigado pelo
  relatório (contagem antes/depois) e pela etapa aditiva antes da limpeza.
- **Risco (genericização):** um merge errado junta gastos distintos; mitigado por o Caio **aprovar
  o mapa** antes e por o merge ser reversível enquanto as colunas string existirem (até a 0004).
- **Risco (extração nome→id):** modelo devolve nome fora da lista → fallback `Outros` (garantir que
  `Outros` exista); logar quando cair no fallback.
- **Pessoa em imagem:** o comprovante não diz de quem é → `pessoa_id` fica manual (editar no app).

## 11. Perguntas em aberto (resolver no início da execução)
- Semente da lista de **pessoas** (confirmar: Caio, Paola, Lucca, Manuela, Casa?).
- O **mapa de genericização** exato (gerado das categorias vivas, Caio aprova).
- Corte por pessoa no Resumo: **painel próprio** (barras por pessoa) ou **filtro** que reaplica aos
  painéis existentes — ou ambos.
