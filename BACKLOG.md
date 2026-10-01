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
| B4 | Gemini não vencia as leituras (limiar 0,6) | **Descartado** em 28/09/2026: o PM apurou 17 de 18 comprovantes lidos pelo Gemini, nenhuma leitura abaixo de 0,6 (card em `16af467`) |
| D3 | Alerta de estouro no Telegram | **Descartado** em 28/09/2026: só ~10% das despesas passam pelo Telegram, o aviso seria um retrato do passado (card em `16af467`) |
| E3 | Cross-check `categoria.natureza` × `transacao.natureza` | natureza segue a categoria ao reclassificar (`naturezaAoReclassificar`), 25/09/2026; texto manual em 26/09 |

## Ideias ainda sem card

- **P3 · Entrada malformada fora das rotas de grupo ainda vira 500.** `DELETE /api/transacoes/:id`
  (e o `del:` do Telegram), `PATCH /api/transacoes/:id` e as rotas por id de categorias,
  subcategorias e pessoas passam o id cru pro `::uuid`; corpo que não é JSON faz `request.json()`
  lançar em qualquer rota. O helper `ehUuid` (`worker/validar.js`) já existe. Origem: F3
  (28/09/2026), que fechou só as 4 rotas `/api/grupos`.
- **P3 · `tools/importar_fatura.py` remarca o pagamento na reaplicação.** Repete a lógica antiga
  (filtra `computa_resumo=true`, não confere se o pagamento já está marcado): reaplicar a fatura
  pelo Python pode tirar do resumo outra despesa de extrato de mesmo total na janela. O Worker já
  foi corrigido (`marcarPagamentoFaturaNaoGasto`). Vai junto com C6 (importadores Python no modelo
  antigo). Origem: C3 (29/09/2026).
- **P2 · Regra do coder e README ainda apontam `public/app.test.mjs`.** O teste do app mudou
  para `tests/app.test.mjs` (o glob `public/*.test.mjs` saiu do `npm test`), mas
  `.claude/agents/coder-financas.md` (linha "teste do app mora em `public/app.test.mjs`") e a
  árvore do `README.md` seguem com o caminho antigo: um coder que siga a regra recria o arquivo
  em `public/`, fora do `npm test` e de volta no deploy. Regra de agente, PR à parte (não degrau 2).
  Origem: E1 (01/10/2026).
