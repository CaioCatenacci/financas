# Finanças da casa — Incremento 1: captura de comprovantes

**Data:** 2026-08-29
**Status:** desenho aprovado, aguardando revisão da spec antes do plano de implementação
**Projeto:** repo novo e separado da LM Ateliê, em `C:\Users\caioc\Caio\financas`

---

## 1. Contexto e objetivo

O Caio controla as finanças da casa numa planilha Excel (`Dropbox/Finanças/Gastos.xlsx`,
453 linhas, 2022–2026). O fluxo hoje: a cada pix/transferência ele manda o comprovante
pra si mesmo no WhatsApp e depois anota na planilha à mão. A planilha foi útil no IR —
ficou fácil ver gastos dedutíveis (saúde/educação) e quanto voltou de reembolso do plano.

Inspirado na LM Ateliê (onde um bot de Telegram destravou o fluxo operacional), a meta é
um sistema pessoal onde a **caixa de entrada é um bot de Telegram** e a análise vive num
**app visual** de uso próprio.

A visão completa tem ~11 subsistemas (captura, extração, parsing de extrato/fatura,
conciliação, classificador que aprende, investimentos, dashboard, metas, receitas,
contabilidade PJ em cascata, arquivo perene). É grande demais pra uma spec só, e vale a
**regra nº 1 da LM Ateliê**: nada entra no repo antes de funcionar ponta a ponta. Por isso
foi fatiado em incrementos (ver §13). **Esta spec cobre só o Incremento 1.**

## 2. Escopo do Incremento 1

**Entra:**
- Bot de Telegram que recebe **foto/print de comprovante** (o modo dominante — ~95% do que
  o Caio anota são imagens).
- Extração dos campos da imagem (data, valor, descrição, categoria sugerida) via modelo.
- Gravação da transação no Neon.
- Arquivamento do original no Dropbox com nome padronizado.
- App web (atrás de token) com duas telas: **Lançamentos** (tabela editável) e **Resumo**
  (três painéis visuais).
- Importação única do histórico da planilha (2022–2026) pro banco.

**NÃO entra (incrementos futuros, ver §13):**
- Lançamento manual em texto (`"15,50 padaria 29/08"`) — *fast-follow* logo após a v1.
- PDF de extrato/fatura, parsing e conciliação — Incremento 3. Na v1 o bot recebe PDF mas
  responde "isso é do próximo incremento", pra não fingir que fez.
- Classificador que aprende com correções — Incremento 2 (a v1 já grava as correções que
  ele vai usar).
- Metas/planejamento — Incremento 4.
- Camada PJ em cascata — Incremento 5.
- Investimentos e nome/estrutura fina do Dropbox — Incremento 6.

## 3. Decisões tomadas no brainstorming

| Tema | Decisão |
|---|---|
| Ponto de partida | Incremento 1 (captura + ver). |
| Modo de entrada v1 | **Só imagem.** Texto manual e PDF ficam pra depois. |
| Modelo de categoria | **Dois níveis** (macro + sub) **+ reembolso** desde a v1. |
| Documento original | **Guardar no Dropbox** já na v1. |
| Loop de correção | Bot confirma o que leu; **correção acontece no app** (app já nasce editável). |
| Histórico | **Importar tudo** (2022–2026) na v1. |
| Extração | **Gemini Flash como padrão, fallback pro Claude** por erro/baixa confiança. Módulo trocável. |
| Modelos locais | **Descartados** — o Worker roda na nuvem e não alcança o localhost; usá-los ressuscitaria a arquitetura servidor-em-casa→tunnel que matou a v1 da LM Ateliê. |
| Nº de Workers | **Um só** (webhook + app + api), divergindo da LM de propósito, por ser ferramenta pessoal. |
| Arquivamento Dropbox | **Pasta por data, categoria no nome.** Banco é o índice. |
| Resumo v1 | Três painéis: gastos por categoria; evolução mensal receita×despesa; corte reembolso/IR. |
| Repo | `C:\Users\caioc\Caio\financas`, git novo, separado da LM Ateliê. |

## 4. Arquitetura e peças

Um único Worker Cloudflare, três rotas:

