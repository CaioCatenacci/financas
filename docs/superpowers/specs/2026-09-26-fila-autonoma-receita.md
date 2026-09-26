# Receita: fila autônoma com PM, coder, reviewer e entrega

*Extraída do repositório `lmatelie` (LM Ateliê) em 26/09/2026. Escrita para a sessão do
Claude Code de outro projeto, que vai reproduzir o arranjo com o Caio.*

**Como usar este documento:** leia inteiro antes de criar qualquer arquivo. A pasta `kit/`
ao lado tem os arquivos reais do projeto de origem, para copiar e adaptar. A pasta
`referencia/` tem os dois specs de desenho (o porquê de cada decisão) e um relatório de
rodada real. **Antes de implantar, faça ao Caio as perguntas da seção 12** — a receita
tem pontos que dependem de como o projeto novo faz deploy, banco e testes.

---

## 1. A ideia em dez linhas

1. **Decidir o que um item é pertence ao humano.** Agentes apuram, implementam, revisam e
   entregam; nunca inventam requisito. Um "PM que refina sozinho" é onde entra o chute
   não sinalizado, e um chute não sinalizado já invalidou uma conclusão inteira no
   projeto de origem.
2. **O backlog é texto versionado**: um Markdown por item aberto em `fila/`, com sete
   seções fixas. O Caio lê e escreve em VS Code ou Obsidian. Uma fonte só.
3. **A prioridade são três faixas** (Agora, Próximo, Depois) num `ORDEM.md`. Só a faixa
   Agora tem ordem exata. Repriorizar é mover uma linha.
4. **"Pronto" é uma regra, não uma opinião**: faixa Agora, `estado: pronto`, nenhuma
   pergunta em aberto, DoD com frases conferíveis, dependências feitas. Um script confere.
5. **As regras de parada moram em código** (`.claude/workflows/fila.js`): "até N itens",
   "para na primeira falha", "devolvido não é falha". Um `if (falhou) break` não se
   esquece no quinto item às três da manhã.
6. **As regras exatas moram num tool testado** (`tools/fila.mjs`): quem é candidato, o
   que o diff tocou, se pode dar merge sozinho. Os agentes só executam e repassam o JSON.
7. **Quatro agentes com o mínimo de ferramentas cada**: PM (só leitura, SELECT), coder
   (edita numa worktree, nunca faz push), reviewer (roda tudo, não edita), entrega (o
   único que aplica migração e dá merge, e só quando o Caio manda).
8. **Autonomia em degraus.** Degrau 1: a rodada vai até PR aberta com CI verde. O merge é
   uma frase do Caio ("entrega a #N"). Degrau 2 (opcional): merge automático só para o
   que não pode morder ninguém, decidido por código.
9. **A `main` só muda por PR.** Hook `pre-push` recusa qualquer push cujo destino seja a
   main, seja qual for o comando; o `settings.json` nega `--no-verify`.
10. **Sem o Caio presente, um pedido de permissão trava a rodada.** O
    `.claude/settings.json` libera pelo nome exatamente o que os papéis rodam, e nada mais.

E duas lições de processo que moldam tudo:

- **Refinar não é apurar.** No projeto de origem, 4 de 10 itens mudaram de figura quando
  apurados contra código e banco. Apurar é trabalho de agente; decidir é do Caio.
- **Devolução não é falha.** É o sistema funcionando. Falha é código quebrado; empilhar
  item novo sobre coisa quebrada é o que a regra de parada impede.

---

## 2. O que existe no repositório (mapa)

