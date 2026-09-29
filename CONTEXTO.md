# Contexto — decisões do brainstorming (Incremento 1)

Este arquivo registra **por que** as decisões arquiteturais foram tomadas,
para evitar re-litigação depois. Leia antes de questionar.

---

## 1. Imagem-primeiro (95% do fluxo)

**Decisão:** a v1 recebe **só foto/print de comprovante** no Telegram.
Texto manual (`"15,50 padaria 29/08"`) vira fast-follow (Inc 1.5).
PDF de extrato/fatura fica pra Incremento 3.

**Por que:** os últimos 2 anos de histórico do Caio mostram ~95% imagem — foto
do comprovante pix/transferência no WhatsApp, mandada pro Telegram.
Texto é raro, e PDF de extrato nem vai entrar na v1.
**Começar simples** (só o modo dominante) significa código menor, testes mais limpos,
e entrega mais rápida.

Se depois virar 40% texto, é painless adicionar — a rota `/telegram` já tem lugar
pra nova lógica. Mas agora o caminho feliz é foto.

---

## 2. Um Worker só (divergindo da LM Ateliê propositalmente)

**Decisão:** um único Cloudflare Worker faz webhook + app + API.

**Por que:** a LM Ateliê tem múltiplos Workers (bot separado de app) porque é
ferramenta comercial — permite versionamento independente, scaling separado.
Financas é ferramenta pessoal de um usuário.
Simplicidade vence: um deploy, um .env, uma verdade. O Caio não precisa escalar
o bot separado do app.

---

## 3. Gemini Flash padrão + fallback Claude (modelo trocável)

**Decisão:** `extrair.js` tenta Gemini Flash (JSON estruturado nativo, barato).
Se erro **ou** confiança < LIMIAR (default 0.6) → fallback Claude (modelo visão barato, ex. Haiku).
Interface é trocável: `extrair(bytes, mime, categorias) → JSON normalizado`.

**Por que:** Gemini Flash é mais barato e tem JSON nativo — bom pra maioria.
Claude é fallback quando Gemini falha ou erra (ex: lê valor errado na imagem).
O LIMIAR de confiança é **parâmetro** pra calibrar com comprovantes reais.

Modelos locais (Ollama, LLaMA) foram descartados porque o Worker roda na nuvem
e não alcança localhost — usá-los ressuscitaria a arquitetura server-em-casa→tunnel
que **matou a v1 da LM Ateliê** (Paola nunca conseguiu abrir a URL porque o servidor
de casa vivia fora do ar). Nada disso aqui.

---

## 4. Dropbox: pasta por data, categoria no nome (banco é o índice)

**Decisão:** arquivo sobe pra `/Finanças/Comprovantes/AAAA/AAAA-MM/`
Nome: `AAAA-MM-DD_macro_sub_valor_descricao.ext`
(ex: `2026-08-29_Casa_Limpeza_15.50_padaria.jpg`)

O caminho **não muda** ao re-classificar depois. A categoria "verdadeira" vive no banco.
O nome é só conveniência de quem folheia a pasta.

**Por que:** o Dropbox é arquivo perene + conveniência visual.
Banco é o índice — re-classificar no app muda `transacoes.macro/sub`, mas o
arquivo fica no mesmo lugar. Assim:
- Pessoa curiosa que folheia a pasta vê `Casa_Limpeza` e entende o contexto.
- Ao mesmo tempo, se o Caio acordar achando que "Limpeza" é subcategoria errada,
  edita no app e a transação agora aponta pra `Casa_Manutenção` — sem mover arquivo.
- Se o banco virar inacessível, o Dropbox ainda está lá, nomeado de forma que
  o Caio consegue remontar.

Nada de refatorar caminho com a categoria — dados em movimento.

---

## 5. Dois níveis de categoria + reembolso desde a v1

**Decisão:** `macro` (nível 1) + `sub` (nível 2, opcional).
`valor_reembolso` vira coluna gerada `valor_final = valor_total − reembolso`.
Ambos estão lá desde a v1.

**Por que:** o histórico real do Caio (planilha Excel) **já tem reembolso** —
plano de saúde que reimbursa (ex: dentista) — e **já segrega por tipo** (Saúde,
Educação, Casa, etc.).

