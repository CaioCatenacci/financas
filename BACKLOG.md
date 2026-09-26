# Backlog — Financas

Lista única do que ficou pra depois. Antes deste arquivo, o backlog vivia espalhado nas
seções "Fora de escopo / diferido" das specs (`docs/superpowers/specs/`), na tabela "Não
fizemos" do `CONTEXTO.md` e nos "minors deferred" dos ledgers de execução (não versionados).
A partir daqui, **tudo que se decide adiar entra aqui**, com a origem. Quando um item vira
incremento, sai daqui e ganha spec/plan como os outros.

**Desde 26/09/2026 o que vai ser feito vira card em `fila/`** (um `.md` por item, com
DoD conferível; ver `CLAUDE.md`, "A fila autônoma"). Este arquivo segue como
reservatório de ideias ainda sem card: quando um item ganha `fila/<id>.md`, a linha sai
daqui.

Regra de priorização (a mesma do projeto): dor real no uso diário primeiro; incremento só
entra se entrega valor de ponta a ponta; desconfiar de infraestrutura.

Legenda de prioridade: **P1** = próximo a fazer · **P2** = vale a pena, sem urgência ·
**P3** = só se fizer falta.

---

## Onde foram os itens

Em 26/09/2026 todos os itens abertos viraram cards em `fila/`, **com o mesmo id**
(A1, B2…F6), para refinar. A ordem está em `fila/ORDEM.md` (P2 em Próximo, P3 em Depois).

## Resolvidos (registro)

| # | Item | Como fechou |
|---|---|---|
| B1 | Telegram sem retorno (fallback de categoria por nome) | `0008` aplicada no Neon e deploy de 26/09 depois do fix — conferido em 26/09/2026 (`categorias.padrao` = 1 linha) |
| B6 | Regex de data exigia zero-padding | `worker/validar.js` aceita `d/m/aaaa` e zero-preenche; teste "aceita data não-padronizada e zero-preenche" |
| E3 | Cross-check `categoria.natureza` × `transacao.natureza` | natureza segue a categoria ao reclassificar (`naturezaAoReclassificar`), 25/09/2026; texto manual em 26/09 |

## Ideias ainda sem card

(nenhuma)