```
fila/                          # a fila (fonte). Fora de docs/ porque docs/ é público
  _modelo.md                   # modelo de item
  README.md                    # o que é a pasta, em 10 linhas
  ORDEM.md                     # ## Agora / ## Próximo / ## Depois
  feitos.js                    # histórico dos entregues (gerado pelo `concluir`, não se edita)
  <id>.md                      # um por item aberto
tools/
  fila.mjs                     # regras + comandos (checar, gerar, concluir, candidatos, toca, degrau2)
  fila-md.mjs                  # parser puro do Markdown → lista de itens
  test-fila.mjs                # testes das regras (node --test)
  hooks/pre-push               # recusa push para a main
docs/fila.js                   # GERADO de fila/ (vitrine /roadmap do app). Opcional no projeto novo
.claude/
  agents/pm-<proj>.md          # os quatro agentes, versionados
  agents/coder-<proj>.md
  agents/reviewer-<proj>.md
  agents/entrega-<proj>.md
  workflows/fila.js            # o condutor da rodada (Workflow tool, name: "fila")
  settings.json                # permissões allow/deny, versionado
  worktrees/                   # worktrees da rodada (no .gitignore)
.superpowers/fila/<data>.md    # relatório de cada rodada (no .gitignore)
.github/workflows/ci.yml       # roda test-fila, checar e gerar --conferir
CLAUDE.md                      # seção "A fila autônoma" com os gatilhos de conversa
```

Convenções que sustentam o estado sem escrever arquivo nenhum no meio da rodada:

- **Branch `fila/<id>` = item em curso.** PR aberta dessa branch = "em PR". Branch local
  sem PR = "alguém tem que olhar" (bloqueia o item nas rodadas seguintes, de propósito).
- **A PR do item já leva o item como feito** (`concluir` tira o `.md`, põe no `feitos.js`
  e regera o `docs/fila.js`). Mergear é pôr no ar: o estado vira verdadeiro exatamente
  quando vira verdade.
- **A rodada lê a fila de `origin/main`** (`--ref origin/main`), nunca da árvore de
  trabalho.

---

## 3. O formato da fila

### 3.1 `fila/<id>.md` (um por item aberto)

Copie `kit/fila/_modelo.md`. Exemplos reais: `kit/fila/exemplo-item-pronto-B59.md`
(item pronto para a rodada) e `kit/fila/exemplo-item-espera-B23.md` (item esperando o Caio).

```markdown
---
id: B50
estado: livre          # livre | espera | pronto   (feito NÃO é estado de arquivo)
exige: []              # ids que precisam estar feitos antes
toca: [tela:/analytics, api]   # vocabulário fechado, ver 3.4
auto_merge: false      # só tem efeito no degrau 2
espera: paola          # opcional, só com estado: espera — quem se espera
meta: texto curto      # opcional, linha do card na vitrine
cx: baixa              # opcional, complexidade
---
# Nome do item

## Problema
O que dói hoje, e para quem.

## Valor
O que muda quando estiver pronto. Por que vale mais que o item de baixo.

## Pronto quando (DoD)
- [ ] frases conferíveis — cada uma vira teste ou conferência na tela

## Exemplo
Um caso concreto com números. Trava a interpretação melhor que prosa. Vira teste.

## Fora
- o que não fazer, mesmo parecendo óbvio

## Decisões
- AAAA-MM-DD · o que ficou decidido · quem decidiu

## Perguntas em aberto
- o PM pergunta e recomenda aqui, terminando em (PM, AAAA-MM-DD); o Caio responde embaixo
```

Regras que o `checar` impõe:

- o nome do arquivo é o `id`; o título `#` é o nome do item;
- as **sete seções `##` existem sempre, nessa ordem**; seção vazia diz `(a definir)` ou
  `(nenhuma registrada)`; Perguntas em aberto vazia fica sem itens;
- `exige` e `toca` são listas `[..]`; `auto_merge` é `true`/`false`; `espera` só com
  `estado: espera`;
- **nada de dado de cliente** (o conteúdo vai para um arquivo público se houver vitrine);
- só o item de lista de primeiro nível conta; o que o Caio escreve recuado embaixo de uma
  pergunta é resposta.

### 3.2 `fila/ORDEM.md`

```markdown
## Agora
- B59
- B50

## Próximo
- B49

## Depois
- D3
```

Todo item aberto aparece exatamente uma vez. Em Agora, a ordem das linhas é a ordem da
rodada.

### 3.3 O que é "pronto" (candidato da rodada)

