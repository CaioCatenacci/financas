# Financas — instruções para o assistente

Sistema pessoal de captura e análise de comprovantes financeiros. O **Caio** constrói
e mantém o sistema; ele é o único usuário final.

Leia o `CONTEXTO.md` antes de mexer em qualquer coisa: ele tem a história das
decisões (por que imagem-primeiro, por que um Worker só, por que Gemini+fallback,
etc.) e impede re-litigação.

---

## A regra que organiza o projeto

**Nada entra no repositório antes de existir funcionalidade que funcione de
ponta a ponta.**

Consequência prática: **desconfie de infraestrutura.** Se a resposta para um
problema é "adicionar um componente", provavelmente é a resposta errada.

---

## Convenções de código

- **Dinheiro é sempre em centavos na API.** No JS (Worker), usa-se `parseBRtoCents()`
  de `worker/money.js` para converter string → inteiros; **toda agregação roda em SQL**
  (exato, `numeric(12,2)`). Nada de acumular float em JavaScript.
- **As parcelas têm que fechar com o total.** Uma conta que não fecha não é usada,
  mesmo estando certa na quarta casa.
- `extrair.js` e `money.js` são **puros**: sem banco, sem rede, sem I/O. Tudo entra
  por parâmetro. Torna auditável quando o número parece errado.
- Comentários e testes **em português**, explicando o *porquê*, não o *quê*.
- Em JS, `parseBRtoCents()` sempre: teclado brasileiro entrega vírgula/ponto. Campo
  de número usa `type="text"` + `inputmode="decimal"`.

---

## Vocabulário fixo das colunas

**Estas combinações têm significado semântico preciso. Não inveniar novos valores.**

| Campo | Valores válidos | Significado |
|---|---|---|
| `natureza` | `despesa` \| `receita` | direção do fluxo |
| `esfera` | `pessoal` \| `empresa` | (empresa é Incremento 5) |
| `fonte` | `imagem` \| `manual` \| `extrato` \| `fatura` \| `importacao` | onde veio / como entrou |
| `origem_categoria` | `modelo` \| `manual` \| `regra` | quem sugeriu a categoria |
| `extraido_por` | `gemini` \| `claude` | qual modelo leu o comprovante |

Valores são **minúsculos, sem espaço, sem acentuação**. Validação no Worker.

**Nota:** a UI chama a coluna `macro` de "Categoria"; internamente, as colunas seguem
como `macro` (nível 1) e `sub` (nível 2, opcional). Renomear a coluna cascatearia em
schema/queries/extração/import sem ganho prático — a etiqueta de rótulo é só na UI.

### Colunas novas (Incremento 2)

| Coluna | Tabela | Descrição |
|---|---|---|
| `contraparte_nome` | `transacoes` | destinatário/pagador lido do comprovante |
| `contraparte_chave` | `transacoes` | chave Pix/CPF normalizada (null se não houver) |

Novidade: `origem_categoria = 'regra'` significa a categoria veio de uma associação
aprendida (mapeamento contraparte → categoria confirmado manualmente em transações
anteriores). A tabela `associacoes` guarda essas regras.

### Tabela `associacoes` (Incremento 2)

```sql
create table associacoes (
  chave       text not null,
  tipo_chave  text not null check (tipo_chave in ('pix_cpf','nome')),
  macro       text not null,
  sub         text,
  n           integer not null default 1,
  atualizado_em timestamptz not null default now(),
  primary key (chave, tipo_chave)
);
```

Uma associação por (chave, tipo). Lookup na captura tenta `pix_cpf` primeiro, depois `nome`.

### Pessoa (Incremento 2.5, Fase A)

`pessoa` é dropdown de lista fixa **gerenciável** — separa, p.ex., escola do Lucca vs da
Manuela. A tabela `pessoas(id, nome, ativa)` é a fonte; `transacoes.pessoa_id` referencia
por id (a coluna string `transacoes.pessoa` segue durante a transição e sai na limpeza da
Fase B). O comprovante não diz de quem é o gasto → `pessoa_id` é preenchido **na mão** no
app (select editável na tabela de Lançamentos, `PATCH {pessoa_id}`; vazio → null).

