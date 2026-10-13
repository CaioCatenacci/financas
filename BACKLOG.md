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

- **P2 · `/patrimonio`: data e pessoa do print.** No smoke de 13/10/2026 o print do C6 Invest
  ("Atualizado em 07/10/26") foi gravado com o ano 2024 — o modelo leu o ano de 2 dígitos errado
  (corrigido à mão). Regra proposta: data lida que fique a mais de 60 dias da data da mensagem é
  descartada e vale a da mensagem. E prints sem nome (os do Itaú) não trazem a pessoa: só entram
  com `/patrimonio caio itau` na legenda; avaliar se a conta implica a pessoa por padrão
  (ex.: itau → Caio) para não depender da legenda. Origem: smoke do A2 (13/10/2026).
  Mais dois do mesmo smoke, corrigidos à mão no banco: o print-resumo do Itaú ("meus
  investimentos", só o total) entrou como produto da família `outros` e somaria por cima das
  famílias; e o Tesouro ("TIT PUBLICO") veio como agregado e sumiria quando há títulos de renda
  fixa. Proposta: o prompt marca print que só tem o total da carteira e ele não grava produto;
  Tesouro é sempre `titulo`.
  E o FGTS (app da Caixa) não é uma conta que o leitor conhece (`itau|c6|nubank|mercadopago`):
  o saldo de 13/10 entrou à mão como conta `fgts`, família `outros`. Para os próximos meses, o
  leitor precisa aceitar `fgts` (e, se fizer sentido, uma família própria, por ser ilíquido).
- **P2 · Classificar o passado pendente com o JEV.** Usar o JEV (TypeSafe, modelo de decisão que
  devolve a probabilidade do "sim" sem gerar texto, a US$ 0,042 por milhão de tokens) para sugerir
  a categoria das ~1.260 transações em "Não Identificado", quase todas de faturas e extratos de
  2025 e início de 2026. No LM Ateliê o spike B81 (03/10/2026, `docs/spikes/2026-10-jev.md` de lá)
  deu ao JEV acerto parecido com o do Claude em classificação por título, a uma fração do custo.
  Ideia: um lote que pergunta ao JEV, por transação, a probabilidade de cada categoria do catálogo
  (ou um funil: categoria → subcategoria), aplica só acima de um limiar e deixa o resto para
  triagem; o que for aplicado vira regra aprendida (`associacoes`) para os próximos imports. Precisa
  de spike antes (acerto contra um gabarito do Caio numa amostra) — mesmo formato do B81. Ajuda o
  G3 (diagnóstico) e o G2 (pendências do fechamento). Origem: conversa de 12/10/2026.
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
- **P3 · Lembrete do fechamento pelo Telegram.** O app já mostra o que falta importar por mês
  (`/api/fechamento`); avisar no Telegram quando um mês passado segue "faltando" ficou de fora de
  propósito (primeiro o app mostrar). Origem: G2 (10/10/2026).
- **P3 · Buraco no meio da cobertura fica invisível.** A cobertura de uma fonte é `max(ate)` de
  `importacoes`: um mês nunca importado entre dois imports aparece coberto. Os dados de hoje não
  têm buraco; se aparecer, a regra passa a olhar a união dos períodos. Origem: G2 (10/10/2026).
- **P2 · Rotina do assistente para escrever o diagnóstico.** O app já guarda e mostra
  (`PUT/GET /api/diagnostico`, roteiro no CONTEXTO §20); falta a skill/rotina que lê as rotas e
  escreve o texto. É regra de agente (`.claude/`), vai em PR à parte, não pelo degrau 2.
  Origem: G3 (10/10/2026).
- **P3 · Conta sem print no mês some do total do patrimônio.** A foto do mês (`/api/patrimonio`)
  só usa prints do próprio mês: se o Caio manda o Itaú em outubro e o C6 da Paola só em setembro,
  o total de outubro sai sem o C6. Levar a última foto adiante (com selo "foto de set") seria uma
  escolha nova; hoje o mês sem print fica null. Origem: A2 (12/10/2026).
- **P3 · Rendimento calculado depende do nome da categoria "Investimentos".** Os aportes/resgates
  do A2 somam a categoria pelo nome (como a regra do classificador e a migração `0012`); renomear
  a categoria na aba Ajustes zera os aportes sem aviso. Uma flag na categoria (como `padrao`)
  resolveria. Origem: A2 (12/10/2026).
- **P3 · Simulador de financiamento (SAC/Price) do Projeto Casa.** Ficou fora do G4 de propósito
  (a prioridade é pagar à vista); quando vier, card próprio com valores de referência editáveis,
  ao lado da aba Casa. Origem: G4 (13/10/2026).
- **P3 · Bordas do ritmo da casa a confirmar.** Menos de 6 meses fechados (média sobre os que
  houver), falta ≤ 0 (projeção 0) e data alvo vencida (ritmo necessário null) seguem o padrão do
  PM (CONTEXTO §22); o Caio confirma ou corrige. Origem: G4 (13/10/2026).