Todas valem ao mesmo tempo:

- está em **Agora**;
- `estado: pronto`;
- **Perguntas em aberto** sem itens;
- **Pronto quando** com ao menos uma frase, e nenhuma `(a definir)`;
- em **Decisões**, a última linha `AAAA-MM-DD · estado: pronto · Caio` (é de onde saem
  "quem marcou" e "quando"; texto redigido pelo assistente e aprovado é
  `Caio (redação: assistente)`);
- todo `exige` aponta para item em `feitos.js`;
- não existe PR aberta nem branch local `fila/<id>`.

### 3.4 O vocabulário `toca`

Fechado, e conferido pelo CI: `tela:<rota>` (ex. `tela:/admin`), `tela:*`, `migracao`,
`costing`, `worker`, `api`. É o **escopo declarado** do item. Depois da implementação o
escopo **derivado do diff** tem que caber nele, senão o item é devolvido. **No projeto
novo esse vocabulário muda**: ele descreve as áreas do seu repositório que têm
consequência diferente (o que a usuária vê, o que mexe no banco, o que mexe na fórmula
canônica, o que não auto-deploya). Ver seção 4.2.

### 3.5 `fila/feitos.js`

`const ITENS = [ {...}, ... ]`, um item por linha em JSON, escrito só pelo comando
`concluir`. É o histórico; a rodada usa para saber quais `exige` estão satisfeitos.

---

## 4. `tools/fila.mjs` e `tools/fila-md.mjs`

Copie os três arquivos de `kit/tools/`. O `fila-md.mjs` é puro (texto entra, lista sai) e
provavelmente **não precisa mudar**. O `fila.mjs` tem os pontos de adaptação abaixo.

### 4.1 Comandos (cada um imprime UMA linha de JSON, que o agente repassa sem interpretar)

| Comando | Faz | Quem usa |
|---|---|---|
| `checar [pasta]` | fila bem formada (frontmatter, seções, ORDEM, regra de pronto, ids) | CI, PM, coder, reviewer |
| `gerar [--conferir]` | escreve `docs/fila.js` a partir de `fila/`; `--conferir` só compara (CI) | CI, PM no fechamento |
| `concluir <id> "<meta>"` | tira `fila/<id>.md`, acrescenta ao `feitos.js`, tira do ORDEM, regera | coder, na PR do item |
| `candidatos` (stdin `{prs:[...]}`) | prontos / bloqueados / em_pr, na ordem de Agora | PM, no pré-voo |
| `toca <id> <base> <head>` | escopo derivado do `git diff --name-only`, contra o declarado | workflow, entrega (degrau 2) |
| `degrau2 <id>` (stdin) | pode mergear sozinho? `ok` + motivos | workflow |
| `--ref origin/main` | qualquer comando lendo a pasta pelo git, não do disco | rodada inteira |

### 4.2 O que adaptar no `fila.mjs`

- **`tocaDeCaminhos`**: o mapa caminho → categoria. É a regra mais importante do arquivo e
  é toda do projeto de origem (`migrations/` → `migracao`, `worker/` → `worker`,
  `docs/<x>.html` → `tela:/<x>` etc.). Reescreva para as pastas do projeto novo.
- **`NEUTROS`**: o que toda entrega mexe e não conta como escopo (manual, a própria fila,
  testes, docs). Sem isso, todo item seria devolvido.
- **`.claude/` e `CLAUDE.md` nunca são neutros** e nunca passam no degrau 2: mudar as
  regras dos agentes muda as rodadas seguintes.
- **Código fora do vocabulário vira `nao_classificados`**: não devolve o item, mas bloqueia
  o merge automático.
- **`degrau2`**: a lista do que barra o merge automático. Na origem: `migracao`,
  `costing`, `worker` (o bot não auto-deploya) e qualquer `tela:` (a usuária vê).