```
Telegram  ──►  Worker (Cloudflare)  ──►  Neon Postgres
 (Caio)         │  /telegram  webhook: valida, lê, grava
                │  /app       HTML do dashboard (atrás de token)
                │  /api/*     leitura + edição pro app (atrás de token)
                ├──►  Gemini Flash / Claude (visão)  — extrai campos do print
                └──►  Dropbox API                    — sobe o original nomeado
```

| Peça | Papel | Conta / custo |
|---|---|---|
| Bot Telegram (BotFather) | interface de captura | grátis |
| Cloudflare Worker | webhook + app + api num deploy | grátis (100k req/dia) |
| Gemini Flash (padrão) | lê o print → JSON estruturado | pago, centavos (conta paga do Caio) |
| Claude (visão, fallback) | extração quando Gemini falha/baixa confiança | pago, metrado (≠ limite da assinatura) |
| Neon Postgres | onde a transação mora | grátis |
| Dropbox API | arquivo perene do original, nome padronizado | grátis (conta do Caio) |

**Pré-requisitos manuais** (como o BotFather): criar o App do Dropbox e obter refresh
token; criar projeto Neon; obter chaves Gemini e Claude. Tudo vira Secret do wrangler.

## 5. Modelo de dados

Princípio: a v1 grava pouco, mas as colunas que os incrementos futuros precisam já nascem
quando são baratas; o que exige tabela nova de verdade fica pra depois.

### `transacoes`

```sql
id              uuid  primary key default gen_random_uuid()
data            date        not null          -- data do gasto
natureza        text        not null          -- 'despesa' | 'receita'
esfera          text        not null default 'pessoal'  -- 'pessoal' | 'empresa' (Inc 5)
valor_total     numeric(12,2) not null        -- magnitude bruta, sempre positiva
valor_reembolso numeric(12,2) not null default 0
valor_final     numeric(12,2) generated always as (valor_total - valor_reembolso) stored
macro           text        not null          -- categoria nível 1 (FK categorias)
sub             text                          -- categoria nível 2 (FK categorias)
descricao       text                          -- o "Gasto"/estabelecimento
pessoa          text                          -- coluna Pessoa
fonte           text        not null          -- 'imagem'|'manual'|'extrato'|'fatura'|'importacao'
origem_categoria text       not null default 'modelo'  -- 'modelo' | 'manual' (Inc 2 aprende de 'manual')
extraido_por    text                          -- 'gemini' | 'claude'
confianca       numeric(4,3)                  -- 0–1
documento_id    uuid        references documentos(id)
criado_em       timestamptz not null default now()
```

### `categorias`

Configuráveis, sementadas da planilha: os 10 `Tipo` → `macro`; e como `sub` **só os
`Gasto` recorrentes** (≥ `MIN_OCORRENCIAS`, default 3). Gastos de ocorrência única (ex.
"Cama nova", "TV Nova") não viram subcategoria — o rótulo cru fica preservado em
`descricao` de qualquer forma (ver §10), então nada se perde e a lista de subs nasce limpa.

```sql
id       uuid primary key default gen_random_uuid()
macro    text not null
sub      text                    -- null = a própria macro
natureza text not null default 'despesa'
ativa    boolean not null default true
unique (macro, sub)
```

### `documentos`

```sql
id               uuid primary key default gen_random_uuid()
dropbox_path     text not null
nome_arquivo     text not null
tipo_arquivo     text
hash             text unique      -- dedup: reenviar o mesmo print não duplica
telegram_file_id text
recebido_em      timestamptz not null default now()
```

### Convenções (herdadas do CLAUDE.md da LM Ateliê)
- Dinheiro é `numeric(12,2)`; **toda agregação roda em SQL** (exato) — nada de acumular
  float em JS. Onde o Worker tocar dinheiro, string/centavos + `parseBR`.
- `valor_final` é coluna gerada → "total − reembolso" nunca diverge entre telas.
- Sinal fica por conta de `natureza` nas views; guarda-se magnitude positiva.

### Diferido de propósito
- **Inc 3:** tabela `faturas` + colunas `fatura_id`/`conciliada` em `transacoes` +
  `parcelas` (vem da fatura). Somar coluna nullable depois é indolor.