| Coluna | Tabela | Descrição |
|---|---|---|
| `pessoa_id` | `transacoes` | FK → `pessoas(id)`; quem (Lucca/Manuela/Casa/…), editável no app |

```sql
create table pessoas (
  id    uuid primary key default gen_random_uuid(),
  nome  text not null unique,
  ativa boolean not null default true
);
```

O Resumo ganha o corte **"Gasto por pessoa"** (`/api/resumo` devolve `porPessoa`;
`GET /api/pessoas` lista as ativas). Migração aditiva em `migrations/0003_pessoas.sql`
(semeia Caio/Paola/Lucca/Manuela/Casa + nomes já existentes no histórico, backfill do
`pessoa_id` pelo nome).

### Categorias por id (Incremento 2.5, Fase B)

Categoria/subcategoria deixaram de ser strings em `transacoes`/`associacoes` e viraram
**tabelas por id** (renome/mesclar viram triviais, e há tela de gestão). O modelo:

```sql
create table categorias    (id uuid pk, nome text unique, natureza text, ativa bool);
create table subcategorias (id uuid pk, categoria_id uuid → categorias, nome, ativa,
                            unique(categoria_id, nome));
```

`transacoes` e `associacoes` ganharam `categoria_id`/`subcategoria_id` (FK). A migração
`0004_categorias_fk.sql` é **aditiva**: renomeou a tabela antiga `categorias`(macro/sub)
para `categorias_legacy`, criou o modelo novo, e fez **backfill genericizado** a partir do
mapa aprovado (`docs/genericizacao-map.csv`, não versionado): cada `(macro,sub)` virou
`categoria_id/subcategoria_id`, e o favorecido específico foi pra `descricao` quando ela
era redundante. As colunas string (`macro`/`sub`) ficam vestigiais (NOT NULL solto) até a
limpeza `0005` (drop) — gate destrutivo, só após o cutover validado.

- **Extração:** o modelo devolve **nomes**; ao gravar, `resolverCategoria(nome→id)` de
  `worker/categorias.js` resolve (fallback `Outros`, que sempre existe). A regra aprendida
  (`associacoes`) e o `/aprender` também gravam por id.
- **API:** `GET /api/catalogo` (categorias+subcategorias); CRUD em `/api/categorias`,
  `/api/subcategorias` (inclui `POST /api/subcategorias/merge`) e `/api/pessoas`; o
  `/api/resumo` apelida `c.nome as macro` no join — por isso os gráficos não mudaram.
- **UI:** Lançamentos usa selects por id; a aba **"Ajustes"** gere categorias/subs/pessoas
  (add/renomear/mesclar/desativar).
- **Tools:** `tools/categorias.py` (`resolver_categoria`/`carregar_catalogo`) — `import_planilha`
  e `ensino_aplicar` resolvem nome→id.

A UI chama `categoria` a categoria (nome) e `subcategoria` a sub; internamente é tudo por id.

**Natureza segue a categoria ao reclassificar** (`naturezaAoReclassificar`, `worker/categorias.js`;
aplicada em `atualizarTransacao` e no UPDATE único de `atualizarTransacoesLote`): categoria de
receita → `receita`; de despesa → `despesa`, **exceto** crédito/estorno vindo de `extrato`/`fatura`
(receita sob categoria de despesa), que fica como está. Não há controle de natureza na UI.

### Categoria padrão por flag (fix de 25/09/2026)

O fallback de `resolverCategoria` (worker, `public/app.js` e `tools/categorias.py`) **não é mais
por nome**: é a categoria com `categorias.padrao = true` (migração `0008`, índice parcial garante
uma só). Motivo: "Outros" foi renomeada na aba Ajustes e o fallback por nome literal devolveu
`categoria_id` null → not-null no insert → webhook do Telegram em 500, bot mudo. Semântica:

| Categoria | Papel |
|---|---|
| `Não Identificado` (`padrao=true`) | recebe o que ninguém classificou; fila de triagem |
| `Outros` | miscelânea **deliberada** (o Caio escolhe); não é fallback |