- **`TOCA_FIXOS`** e a regex de `tela:` em `tocaValido`.
- **`gravavel`**: `gerar` e `concluir` só escrevem em `docs/fila.js` e `fila/` (ou numa
  pasta temporária, para os testes). Se o projeto novo não tiver vitrine, aponte a saída
  para outro lugar ou mantenha o arquivo gerado mesmo assim: é barato e o `--conferir` no
  CI pega `fila/` editada sem regerar.
- O `feitos.js` carrega campos da vitrine (`camada`, `quem`, `desc`). São inofensivos sem
  vitrine.

### 4.3 `tools/test-fila.mjs`

Copie e ajuste os casos de `tocaDeCaminhos` e `degrau2` para o mapa novo. Roda com
`node --test tools/test-fila.mjs`. Cobre: `checar` regra a regra, `candidatos` (exige não
satisfeito, PR aberta, branch local, estado espera, ordem), `toca` (cada mapeamento e
caminho fora de categoria), `degrau2` (cada condição derrubando sozinha), o parser do
Markdown e o `gerar`/`concluir` em pasta temporária.

---

## 5. Os quatro agentes (`.claude/agents/`)

Arquivos em `kit/claude/agents/`. Cada um recebe o `CLAUDE.md` do projeto automaticamente;
o prompt cita só a regra do papel. Renomeie o sufixo `-lmatelie` para o projeto novo e
**troque toda referência a suítes, rotas, URL de produção, projeto do Neon e arquivos** pelo
equivalente do projeto novo.

| Agente | Pode | Não pode | Devolve (schema) |
|---|---|---|---|
| **pm** | ler código; `gh`; GET no app no ar; SQL **só SELECT**; no refinamento, editar **só** `fila/**` na branch `planejamento` | commit na main, push, migração, decidir requisito | pré-voo `{ok, motivo, docker, neon_branches, prontos[], bloqueados[], em_pr[]}` · apuração `{veredito: segue\|devolve, motivo, achados, aceite_interpretado[]}` |
| **coder** | editar e commitar na worktree `.claude/worktrees/fila-<id>` (branch `fila/<id>` saída de `origin/main`); rodar suítes; `concluir` | push; `gh pr`; qualquer ferramenta do banco | `{status: pronto\|precisa_decisao\|falhou, motivo, worktree, branch, commits[]}` |
| **reviewer** | rodar as suítes inteiras; ler o diff todo; migração num **branch temporário** do banco; render de tela | editar; aplicar migração; `complete_database_migration` | `{veredito: aprova\|reprova, achados[], evidencia_por_aceite[], neon_usado, branch_neon}` |
| **entrega** | o fluxo completo do banco, merge, deploy, conferência no ar | agir sem "entrega a #N" do Caio (ou degrau 2 com escopo permitido) | `{entregue, migracao_aplicada, verificacao}` |

Pontos que fazem o arranjo funcionar (não são detalhe):

- **O PM devolve quando a apuração muda a figura do item**, quando uma frase do aceite é
  vaga ("melhorar", "se fizer sentido"), quando falta decisão escrita, ou quando o `toca`
  declarado não cobre o aceite. O `achados` vai **inteiro** para o relatório: é o insumo
  do próximo refinamento. Ver `referencia/relatorio-de-rodada-exemplo-2026-09-26.md`.
- **O coder para com `precisa_decisao`** quando esbarra numa escolha que o aceite não
  resolve. Vira devolução, não escolha por conta própria.
- **O reviewer roda as suítes ele mesmo**, não confia no relato do coder, e exige **uma
  evidência (teste ou comando) por frase do aceite**. Frase sem evidência é reprovação.
  O **Exemplo** do item também precisa de evidência.
- **Uma rodada de correção**: reprovado, o coder corrige e o reviewer revisa de novo.
  Segunda reprovação é falha.
- **Push e PR são de um agente pequeno, chamado pelo workflow depois da aprovação.** O
  coder nunca faz push: código não aprovado não sai da máquina.
- Na apuração e no pré-voo, **a saída do PM vai para um script**, não para uma pessoa:
  ele preenche o schema, sem floreio. No refinamento vai para o Caio: curta, por item.