Começar com essa estrutura significa:
- Import do histórico fica limpo (não precisa migração depois).
- O app já nasce editável (Caio já usa reembolso; não é feature futura).
- `valor_final` é **gerada** → nunca diverge entre telas.

Sub não é obrigatória (recorrência define — um-offs viram descrição só);
mas macro é sempre.

---

## 6. Importar histórico na v1

**Decisão:** import único da planilha Gastos.xlsx (2022–2026) na v1.

**Por que:** o Caio quer histórico longo pra análise (ver "guardado" ao longo
dos meses, detectar padrões).
Deixar pra depois significaria meses com dado incompleto no app — confuso.
Fazer agora é painless: `python tools/import_planilha.py` com `--idempotente`
(re-rodar substitui só linhas `fonte='importacao'`, nunca duplica).

Relatório de import mostra o que aconteceu (contagens, linhas ambíguas).
Nada silencioso.

---

## 7. Correção no app, não no Telegram

**Decisão:** bot confirma o que leu; **edição só no app.**
Telegram recebe só botão Apagar (foto que não é comprovante).

**Por que:** o Telegram é caixa de entrada; o app é análise + edição.
Separação limpa: bot foca em velocidade de captura;
app foca em precisão/aprendizado.

Essa divisão também preparou bem pro Incremento 2 (classificador que aprende):
as correções moram no app, que agora treina o modelo a partir de cada edição.

---

## 8. Modelo de categoria: recorrência define sub

**Decisão:** `sub` (nível 2) só aparece na lista se o `Gasto` é recorrente
(≥ `MIN_OCORRENCIAS`, default 3). Gastos únicos (ex: "Cama nova", "TV Nova")
ficam como `descricao` só, não viram sub.

**Por que:** a lista de categorias do app fica limpa e usável. Um-offs clutter.
Mas nada se perde: o rótulo cru está em `descricao` de qualquer forma.

No app, ao corrigir, o Caio pode criar sub nova se quiser (feature futura).
Mas na v1, import já entrega uma estrutura limpa.

---

## 9. Falha fechada, não aberta

**Decisão:** allowlist do bot **vazia recusa todos**.
App atrás de token.
Secrets nunca em código/repo.

**Por que:** segurança por padrão. Se listar falhar, recusa é a escolha segura.
Se token vazar, reavaliar toda a arquitetura — mas pelo menos vazio é melhor
que "oops, esqueci de ativar a lista".

---

## 10. Incremento 2: Classificador que aprende (por contraparte)

**Decisão:** o sistema aprende associações **contraparte → categoria** a partir das
correções do usuário no app. Na captura seguinte, transações com a mesma contraparte
(chave Pix, CPF ou nome normalizado) recebem a categoria aprendida automaticamente,
sem depender do chute do modelo.

**Por que:** o histórico real do Caio mostra que 95% das transações recorrentes são
para as mesmas pessoas — pagamentos de aluguel, professor de inglês, padaria do bairro.
Capturar a chave (Pix/CPF) e o nome, então associá-los com a categoria corrigida no app,
resolve o problema na raiz: a segunda transação pra Viviane (professora de inglês) já
entra com a categoria certa, `origem_categoria='regra'`. O Caio ainda pode corrigir no app
se a regra errar; uma nova correção atualiza a regra (`upsert`).

**Colunas novas:**
- `transacoes.contraparte_nome` — destinatário/pagador lido do comprovante
- `transacoes.contraparte_chave` — chave Pix/CPF normalizada (null se não houver)
- `origem_categoria` ganha valor `'regra'` (categoria veio de associação aprendida)

**Tabela nova:**
- `associacoes(chave, tipo_chave, macro, sub, n, atualizado_em)` — uma regra por
  (chave, tipo), onde tipo é `'pix_cpf'` ou `'nome'`. Lookup na captura tenta Pix/CPF
  primeiro, depois nome (fallback). Campo `n` reforça quantas confirmações reforçaram
  a regra; `atualizado_em` marca quando foi visto por último.