`db.desativarCategoria` ignora a padrão (`and not padrao`); a aba Ajustes mostra o selo "padrão"
e esconde o botão desativar. Renomear a padrão é livre. `handleTelegram` tem try/catch: erro vira
resposta "⚠ Deu erro ao registrar…" + `200` (nunca 500 — o Telegram retentaria em loop, mudo).

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

**Import:** um casado insere a linha do extrato no grupo do lançamento (novo ou existente),
nunca carimba o hash nele; candidatos ao casamento excluem extrato/fatura, hash antigo e grupo
que já tem extrato; os importadores Python seguem no modelo antigo (BACKLOG C6).

---

## A fila autônoma

A fila mora em `fila/`: um `<id>.md` por item aberto (Problema, Valor, Pronto quando,
Exemplo, Fora, Decisões, Perguntas em aberto), `ORDEM.md` com as faixas
Agora/Próximo/Depois e `feitos.js` com o histórico (escrito só pelo `concluir`). Receita
completa em `docs/superpowers/specs/2026-09-26-fila-autonoma-receita.md`; plano de
implantação em `docs/superpowers/plans/2026-09-26-fila-autonoma.md`.

- **Card novo descrito na conversa** → o assistente escolhe o id, escreve `fila/<id>.md`
  a partir do que o Caio disse e do que apurar no código, faz as perguntas daquele card,
  espera, e só então passa ao próximo. Se veio do `BACKLOG.md`, a linha sai de lá.
- **"PM, revisa o planejamento"** → `Agent` `pm-financas` com esse pedido, na branch
  `planejamento`. **"fecha o planejamento"** → o mesmo; depois push da branch e **uma** PR.
- **"roda a fila"** → `Workflow` com `name: "fila"` e
  `args: {limite: 3, degrau: 2, data: "<AAAA-MM-DD de hoje>"}` (o script não tem
  relógio). **"ensaia a fila"** → o mesmo com `ensaio: true` (só pré-voo e parecer do
  PM, sem coder). Quando terminar: mostrar o relatório e mandar `PushNotification` com
  o resumo.
- **Degrau 2 é o padrão:** PR verde com `auto_merge: true`, aprovada de primeira, sem
  `migracao` e sem código fora do vocabulário é mergeada, deployada (`node tools/deploy.mjs`,
  sempre de uma worktree limpa do `origin/master`) e conferida no ar pela
  `entrega-financas` sem ninguém olhar. Item com migração para na
  PR verde e espera **"entrega a #N"** → `Agent` `entrega-financas` com
  `O Caio mandou: entrega a #N` (uma PR por vez; `python tools/db.py aplicar` pede
  permissão de propósito).
- Vocabulário `toca` (escopo declarado; o diff tem que caber nele): `migracao`
  (`migrations/`, `schema.sql`), `worker` (`worker/`), `app` (`public/`), `tools`
  (`tools/*.py`). Regras dos agentes (`.claude/`, `CLAUDE.md`, `tools/fila*.mjs`,
  `tools/db.py`, `tools/app.mjs`, `tools/deploy.mjs`, `tools/hooks/`) nunca são neutras
  e nunca vão pelo degrau 2.
- Devolvido **não é falha**. Falha para a rodada e deixa a worktree de pé em
  `.claude/worktrees/fila-<id>`; enquanto a branch `fila/<id>` existir sem PR, o item
  fica bloqueado (de propósito: alguém tem que olhar).
- **O master só muda por PR.** Hook `tools/hooks/pre-push`; instalar uma vez por clone:
  `git config core.hooksPath tools/hooks`. Script novo em `tools/` que os papéis
  precisem rodar entra no `allow` do `.claude/settings.json` pelo nome.
- Banco sem MCP: `python tools/db.py select` (read-only), `ensaiar` (transação +
  rollback), `aplicar` (só a entrega). App no ar: `node tools/app.mjs api/<rota>`
  (token de `.dev.vars`, só GET, rota **sem a barra inicial** — o Git Bash do Windows
  converteria `/api/...` em caminho). Nunca `curl` com o token.
- **O repositório é público:** nada de valor real, contraparte, chave Pix ou comprovante
  em `fila/`, teste, fixture, PR ou relatório.

---

## Segurança — inegociável

### Secrets do wrangler

**Nunca colocar no código/repo.** Todos vão como Secrets do wrangler (não Text):