- Migração "destrutiva" (DROP, DELETE) só em arquivo à parte que começa com
  `-- fase: pos-deploy`; o reviewer barra fora disso, a entrega roda esses por último.

---

## 6. O condutor: `.claude/workflows/fila.js`

Arquivo em `kit/claude/workflows/fila.js` (233 linhas). É um script do **Workflow tool**
do Claude Code, salvo com `meta.name = 'fila'`, disparado pela sessão principal com
`Workflow({ name: "fila", args: { limite: 3, degrau: 1, data: "AAAA-MM-DD" } })`.
Argumentos: `limite` (PRs por rodada, padrão 3), `degrau` (1 ou 2), `ensaio` (true = só
pré-voo e parecer do PM, sem coder), `data` (o script não tem relógio), `teto_neon`.

A sequência, por item da faixa Agora, na ordem:

1. **Pré-voo** (PM, uma vez): conta do `gh` certa, `git fetch --prune`, CI da main verde
   (senão a rodada não começa), Docker de pé (senão pula itens com migração), quantos
   branches do banco existem (teto), `candidatos`.
2. **PM apura** → `devolve` registra e segue para o próximo; `segue` continua. Em ensaio,
   para aqui.
3. **Coder implementa** na worktree → `precisa_decisao` devolve; `falhou` para a rodada.
4. **Escopo derivado do diff** (`fila.mjs toca`), por um agente de esforço baixo que só
   repassa JSON → fora do declarado devolve.
5. **Reviewer** → reprova uma vez: coder corrige, escopo de novo, reviewer de novo.
   Reprova duas: falha.
6. **PR**: push da branch, `gh pr create` com título e corpo **por arquivo** (nome de item
   com aspas ou `$` quebraria a linha de comando), etiquetas `fila` e `tem migração`,
   `gh pr checks --watch`. CI vermelho: falha.
7. **Degrau 2** (só com `degrau: 2`): `fila.mjs degrau2` decide; `ok` chama a entrega.
8. **Relatório** em `.superpowers/fila/<data>.md`: por item, resultado, PR, migração,
   branches temporários do banco deixados de pé, worktree, e o apurado do PM na íntegra.

Semântica dos resultados:

| Resultado | Conta no limite? | A rodada |
|---|---|---|
| devolvido | não | registra e segue |
| PR verde | sim | segue (ou entrega, no degrau 2) |
| falha (coder `falhou`, reprovado 2×, CI vermelho, agente morto) | — | **para**; worktree fica de pé |
| pulado (migração sem Docker, teto de branches) | não | segue |

O que adaptar: o nome dos `agentType`, os textos dos pedidos que citam suítes e caminhos,
as etiquetas da PR, o corpo da PR, o teto de branches do banco (ou remover se não houver
banco com branches). Os **schemas** e a **lógica de parada** podem ficar como estão. O
workflow não se testa com `node --test`; por isso tudo que precisa ser exato mora no
`fila.mjs`. **O ensaio é o teste de integração.**

Fato confirmado na origem: `agentType` no `agent()` funciona com os agentes de
`.claude/agents/`, e numa sessão nova eles aparecem em "Available agent types" sem
comando nenhum.

---

## 7. As travas

### 7.1 `.claude/settings.json` (versionado) — `kit/claude/settings.json`

Princípios:

- **allow pelo nome exato do que cada papel roda**: `git` só nos subcomandos usados,
  `git push` só `-u origin fila/*`, cada `node tools/<script>` pelo nome (um curinga
  `node tools/*` deixaria rodar `node tools/../fila/x.mjs`), suítes pelo comando inteiro,
  `gh` só leitura mais `pr create` e `pr checks`, `curl -s -H * https://<app>/*` (só GET),
  as ferramentas de leitura do banco, `Edit(fila/**)` e `Write(fila/**)` para o PM.
- **deny** de qualquer push cujo texto aponte para a main, `--force`, `--no-verify`,
  `git config *hooksPath*`, `node *..*`, e `curl` com `-X`, `-d`, `--data`, `-F`, `-T`.