- **Inc 4/5:** tabelas de metas e regras da cascata PJ. `esfera` já está aqui só pra a
  história importar limpa e não exigir migração.

## 6. Fluxo de captura (imagem)

```
1. Telegram → Worker /telegram
   • confere header X-Telegram-Bot-Api-Secret-Token
   • allowlist de chat_id — falha fechada (lista vazia recusa todos)
2. pega message.photo (maior) ou document-imagem → getFile → baixa os bytes
3. hash do arquivo → consulta documentos
   • já existe? responde "já registrei isso em <data>" e para (dedup)
4. EXTRAÇÃO (ver §7): tenta Gemini Flash; erro/baixa confiança → fallback Claude
   • valida: valor vira Decimal; data real (se faltar no print, usa a data da msg)
5. sobe o original pro Dropbox com nome padronizado (§8) → grava documentos
6. grava transacoes (fonte='imagem', origem_categoria='modelo', extraido_por, confianca)
7. responde no Telegram:
   "✅ R$ 15,50 · 29/08 · Casa › Limpeza · 'Padaria X'
    [ Apagar ]   ·   ajustar categoria no app"
```

- O botão **Apagar** (inline) cobre foto que não é comprovante. É a única edição no
  Telegram; o resto é no app.
- PDF recebido na v1 → resposta educada de "próximo incremento".

## 7. Módulo de extração (`worker/extrair.js`)

Interface trocável: `extrair(imagemBytes, tipoMime, categorias) → { data, valor, descricao,
natureza, macro, sub, confianca, extraido_por }`.

- **A lista de categorias reais vai no prompt**, então o modelo escolhe entre as categorias
  do Caio em vez de inventar rótulo. Sem certeza no nível 2 → `sub` vazio, completado no app.
- Ordem: Gemini Flash (JSON estruturado nativo). Se erro OU `confianca < LIMIAR` → Claude
  (modelo de visão barato, ex. Haiku). O que vier do fallback também é validado.
- **`LIMIAR` é parâmetro de calibração** (default sugerido 0.6), a afinar com comprovantes
  reais. Documentar no código.
- Validação antes de gravar: valor parseável (`parseBR`/Decimal, > 0), data válida, macro
  pertence a `categorias`. Falha de validação → não grava, responde pedindo reenvio.

## 8. Arquivamento no Dropbox (`worker/dropbox.js`)

- OAuth com refresh token (Secret) → access token curto → `/2/files/upload`.
- Caminho: `/Finanças/Comprovantes/AAAA/AAAA-MM/`
- Nome: `AAAA-MM-DD_macro_sub_valor_descricao.ext`
  (ex. `2026-08-29_Casa_Limpeza_15.50_padaria.jpg`), com `descricao` sanitizada
  (sem `/ \ : * ? " < > |`, espaços → `-`).
- O caminho estável **não muda** ao re-classificar; a categoria "verdadeira" vive no banco.
  O nome carrega a categoria só como conveniência de quem folheia a pasta.

## 9. O app (`docs/`)

**Acesso:** um token único (padrão do `acesso.js` da LM Ateliê). Abre a URL com o token →
vira cookie → `/app` e `/api/*` conferem, falham fechado. Sem login, sem conta.

**Técnica:** HTML estático servido pelo Worker + JS vanilla, no espírito de `docs/*.html`
da LM. Gráficos leves (SVG próprio ou lib pequena inline) — sem dependência pesada.

**Tela 1 — Lançamentos:** tabela filtrável por período / macro / natureza / esfera; edição
in-place de macro, sub, valor, reembolso, pessoa, data; apagar; link pro original no
Dropbox. É onde a correção acontece (e a fonte do aprendizado do Inc 2).

**Tela 2 — Resumo** (três painéis):
1. **Gastos por categoria** no período — barras/rosca por macro, drill pro sub.
2. **Evolução mensal** — receita vs despesa por mês + saldo ("guardado") do mês.
3. **Corte reembolso/IR** — gastos dedutíveis (saúde/educação) e reembolsado por ano.

## 10. Importação do histórico (`tools/import_planilha.py`)

