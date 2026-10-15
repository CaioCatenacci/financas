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
| — | Rotina do assistente para escrever o diagnóstico | skill `.claude/skills/diagnostico` (PR #43, 13/10/2026) |
| C7 | Wise como fonte do salário | absorvido pelo G1; card fechado em 15/10/2026 |
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
- **P3 · Buraco no meio da cobertura fica invisível.** A cobertura de uma fonte é `max(ate)` de
  `importacoes`: um mês nunca importado entre dois imports aparece coberto. Os dados de hoje não
  têm buraco; se aparecer, a regra passa a olhar a união dos períodos. Origem: G2 (10/10/2026).
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
- **P3 · Extrato sem nenhum "Saldo do dia" não tem o original guardado.** O nome do arquivo no
  Dropbox vem da cobertura da prévia (1º e último saldo); sem saldo a cobertura é null, o aplicar
  passa e o app só avisa "o import entrou, mas o arquivo original não foi guardado". Nunca
  aconteceu nos imports de hoje; se aparecer, decidir se o nome cai nas datas das linhas.
  Origem: C4 (14/10/2026).
- **P3 · Calendário: salário e print com borda a decidir.** Mês antes do primeiro `salario_param`
  volta `brl_cents` nulo e a célula do salário cai em "falta" (seria "não se aplica"); e o "não se
  aplica" do print usa o primeiro print de **qualquer** conta (corte global), então uma conta nova
  aparece em "falta" nos meses antes dela existir. Nenhum dos dois afeta a janela de hoje.
  Origem: G6 (14/10/2026).
- **P3 · Importadores Python não herdam a esfera da categoria.** `tools/import_planilha.py`
  (`esfera_de(tipo)`), `tools/importar_extrato.py` e `tools/importar_fatura.py` gravam a esfera
  pela regra antiga, e `tools/jev_classificar.py` troca `categoria_id` sem tocar na esfera: usar
  esses caminhos para pôr linha na categoria Empresa (ou tirar dela) volta a criar
  `transacoes.esfera <> categorias.esfera`. Saídas: um trigger no banco (cobre todos os
  caminhos) ou levar `esferaDaCategoria` para os tools, junto com o C6. Origem: A1 (15/10/2026).
- **P2 · Receita na categoria padrão pode duplicar o salário na cascata.** O salário vem de
  `alocarSalario` (G1), mas um repasse do próprio salário (Wise → banco) que ficou sem
  classificação na `padrao=true`, com natureza receita, entra também em "+ Outras receitas" (e no
  saldo do G1, que conta do mesmo jeito). O defeito, se existir, é da triagem, não da cascata;
  conferir os meses recentes. Origem: A3 (15/10/2026).
- **P3 · Em que degrau entra uma receita de esfera empresa.** Hoje vai para "+ Outras receitas"
  (CONTEXTO §27), para a cascata fechar com o saldo do mês; um estorno de despesa da empresa
  poderia abater o degrau Empresa. Nenhuma linha assim no banco em 15/10/2026; o Caio decide se
  aparecer. Origem: A3 (15/10/2026).