- **Fora do allow de propósito**: `gh pr merge` e `complete_database_migration`. A
  entrega pede permissão, e o Caio está presente quando diz "entrega a #N".
- As regras casam **texto de comando**, então se contornam; o que segura de verdade é o
  hook e o `tools` de cada agente. E `run_sql` "só SELECT" é regra de prompt, não trava.
- Se a rodada travar pedindo outra regra, acrescente **a regra exata** que ela pediu, e
  registre onde.

### 7.2 Hook `pre-push` — `kit/tools/hooks/pre-push`

Olha a ref de **destino** de cada push; `refs/heads/main` → recusa. Instalar uma vez por
clone: `git config core.hooksPath tools/hooks`. Existe porque o GitHub do plano gratuito
não protege a main no servidor e porque, no projeto de origem, push na main publica o site.
Se no projeto novo a main for protegida no servidor, o hook ainda vale como cinto.

### 7.3 `.gitignore`

```
.superpowers/            # relatórios e rascunhos de execução
.claude/worktrees/       # worktrees da rodada
.claude/settings.local.json
```

`.claude/agents/`, `.claude/workflows/` e `.claude/settings.json` **se versionam**.

### 7.4 CI — trecho de `kit/ci.yml`

```yaml
- name: Fila bem formada e docs/fila.js em dia?
  run: |
    node --test tools/test-fila.mjs
    node tools/fila.mjs checar
    node tools/fila.mjs gerar --conferir
```

### 7.5 Etiquetas e conta

```bash
gh label create "fila" --color 5319e7 --description "PR aberta pela rodada autônoma" --force
gh label create "tem migração" --color d93f0b --description "Aplicar no banco antes do merge, pelo entrega a #N" --force
```

O pré-voo confere a conta ativa do `gh` (na origem há duas contas na máquina e a errada dá
404 no repositório privado).

---

## 8. O ciclo de planejamento (antes da rodada)

1. Os itens se editam na branch **`planejamento`** (uma por ciclo, não uma PR por frase).
2. **O Caio descreve os cards na conversa, um por vez, em linguagem livre.** O assistente
   escolhe o id, escreve o `fila/<id>.md` (Problema, Valor, DoD, Exemplo, Fora, `toca`) a
   partir do que ele disse e do que apurar no código e no banco, manda as perguntas
   daquele card, espera a resposta, e só então passa ao próximo. Ele não conhece a
   numeração nem sabe onde cada item esbarra no código — isso é trabalho do assistente.
3. **"PM, revisa o planejamento"** → `Agent` `pm-<proj>` com esse pedido. O PM lê os
   itens que mudaram desde a main e todos os de Agora; apura como na rodada (DoD
   conferível? o dado existe? o `toca` cobre? o Exemplo bate com o banco?); escreve
   perguntas e recomendações em **Perguntas em aberto**, marcadas `(PM, data)`, com o
   comando ou número que as originou. **Não altera Problema, Valor, DoD nem Fora por conta
   própria.**
4. O Caio responde no arquivo (embaixo da pergunta) ou na conversa. Na passada seguinte o
   PM transforma a resposta em linha de **Decisões** e apaga a pergunta.
5. **"fecha o planejamento"** → o PM marca `estado: pronto` só nos itens que o Caio disse
   estarem prontos, com a linha de decisão; roda `checar` e `gerar`; commita na branch.
   A sessão principal faz o push e abre **uma** PR.
6. Depois de mergeada: **ensaio** (`ensaio: true`) e então a rodada real.

Regra de convivência que veio de uma quase desistência: **nunca entregar comando git ou de
terminal para o Caio rodar.** O assistente faz; se a permissão barrar, usa um caminho
permitido ou pede um clique de aprovação. A lista do que o Caio precisa fazer é a menor
possível: responder e dizer "pode".

---

## 9. Gatilhos de conversa → o que a sessão principal faz