1. `TELEGRAM_TOKEN` — token do bot (BotFather)
2. `TELEGRAM_SECRET` — secret_token da validação (webhook)
3. `ALLOWLIST` — **como Secret, não Text** (isso importa: `deploy` sobrescreve Text)
4. `GEMINI_KEY` — chave da API Google Gemini
5. `CLAUDE_KEY` — chave da API Anthropic
6. `DATABASE_URL` — connection string do Neon
7. `DROPBOX_REFRESH` — refresh token OAuth Dropbox
8. `DROPBOX_APP_KEY` — app key Dropbox
9. `DROPBOX_APP_SECRET` — app secret Dropbox
10. `APP_TOKEN` — token único do acesso ao app web
11. `C6_PDF_SENHA` — senha do PDF do extrato do C6 Bank (usada só no navegador, via `GET /api/importar/c6-senha`)
12. `CONTAS_PROPRIAS` — nomes das contas do Caio, separados por vírgula, como aparecem no extrato do C6 (repasse entre contas próprias sai do resumo)

Configurar via `wrangler secret put NOME` (lê do stdin).

### Proteções

- **Allowlist do Telegram falha fechada:** lista vazia recusa todos.
- **App atrás de token:** todas as rotas `/app` e `/api/*` conferem o token do cookie.
- **`.gitignore`** cobre `dados/`, `*.xlsx`, `*.csv`, `__pycache__/`, `*.pyc`, `.env`,
  `.dev.vars`. Nenhum dado financeiro nem sensível sai do repositório.
- Sem login, sem conta, sem senha: acesso via token único no navegador.

---

## Como rodar as verificações

```bash
npm test                                      # Worker + app + regras da fila (globs em package.json)
python -m pytest tests/                       # import, mapeamento e tools/db.py
node tools/fila.mjs checar                    # fila/ bem formada
```

O CI (`.github/workflows/ci.yml`) roda os três.

---

## Roadmap dos incrementos

| # | Incremento | O que faz | Status |
|---|---|---|---|
| 1 | **Captura + ver** | imagem → extrai → grava + Dropbox → app lista/resumo; importa histórico | implementado |
| 1.5 | Lançamento manual | texto (`"15,50 padaria 29/08"`) via Claude, validado | implementado |
| 2 | Classificador que aprende | app grava correções; sistema passa a acertar | implementado |
| 3 | Extrato + fatura | PDF → parsing → transações; conciliação | implementado (app + tools) |
| 4 | Planejamento | metas/realizado vs alvo | implementado (mês + grade) |
| 4.6 | Agrupamento | duplicatas explícitas com representante; import grava o grupo | implementado (A+B) |
| 5 | Camada PJ | receita empresa → cascata → despesas casa | Incremento 5 |
| 6 | Plus | investimentos; estrutura fina Dropbox | Incremento 6 |

A v1 (Incremento 1) nasceu **imagem-apenas**; o texto entrou no 1.5 (`worker/texto.js`) e o PDF
(extrato/fatura) no 3.

### Extrato + fatura (Incremento 3)

PDF do extrato e da fatura do Itaú vira transações com `fonte = 'extrato'` / `'fatura'`. O PDF
nunca sai do navegador: `public/pdf_extrair.js` (pdf.js) extrai o texto e reconstrói as linhas, e
o Worker só recebe texto. Os parsers são puros e determinísticos (sem modelo): parse → checksum →
classifica → reconcilia → prévia → o Caio revisa na aba **Importar** → grava.

| Peça | Onde | Papel |
|---|---|---|
| parser do extrato | `worker/extrato.js` | linha `DD/MM/AAAA desc valor`; sinal dá a natureza; "SALDO DO DIA" é saldo, confere o checksum |
| parser da fatura | `worker/fatura.js` | itens do período até "Total dos lançamentos atuais"; soma abaixo do total (IOF) é aviso, não erro |
| orquestração | `worker/importar.js` | `montarPreviewExtrato`/`montarPreviewFatura` (puros) e `aplicar` (único que recebe `db`) |
| reconciliação | `worker/reconciliar.js` | `linhaHash` (idempotência) e `reconciliarLinha` (mesmo valor, data ±3 dias → novo/casado/ambíguo) |
| `linha_hash` | `transacoes` | chave estável da linha (índice único parcial): reimportar o mesmo PDF não duplica |
| `computa_resumo` | `transacoes` | `false` = não-gasto (aplicação, pagamento da fatura no extrato) |