Python + openpyxl, uma vez só, lendo `Gastos.xlsx`:

- Conserta mojibake (`Educa��o` → `Educação`) na leitura.
- Mapeia: `Tipo→macro` · `ValorTotal→valor_total` · `ValorReembolso→valor_reembolso` ·
  `Data→data`. O `Gasto` cru vai **sempre** pra `descricao`; e vira `sub` **só quando é
  recorrente** (≥ `MIN_OCORRENCIAS`, default 3) — senão `sub` fica nulo (o rótulo continua
  em `descricao`).
- `natureza`: `Tipo='Receita'→receita`, senão `despesa` (cruzando com o sinal do ValorFinal
  pra detectar inconsistência).
- `esfera`: `Tipo='Empresa'→empresa`, senão `pessoal`.
- `fonte='importacao'`, `documento_id` nulo.
- Semeia `categorias`: todos os macros, e como sub só os `Gasto` recorrentes
  (≥ `MIN_OCORRENCIAS`); o Caio poda/mescla no app depois. `MIN_OCORRENCIAS` é parâmetro.
- **Idempotente:** re-rodar substitui só as linhas `fonte='importacao'`, nunca duplica.
- **Relatório de import** ao final (contagens por macro, linhas ambíguas de natureza/valor)
  — nada silencioso, no espírito do "diga o que errou / não invente placeholder".

## 11. Segurança

- **Secrets do wrangler** (nunca no código/repo): token do bot, allowlist de chat_id
  (**como Secret, não Text** — `deploy` sobrescreve Text, lição da LM), chaves Gemini e
  Claude, connection string do Neon, refresh token do Dropbox.
- App atrás de token, falha fechada; allowlist do bot falha fechada (lista vazia recusa).
- `.gitignore` cobre `dados/`, `*.xlsx`, `*.csv` e qualquer dump com dado financeiro.
- `descricao`/`pessoa` podem conter nome próprio (dado do Caio, usuário único) — aceitável;
  não se guarda telefone/endereço/CEP.

## 12. Testes (espelhando a LM, sem rede)

- **Python:** o mapeamento do import (Tipo→macro, natureza, esfera, mojibake, idempotência).
- **Worker (`test-worker.mjs`):** allowlist falha-fechada; dedup por hash; validação do JSON
  extraído (valor/data/categoria); casamento com categorias reais; nome do arquivo Dropbox;
  formatação da confirmação; fallback aciona quando confiança < limiar.

## 13. Roadmap dos incrementos (contexto — não faz parte desta spec)

| # | Incremento | Entrega |
|---|---|---|
| 1 | **Captura + ver** (esta spec) | imagem → extrai → grava + Dropbox → app lista/resumo; importa histórico. |
| 1.5 | Lançamento manual | texto (`"15,50 padaria 29/08"`) via Claude, validado. |
| 2 | Classificador que aprende | app grava correções; sistema passa a acertar (regras/exemplos, não ML pesado). |
| 3 | Extrato + fatura | PDF → parsing → transações; amarra item↔fatura; conciliação (não contar 2×). |
| 4 | Planejamento | metas por categoria/mês + meta de guardar; realizado vs alvo. |
| 5 | Camada PJ | receita empresa → despesas empresa → salário → despesas casa, em cascata. |
| 6 | Plus | investimentos; estrutura/nome fino do Dropbox. |

## 14. Riscos e questões em aberto

- **Limiar de confiança** do fallback: chute inicial 0.6, calibrar com comprovantes reais.
- **IDs de modelo** (Gemini Flash x.y; Claude visão barato): fixar na implementação, buscando
  o mais barato que leia comprovante bem.
- **Qualidade da sugestão de categoria** na v1 depende do prompt + lista de categorias; a
  inteligência real vem no Inc 2. Meta v1: acertar a macro na maioria; sub pode vir vazio.
- **Ambiguidade PJ vs pessoal** no histórico (ex.: "Salário" de cliente é receita pessoal ou
  da empresa?) fica resolvida no Inc 5; na v1, `esfera='empresa'` só onde `Tipo='Empresa'`.
- **Export de investimentos** (Inc 6): formato ainda a investigar pelo Caio.