| O Caio diz | A sessão faz |
|---|---|
| "PM, revisa o planejamento" | `Agent` `pm-<proj>` com o pedido, na branch `planejamento` |
| "fecha o planejamento" | o mesmo; depois push da branch e **uma** PR |
| "roda a fila" | `Workflow` `name: "fila"`, `args: {limite: 3, degrau: 1, data: "<hoje>"}`; ao fim mostra o relatório e manda `PushNotification` com o resumo |
| "ensaia a fila" | o mesmo com `ensaio: true` |
| "entrega a #N" | `Agent` `entrega-<proj>` com `O Caio mandou: entrega a #N`. Uma PR por vez |
| card novo descrito na conversa | escreve `fila/<id>.md`, pergunta, espera, próximo |

---

## 10. Seção para o `CLAUDE.md` do projeto novo (modelo)

```markdown
## A fila autônoma

A fila mora em `fila/`: um `<id>.md` por item aberto (Problema, Valor, Pronto quando,
Exemplo, Fora, Decisões, Perguntas em aberto), `ORDEM.md` com as faixas
Agora/Próximo/Depois e `feitos.js` com o histórico. O `docs/fila.js` é **gerado** —
nunca edite à mão.

- **"PM, revisa o planejamento"** → `Agent` `pm-<proj>` com esse pedido, na branch
  `planejamento`. **"fecha o planejamento"** → o mesmo; depois push da branch e **uma** PR.
- **"roda a fila"** → `Workflow` com `name: "fila"` e
  `args: {limite: 3, degrau: 1, data: "<AAAA-MM-DD de hoje>"}` (o script não tem
  relógio). `ensaio: true` roda só o pré-voo e o parecer do PM, sem coder.
- Quando terminar: mostrar o relatório e mandar `PushNotification` com o resumo.
- **"entrega a #N"** → `Agent` `entrega-<proj>` com `O Caio mandou: entrega a #N`.
- Devolvido **não é falha**. Falha para a rodada e deixa a worktree de pé em
  `.claude/worktrees/fila-<id>`; enquanto a branch `fila/<id>` existir sem PR, o item
  fica bloqueado (de propósito: alguém tem que olhar).
- **A main só muda por PR.** Hook `tools/hooks/pre-push`; instalar uma vez por clone:
  `git config core.hooksPath tools/hooks`. Script novo em `tools/` que os papéis
  precisem rodar entra no `allow` do `.claude/settings.json` pelo nome.