**Modo ensino (bootstrap):** duas formas de semear associações sem esperar novos gastos:
1. **Telegram `/aprender`** — Caio manda comprovante com legenda `/aprender Educação > Inglês Particular`
   (dry-run, extrai contraparte, valida categoria, faz `upsert` em associacoes, **não cria transação**).
2. **Lote Dropbox** — `tools/ensino_extrair.py` varre comprovantes, extrai contraparte de cada um
   (Gemini), agrupa por chave única, escreve CSV com sugestão de categoria. Caio revê/edita.
   `tools/ensino_aplicar.py` faz `upsert` de todas as associações confirmadas de uma vez.
   Assim o Caio rotula ~dezenas de contrapartes únicas, não milhares de comprovantes.

**Gemini fix:** a versão `gemini-2.5-flash` foi descontinuada (404). Agora usa `gemini-flash-latest`,
que é a mais recente e estável.

---

## 11. Incremento 2.5, Fase A: Pessoa (dropdown fixo + corte no Resumo)

O campo `pessoa` já existia no banco (importado da planilha) mas não aparecia nem era
editável — o Caio usa pra separar, p.ex., a escola do Lucca da escola da Manuela.

**Decisão:** lista fixa **gerenciável**, não texto livre. Vira a tabela `pessoas(id, nome,
ativa)` e `transacoes.pessoa_id` (FK). Motivo: renomear/mesclar fica trivial (muda o `nome`
da linha, as transações seguem pelo id) e o dropdown evita as variações de digitação que
sujariam um corte por pessoa. A semente (Caio, Paola, Lucca, Manuela, Casa) é editável na
tela depois; a migração também traz os nomes que já existiam no histórico.

**Por que na mão:** o comprovante não diz de quem é o gasto. Então `pessoa_id` não sai da
extração — é um select editável na tabela de Lançamentos (mesmo lugar onde já se corrige
categoria/sub). O Resumo ganha o painel **"Gasto por pessoa"**, que responde a pergunta que
motivou tudo: quanto foi pra cada filho.

**Faseamento:** a Pessoa (Fase A) é entregável e deploiável sozinha, antes do grosso da
migração de categorias pra ID/FK + genericização + tela de gestão (Fase B), que só começa
depois do Caio aprovar o mapa de genericização (mexe na categorização real).

---

## 12. Incremento 2.5, Fase B: categorias por id + genericização + tela de gestão