Rotas: `POST /api/importar/preview` (`{tipo: 'extrato'|'fatura', texto, conta | ano+mes}` →
itens classificados + status de reconciliação) e `POST /api/importar/aplicar` (grava a decisão
revisada; na fatura, marca o pagamento correspondente no extrato como fora do resumo). O casado
entra no grupo do lançamento (seção do Inc 4.6).

**Tools:** `tools/importar_extrato.py` e `tools/importar_fatura.py` (dry-run sem `--commit`;
parsers em `tools/extrato_itau.py`/`tools/fatura_itau.py`, `tools/reconciliar.py`) são o caminho
local do mesmo fluxo e seguem no modelo antigo, sem grupo (BACKLOG C6).

### Colunas novas (Incremento 4)

Alvo de gasto por categoria, mês a mês, comparado contra o realizado. Modelo temporal:
**baseline com vigência** (`metas`, "a partir deste mês, o alvo é V", propaga pra frente até
um baseline mais novo) + **exceção pontual** (`metas_excecao`, "só este mês", não propaga).
Só despesa, só por categoria (`macro`) — sem subcategoria, sem pessoa/esfera.

| Tabela/coluna | Descrição |
|---|---|
| `metas(categoria_id, vigente_desde, valor_alvo)` | baseline: alvo vale a partir de `vigente_desde` até o próximo baseline |
| `metas_excecao(categoria_id, mes, valor_alvo)` | exceção: alvo só naquele `mes`, não propaga |

Vocabulário: `origem ∈ {excecao, baseline, sem-alvo}` — de onde veio o alvo resolvido pra um
mês (leitura, `GET /api/metas`); `escopo ∈ {baseline, excecao}` — pra onde grava uma edição
(escrita, `PUT /api/metas`). Resolução (`exceção > baseline > sem-alvo`) roda em JS puro
(`worker/metas.js`), no mesmo espírito de `money.js`/`extrair.js`.

Rotas: `GET /api/metas?mes=YYYY-MM` (alvo/realizado/diff por categoria + total),
`GET /api/metas/sugestao?mes=YYYY-MM` (média do realizado dos 3 meses anteriores, pra
prefill), `PUT /api/metas` e `DELETE /api/metas` (gravam/removem por `escopo`),
`GET /api/metas/grade` (grade categorias × meses, Fase B).

### Incremento 4.5 — filtro único de mês + Resumo por mês fechado

Um único seletor `<input type="month">` (`#mesSel`, estado `estado.mes`, formato `'YYYY-MM'`)
governa todas as abas — Lançamentos, Planejamento e Resumo. Os presets antigos (`.period`,
`periodoRange`) saíram; Lançamentos ganhou o chip "Todos os meses" como escape hatch.

O Resumo fecha no mês selecionado (antes era um período livre com presets): `/api/resumo?mes=`
devolve, além dos cortes existentes, `diario` (gasto acumulado dia a dia, `total_cents` em
centavos) e mantém `porPessoa`/`porCategoria`/`mesVsAnterior` ancorados nesse mês. O card de
evolução virou **"Gasto no mês"** (`drawDiario`): curva de gasto acumulado × reta de ritmo do
orçamento (`acumularDiario`/`paceOrcamento`, `public/app.js`), lida contra `/api/metas?mes=`.
O donut de categoria virou **sunburst** (`drawSunburst`): anel interno categoria, anel externo
subcategoria, com clique pra focar/desfocar uma categoria. O corte por pessoa virou **rosca**
(`drawPessoaDonut`, total no centro) e ganhou um **bullet chart** de orçamento × realizado por
categoria (`drawBullet`). O dumbbell mês-vs-anterior e o waterfall seguem os mesmos.

Faseamento: Fase 1 trocou só o seletor de Lançamentos/Planejamento sem tocar no Resumo (que
seguia com `.period`); Fase 2 fechou o Resumo no mês e removeu os presets de vez.