```

E na lista de verificações do `CLAUDE.md`:

```
node --test tools/test-fila.mjs   # regras da fila autônoma
node tools/fila.mjs checar        # fila/ bem formada
node tools/fila.mjs gerar         # regera docs/fila.js — o CI confere
```

---

## 11. Ordem de implantação

Uma PR normal, fora da fila. Comece simples: o tool e o formato primeiro, os agentes
depois, o workflow por último.

1. Perguntas da seção 12 respondidas pelo Caio.
2. `fila/` com `_modelo.md`, `README.md`, `ORDEM.md` vazio nas três faixas e
   `feitos.js` com `const ITENS = [];` (ou migrado do backlog atual, se houver).
3. `tools/fila-md.mjs` copiado; `tools/fila.mjs` copiado e adaptado (4.2);
   `tools/test-fila.mjs` copiado e adaptado; verde.
4. `.gitignore`, `.claude/settings.json`, hook instalado, etiquetas criadas, CI.
5. Os quatro agentes, adaptados. Conferir numa sessão nova que aparecem em
   "Available agent types".
6. `.claude/workflows/fila.js` adaptado.
7. Seção do `CLAUDE.md`.
8. Dois ou três cards pequenos escritos com o Caio (seção 8), um ciclo de planejamento,
   ensaio, e então rodada real com `limite: 2`, degrau 1.

**Sucesso:** o Caio daria merge nas PRs sem pedir mudança, e as devoluções trazem o
apurado que ele teria feito. PR que precisar de retrabalho: olhar **qual guarda deixou
passar** antes de rodar de novo.

---

## 12. Perguntas para o Caio antes de adaptar

As respostas mudam `tocaDeCaminhos`, `degrau2`, o reviewer e a entrega.

1. **Merge é deploy?** No projeto de origem, push na main publica o site na hora. Se aqui
   não for, o degrau 1 pode ir até o merge, mas mantenha a entrega como passo separado
   enquanto não houver conferência no ar.
2. **Tem banco com migração?** Qual? Tem como validar uma migração fora de produção
   (branch temporário como no Neon, container como o `check_sql.py` com Docker)? Sem
   isso, `migracao` sai da autonomia e vai só para a entrega.
3. **Quais são as suítes** que provam que nada quebrou, com o comando exato de cada uma?
   Elas entram no coder, no reviewer, no `settings.json` e no CI.
4. **Quem é a usuária final e o que ela vê?** Isso define o que é `tela:` e o que barra o
   degrau 2. Se houver render de tela (a origem usa `ver_tela.py` a 430 px, claro e
   escuro), o reviewer olha as capturas.
5. **Existe uma "fórmula canônica"** ou outro ativo com cópias que precisam andar juntas?
   Vira categoria própria no `toca` e item do checklist do reviewer.
6. **O que não auto-deploya** e exigiria alguém rodar um deploy à mão depois do merge?
   Barra o degrau 2.
7. **Há dado sensível** que não pode aparecer na fila, em teste ou em fixture? O reviewer
   confere e a fila é pública se houver vitrine.
8. **Quer a vitrine** (`docs/fila.js` + página que o carrega)? Se não, o `gerar` fica só
   como guarda no CI.
9. **Onde mora o dossiê** de cada item (na origem, `IDEIAS.md` e `ESTADO.md`)? O coder
   atualiza os dois na PR do item.
10. **Conta do `gh`** e nome do repositório: o pré-voo confere.

---

## 13. Armadilhas já pagas na origem

- **Chute não sinalizado invalida conclusão inteira.** É a razão de o PM nunca decidir.
- **Código novo contra schema velho derruba a tela.** Migração vai antes do merge, sempre;
  destrutivo só depois do deploy (`-- fase: pos-deploy`).
- **"PR mergeada" ≠ "feature no ar"; "deployou" ≠ verificação.** A entrega chama a rota no
  ar e confere o formato novo antes de dizer entregue.
- **Queixa sobre uma tela se apura chamando a tela**, não lendo o código. O `sql` falso das
  suítes prova que a consulta cita a coluna certa, nunca que roda.
- **Escopo sai do diff, não do relato do coder**: quem se desviou é justamente quem não
  percebeu.
- **Três apurações num item de complexidade baixa custaram ~250k tokens** porque o
  refinamento não era conjunto. Daí o ciclo de planejamento com o PM antes da rodada.
- **CRLF no Windows** (`core.autocrlf=true`): o parser normaliza; scripts novos também
  devem.
- **Obsidian regrava listas do frontmatter em bloco** (`exige:\n  - B49`) pelo painel de
  Propriedades; o parser aceita só `[B49]`. Editar as listas no texto.
- **Mensagem de commit contendo o texto "--no-verify" casa com o deny** do `settings.json`.
  Passar a mensagem por arquivo (`git commit -F`).
- **Nome de item com aspas, crase ou `$` quebra `gh pr create` na linha de comando.**
  Título e corpo vão por arquivo.
- **Ferramentas destrutivas do MCP** (as marcadas "NEVER run autonomously") ficam fora da
  rodada e só na entrega. Ler as descrições do MCP antes de decidir o que cada agente
  pode chamar.
- **Um pedido de permissão trava a rodada sem ninguém olhando.** Cada regra que a rodada
  pediu entrou no allow pelo nome exato.
- **PRs da mesma rodada conflitam nos arquivos de registro** (`feitos.js`, `ORDEM.md`,
  `docs/fila.js`, dossiê). A entrega resolve mantendo os dois lados e **regenerando** o
  gerado, nunca à mão.
- **Branches temporários do banco ficam de pé** depois da rodada (apagar é destrutivo).
  O relatório e o corpo da PR os listam; a entrega descarta.