As categorias vieram da planilha com nomes específicos demais ("Mensalidade Escola
Iguatemi", "Fatura Cartão de Crédito Nubank") e eram **strings** espalhadas em `transacoes`
e `associacoes` — renomear/mesclar exigia cascata frágil e não havia tela.

**Decisão:** migrar pra **ID/FK** (tabelas `categorias`/`subcategorias`) e **genericizar**
os nomes de uma vez. O favorecido específico foi pra `descricao` (ex.: sub "Mensalidade
Escola Iguatemi" → categoria Educação › Escola, descrição "Colégio Iguatemi"). O Caio
aprovou o **mapa de genericização** (gerado das categorias vivas) antes de qualquer escrita
— o mapa mescla variações (5 subs de Iguatemi viraram Escola/Material escolar; 2 faturas de
cartão viraram "Fatura de cartão"; 3 salários viraram "Salário").

**Migração em 2 etapas** pra não quebrar produção: `0004` **aditiva** (ids convivem com as
strings; backfill do mapa; NOT NULL de `macro` solto no cutover) → **cutover** do código
(db/api/app/tools por id, deploy) → `0005` **limpeza** (drop das strings) — destrutiva, só
depois do cutover validado em produção.

**Truque que economizou trabalho:** os resumos fazem join e apelidam `c.nome as macro`, então
os gráficos do Resumo não mudaram no cutover — só Lançamentos (selects por id) e a nova aba
**Ajustes** (gestão: renomear/mesclar/desativar) precisaram de UI nova.

**Por que a genericização importa:** com nomes genéricos + favorecido na descrição + o corte
por pessoa (Fase A), dá pra responder "quanto de escola por filho" sem a categoria carregar o
nome da escola. Renome/merge agora é mudar uma linha — as transações seguem pelo id.

---

## 13. Incremento 4: planejamento — baseline+vigência+exceção

O Resumo já soma o **realizado** por categoria e mês. Faltava o **plano**: um alvo por
categoria, mês a mês, pra comparar contra o realizado e ver onde estourou. O requisito que
molda tudo é temporal: o Caio precisa poder mudar o alvo **só num mês pontual** (viagem,
imprevisto) **ou pra toda a sequência futura** (renegociou o aluguel, o teto novo vale daqui
em diante) — e as duas coisas são fisicamente diferentes.

**Por que baseline com vigência + exceção (não uma linha por mês nem um valor único):**
uma linha por mês (categoria × mês materializado) precisaria de horizonte (até quando
gerar linhas futuras?) e perderia o "daqui em diante" como conceito — mudar 12 meses seria
12 escritas. Um valor único por categoria (sem tempo) não registra que o teto mudou no
meio do caminho — perde o histórico do plano. **Baseline com vigência** ("a partir deste
mês, o alvo é V", propaga pra frente até o próximo baseline) resolve os dois: histórico
preservado (mês passado fica congelado no baseline que valia então, sem reescrever nada) e
"daqui em diante" é uma única escrita. A **exceção por mês** cobre o caso pontual sem
contaminar o baseline — sobrepõe um mês e desaparece, o baseline segue intacto por baixo.

**Por que resolver em JS puro (`worker/metas.js`), não em SQL:** a pergunta "qual alvo vale
neste mês, esta categoria" tem uma regra de precedência (`exceção > baseline mais recente
≤ mês > sem-alvo`) que é simples de errar em SQL (window function + coalesce aninhado) e
difícil de auditar quando o número parece errado. Com ~15 categorias por mês, performance
não é problema — então o SQL só busca os dados crus (baselines, exceções, realizado) e a
resolução roda em função pura, testável isoladamente, no mesmo espírito de `money.js` e
`extrair.js`: sem banco, sem rede, tudo por parâmetro.

**Por que só despesa e só categoria (macro), sem subcategoria/pessoa/esfera:** manter a
superfície de planejamento enxuta. Meta é teto de gasto — receita planejada é pergunta
diferente (fica de fora). Alvo por subcategoria ou recortado por pessoa multiplicaria as
células (~15 categorias × 12 meses já é a grade da Fase B) sem que o Caio tenha pedido esse
nível de granularidade; dá pra abrir depois se fizer falta.

**Por que semear pela média dos 3 meses anteriores:** editar ~15 alvos do zero todo mês é
atrito que mata o hábito. A sugestão pré-preenche com um número plausível (média do
realizado recente daquela categoria) — o Caio só ajusta o que quer que seja diferente do
padrão, e confirma antes de qualquer escrita (nada grava silenciosamente).

**Faseamento A (mês) → B (grade):** a mesma lógica de "nada entra sem E2E" do resto do
projeto. A Fase A entrega a fatia completa e deployável sozinha — definir alvo, ver
realizado, ajustar pontual ou daí em diante, tudo numa tela de mês. A grade (categorias ×
meses, pra planejar a sequência de uma vez) é aditiva por cima, sem tocar no que a Fase A
já resolveu.

**Por que editar uma célula da grade sempre grava baseline:** a grade existe pra planejar a
sequência de uma vez — o gesto natural ali é "daqui pra frente o alvo desta categoria é
esse". A exceção pontual (só este mês) continua existindo, mas é caso raro o suficiente
pra ficar só na tela de mês (Fase A), que já resolve isso; a grade não precisa duplicar
esse controle e ganha em simplicidade não tendo escolha de escopo por célula.

---

## 14. Incremento 4.5 — filtro único + Resumo por mês fechado

Com Lançamentos, Planejamento e agora Metas todos girando em torno de um mês, ter três
seletores de tempo diferentes (chips de período no Resumo, mês em Lançamentos, mês em
Planejamento) virou fricção sem propósito — o Caio tinha que pensar em "qual filtro esse
mexe" a cada troca. A correção é um único seletor de mês (`estado.mes`) governando as três
abas; Lançamentos guarda "Todos os meses" como escape hatch pra quando o corte por mês
atrapalha (procurar uma transação antiga, por exemplo).

**Por que o Resumo fecha no mês (era um período livre com presets: mês/mês passado/ano/12
meses/tudo):** o Incremento 4 trouxe orçamento, e orçamento só faz sentido comparado contra
um mês fechado — "quanto sobrou do teto" não é uma pergunta que um período de 12 meses
corridos responde bem. Mês fechado também é a unidade que Lançamentos e Planejamento já
usavam; alinhar o Resumo nela elimina a pergunta "por que o filtro daqui é diferente".
O corte por período mais longo (comparar anos, por exemplo) não desapareceu como
necessidade hipotética, mas ninguém pediu — abre depois se fizer falta.

**Por que curva diária + reta de ritmo (`drawDiario`/`acumularDiario`/`paceOrcamento`),
não mais a evolução mês a mês (`drawEvo`):** dentro de um mês fechado, "evolução mensal"
não tem mais o que mostrar (é um mês só). A pergunta que importa agora é "estou gastando
rápido demais pro orçamento durar o mês?" — daí o gasto acumulado dia a dia contra uma reta
de ritmo (orçamento total dividido linearmente pelos dias do mês): se a curva de gasto cruza
a reta, o ritmo atual estoura o teto antes do fim do mês. `acumularDiario`/`paceOrcamento`
ficaram puros (mesmo espírito de `metas.js`) porque a lógica é testável sem depender de SVG.

**Por que sunburst (`drawSunburst`) no lugar do donut de categoria (`drawDonut`):** o Resumo
já tinha subcategoria como corte (na tabela de Lançamentos), mas não no gráfico — o donut só
mostrava a categoria. Um segundo anel por subcategoria dá esse detalhe sem abrir uma tela
nova; o clique pra focar/desfocar uma categoria evita que o anel externo vire ruído visual
quando há muitas subcategorias — só aparecem as subs da categoria em foco.

**Por que rosca de pessoa (`drawPessoaDonut`) + bullet chart (`drawBullet`), não mais a
barra de pessoa (`drawPessoa`):** a rosca reaproveita a mesma mecânica de arco do
donut/sunburst (proporção visual consistente entre os três gráficos de composição) e dá
o total no centro, que a barra não tinha. O bullet é novo: fecha o loop entre Planejamento
(onde o alvo é definido) e Resumo (onde o realizado é visto) — cada categoria com alvo vira
uma linha "realizado vs. orçamento" de leitura rápida, sem precisar trocar de aba.

**Faseamento 1 → 2:** Fase 1 trocou o seletor de Lançamentos/Planejamento para `estado.mes`
sem tocar no Resumo — que seguia com os presets antigos (`.period`/`periodoRange`) — pra não
misturar duas mudanças (troca de filtro + reforma de gráficos) num commit só. Fase 2 fechou
o Resumo no mês e trocou os quatro gráficos afetados; nesta limpeza final, `resumoMensal`
(backend) e `drawEvo`/`drawDonut`/`agruparMensal`/`periodoRange`/`.period` (front, que as
substituições da Fase 2 tinham deixado sem nenhuma chamada) saíram do código.

---

## 15. Categoria padrão por flag (bug do Telegram mudo, 25/09/2026)

O bot parou de responder a texto manual e a foto. O webhook devolvia 500 porque a categoria
`Outros` tinha sido **renomeada** na aba Ajustes pra `Não Identificado`, e o fallback de
`resolverCategoria` procurava o nome literal `"Outros"` → `categoria_id` null → not-null no
insert → exceção sem try/catch → 500. Sem logs persistidos, só apareceu com `wrangler tail`.

**Decisão:** o padrão passa a ser uma **flag** (`categorias.padrao`, migração `0008`), não um
nome. A invariante "sempre existe uma categoria pra onde cair" vira invariante do banco (índice
parcial único + `desativarCategoria` que ignora a padrão), em vez de depender de o Caio nunca
renomear uma linha que a tela de Ajustes deixa renomear. **Por que não simplesmente renomear de
volta:** resolveria em um minuto e quebraria de novo na próxima edição — a tela de gestão existe
justamente pra renomear/mesclar sem cascata, então o código não pode depender de nomes.

**Semântica (decisão do Caio):** `Não Identificado` é o padrão — o que ninguém classificou, a fila
do que ele precisa analisar pra dar destino. `Outros` volta a existir como **miscelânea
deliberada** — categoria que ele escolhe, não fallback. Por isso o import (`montarDecisao`,
`importar_extrato.py`, `importar_fatura.py`) deixou de preencher `"Outros"` quando não há
categoria: manda `null`, e o resolvedor leva pra padrão.

**Por que try/catch no `handleTelegram` e responder 200:** com 500 o Telegram retenta o mesmo
update em loop e o usuário não vê nada — é o pior dos dois mundos (nem grava, nem avisa). Com
200 + mensagem de erro no chat, o ciclo fecha: o Caio sabe que falhou e reenvia depois.

---

## 16. Incremento 4.6 — grupos com representante (duplicatas explícitas)

Quase todo lançamento manual do Caio também aparece no extrato do Itaú no fechamento do mês.
O import já reconciliava isso, mas de dois jeitos ruins: valor exato ±3 dias "casava" a linha
do banco com o lançamento e **carimbava** o hash nele — a linha do banco nunca chegava a
existir como transação, e nada na tela dizia que aquele lançamento tinha sido conferido contra
o extrato; valor diferente (o caso real: entrada de R$ 56.200 = salário de R$ 36.200 + R$
20.000 de repasse pra transferir) virava uma linha nova que o Caio marcava "fora do resumo" na
mão, sem registrar o porquê — daqui a um ano, ninguém lembra.

**Decisão:** duplicatas viram um **grupo com representante**: linhas com o mesmo `grupo_id`,
exatamente um membro `representante`, e só ele conta no Resumo. **Por que:** o Caio foi
explícito na conversa — "um grupo funciona como uma linha; só um representa" — e é exatamente
isso que a tela precisa mostrar: uma linha expansível, não duas linhas concorrendo. Isso também
descartou as outras duas formas discutidas. Não é "soma que fecha" (decompor uma linha do banco
em partes que somam o valor) porque o caso real (salário + repasse) não é uma decomposição
alinhada ao lançamento — é ruído que o Caio prefere anotar na descrição, não modelar; forçar
soma criaria uma regra que quebra no primeiro caso torto. E não é uma tabela própria N:M (um
lançamento em vários grupos) porque nenhum caso real pede isso — cada duplicata é conferida
contra exatamente um lançamento do banco, e a tabela extra seria infraestrutura sem uso.

**Por que "quem conta" virou coluna gerada:** antes, quem conta no Resumo era só
`computa_resumo` (a flag "fora do resumo" que o Caio controla). Com grupos, a regra efetiva
passa a ser "`computa_resumo` E (solta OU representante)". Calcular isso em cada uma das sete
leituras agregadas (Resumo, `resumoDiario`, `resumoMesVsAnterior`, `porPessoa`, Planejamento/
metas etc.) seria repetir a mesma lógica sete vezes — e divergir uma vez é o tipo de bug que só
aparece quando o número já está errado num dashboard. A coluna gerada `conta_no_resumo` calcula
a regra **um lugar só**, no banco, auditável por SQL direto; as sete leituras trocam um
identificador (`computa_resumo` → `conta_no_resumo`) sem lógica nova.

**Por que apagar ou tirar o representante recusa em vez de promover outro membro
automaticamente:** promover é uma decisão de "qual desses é o de verdade" que o sistema não
tem como acertar sozinho — é ambíguo por natureza (o extrato não é candidato, mas entre dois
lançamentos manuais não há critério óbvio). O Caio escolhe: a API devolve erro legível
("escolha outro representante antes de tirar este") e ele troca antes, de propósito.

**Por que membros não são editáveis na tela:** um membro existe só como evidência ligada; ele
não entra no Resumo, então editar sua categoria ou pessoa daria a impressão de que aquilo
importa quando não importa — é fácil achar que se está editando "o lançamento" quando na
verdade é o lado que não conta. Pra editar de verdade, o caminho é tirar do grupo ou tornar
representante primeiro; aí a edição acontece na linha que efetivamente é contada.

**Por que o caso salário ficou fora do modelo, e como o modelo ainda cobre ele:** decompor uma
entrada em partes com soma obrigatória foi descartado — é a mesma armadilha da "soma que
fecha", uma regra rígida pra um caso que na prática é só "essa entrada tem duas origens, uma
delas não é minha". O modelo cobre isso sem decomposição: agrupa a linha do banco (R$ 56.200)
com o lançamento do salário (R$ 36.200, representante) e o porquê vai na descrição; a diferença
gera o selo **"valores diferem"**, que é aviso, nunca bloqueio — o grupo não precisa fechar em
centavos pra existir.

**Fase B — o import grava o grupo, não mais o hash:** um casado passa a inserir a linha do
extrato **dentro** do grupo do lançamento (novo ou existente) em vez de só carimbar `linha_hash`
nele — a linha do banco vira uma transação de verdade, visível como membro, em vez de um carimbo
invisível. **Por que a linha entra com `computa_resumo=true`:** desagrupar essa linha depois tem
que devolver a contagem — se ela nascesse com `computa_resumo=false`, tirar do grupo deixaria uma
transação "fora do resumo" por acidente, sem ninguém ter decidido isso; nascendo `true`, a coluna
gerada `conta_no_resumo` já cuida de excluí-la do Resumo enquanto ela for membro não-representante,
e desagrupar simplesmente devolve o comportamento normal. **Por que o grupo nasce no navegador:**
o `grupo_id` é gerado em `montarDecisao` (`crypto.randomUUID()`) antes de chegar no Worker — o
servidor só grava, do mesmo jeito que o resto do fluxo de import (o app decide a decisão revisada,
`db.aplicarImportacao` só persiste). **Por que candidatos excluem grupo que já tem uma linha de
extrato:** um lançamento casa com o banco **uma vez** — se o grupo já tem a linha do extrato como
membro, oferecer esse lançamento de novo como candidato deixaria o import tentar casar o mesmo
banco duas vezes. Os hashes carimbados no modelo antigo (Fase A e antes) ficam como estão — não há
migração de carimbo pra grupo; eles só saem de circulação quando os importadores Python forem
alinhados ou aposentados (BACKLOG C6).

**Prévia velha recusa o lote (F2, 29/09/2026):** como a decisão nasce no navegador, ela descreve o
estado que a prévia viu. Se entre a prévia e o aplicar o grupo foi desfeito, ficou sem
representante, ou o lançamento casado mudou de grupo/foi apagado, gravar deixaria a linha do
extrato num grupo em que ninguém conta. O `/api/importar/aplicar` lê os `matchId` e os grupos
citados **antes** da transação e `conferirPreviaCasados` (`worker/importar.js`, pura) decide: algum
casado divergiu → **409 "a prévia ficou velha, gere de novo"** e nada é gravado (nem a marcação do
pagamento da fatura). **Por que o lote inteiro e não só o casado velho:** a prévia é uma revisão
que o Caio aprovou como um todo; gravar metade dela seria uma decisão que ninguém tomou. **Por
que leitura prévia e não checagem dentro da transação:** a `sql.transaction` do Neon manda as
queries num POST só, sem ramificar no meio; a janela entre a leitura e a gravação é aceita (app de
um usuário só). No mesmo espírito, `decidirAgrupar` recusa entrar num grupo existente sem
representante ("o grupo não tem representante"), olhando o grupo inteiro, não só a seleção.

## Não fizemos (por que não faz sentido ainda)

| O que | Por que não | Quando |
|---|---|---|
| Extrato + fatura | PDF parsing é complexo; v1 é imagem. | Incremento 3 |
| Conciliação | Depende de Incremento 3 (extrato/fatura). | Incremento 3 |
| PJ em cascata | Estrutura simples pro Caio pessoa física primeiro. | Incremento 5 |
| Investimentos | Escopo separado; dados ainda a coletar. | Incremento 6 |

Cada incremento entrega valor E2E. Nada é plumbing que ficaria inútil sozinho.
