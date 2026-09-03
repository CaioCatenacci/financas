# Incremento 2 — Classificador que aprende (por contraparte)

**Data:** 2026-09-03
**Status:** desenho aprovado no brainstorming, aguardando revisão da spec antes do plano
**Projeto:** `C:\Users\caioc\Caio\financas` (Inc 1 já em produção)

---

## 1. Contexto e problema

Na v1, cada comprovante é lido por um modelo (Gemini→fallback Claude) que **chuta** a
categoria a partir da imagem. Caso real observado: um Pix de R$ 916,00 para
**VIVIANE FERRER BORGATO** (professora de inglês) foi classificado como
*Pessoal › Fatura Cartão de Crédito Itaú* (errado). O Caio corrigiu no app para
*Educação › Inglês Particular*, e o sistema **já gravou** `origem_categoria = 'manual'`.

Ou seja: **a correção já é capturada**. O que falta é (a) uma **chave estável** para
reconhecer "a mesma contraparte" em capturas futuras e (b) o **loop** que aplica o
aprendido. Hoje o `descricao` vem genérico ("Comprovante de Pix") e o destinatário
(nome, chave Pix `+5519995783408`, CPF `***396308**`) **não é guardado** — então não
há como generalizar "Pix para Viviane → Educação › Inglês".

Como as transações recorrentes são para as mesmas pessoas, capturar essa associação
faz o classificador acertar sozinho a partir da segunda vez.

## 2. Decisões do brainstorming

| Tema | Decisão |
|---|---|
| Chave de aprendizado | **Chave Pix/CPF quando o comprovante traz; senão o nome normalizado.** |
| Aplicação na captura | **Auto-aplica** a categoria aprendida (alta confiança), sem depender do chute do modelo; o Caio ainda pode corrigir no app. |
| Modo ensino (bootstrap) | **Ambos** os canais, como parte do Inc 2: teach-command no Telegram (dry-run, sem criar transação) + tool de lote que varre o Dropbox e agrupa por contraparte única. Ver §12. |

## 3. Modelo de dados

### `transacoes` — colunas novas
```sql
contraparte_nome   text          -- destinatário/pagador lido do comprovante
contraparte_chave  text          -- chave Pix / CPF normalizada (null se não houver)
```
E o vocabulário de `origem_categoria` ganha `'regra'`:
```sql
origem_categoria text not null default 'modelo'
  check (origem_categoria in ('modelo','manual','regra'))
```
`'regra'` = categoria veio de uma associação aprendida; `'modelo'` = chute do modelo;
`'manual'` = correção do Caio no app.

### `associacoes` — o conhecimento aprendido
```sql
create table associacoes (
  chave       text not null,          -- chave normalizada (pix/cpf OU nome)
  tipo_chave  text not null check (tipo_chave in ('pix_cpf','nome')),
  macro       text not null,
  sub         text,
  n           integer not null default 1,   -- quantas confirmações reforçaram
  atualizado_em timestamptz not null default now(),
  primary key (chave, tipo_chave)
);
```
- Uma associação por (chave, tipo). Correção repetida faz `upsert` e incrementa `n`.
- Lookup na captura tenta **`pix_cpf` primeiro**, depois **`nome`**.

## 4. Extração (mudança no `extrair.js`)

- O `PROMPT` passa a pedir também `contraparte` (nome do destinatário/pagador) e
  `contraparte_chave` (chave Pix, CPF ou agência/conta se houver; senão null).
- `validarExtracao` repassa os dois campos no `normalizado` (sem validação rígida —
  são opcionais; se o modelo não achar, ficam null).
- **Normalização** (funções puras, testáveis):
  - `normalizarChave(s)`: só dígitos para CPF/telefone; e-mail/aleatória em minúsculas;
    retorna null se vazio.
  - `normalizarNome(s)`: maiúsculas, sem acento, espaços colapsados.

## 5. Aprendizado (a partir das correções)

Quando o Caio corrige macro/sub de uma transação no app (`PATCH /api/transacoes/:id`):
1. `atualizarTransacao` (já é read-modify-write) grava a correção com `origem_categoria='manual'`.
2. **Em seguida**, se a transação tem contraparte, faz `upsert` em `associacoes`:
   - chave/tipo derivados: `pix_cpf` se `contraparte_chave` existe, senão `nome` a partir
     de `normalizarNome(contraparte_nome)`.
   - grava `macro`/`sub` corrigidos, `n = n + 1`, `atualizado_em = now()`.

## 6. Aplicação na captura (o payoff)

No fluxo de captura (`tratarUpdate`), depois da extração e **antes de gravar**:
1. Deriva a chave da contraparte extraída (pix_cpf, senão nome).
2. `buscarAssociacao(chave)` — tenta `pix_cpf`, depois `nome`.
3. Se achou: **sobrescreve** `macro`/`sub` pela regra, `origem_categoria='regra'`,
   confiança alta. Senão: mantém o chute do modelo (`origem_categoria='modelo'`).
4. A confirmação no Telegram indica quando veio de regra aprendida (ex.: "✓ aprendido").

Resultado: o próximo Pix para Viviane entra como *Educação › Inglês Particular* sozinho.

## 7. App

Melhorias na tabela de Lançamentos (entram junto neste incremento):

- **Mostrar a contraparte** (hoje o `descricao` é fraco); ajuda a reconhecer a transação
  e a confiar na regra aprendida.
- **Descrição editável** — vira `<input>` inline com `PATCH descricao`. Requer que
  `atualizarTransacao` (§5) e o handler PATCH passem a aceitar o campo `descricao`
  (hoje não aceitam).
- **Subcategoria = combobox aninhada à categoria** — `<input list=...>` + `<datalist>`
  nativo, populado com as **subs daquela categoria** (autocompleta o que já existe e
  ainda permite digitar uma nova). Ao trocar a categoria, a lista de subs é repopulada.
  As subs por categoria saem do `/api/categorias` (já retorna `{macro, sub}`), agrupadas
  no cliente.
- **Renomear rótulo "Macro" → "Categoria"** na UI (cabeçalho e afins). **Decisão:** muda
  só o rótulo; a coluna no banco continua `macro`/`sub` (renomear a coluna cascatearia em
  schema/queries/extração/import sem ganho). O vocabulário fixo do CLAUDE.md segue
  `macro`/`sub` internamente.
- **Dimensionar a tabela** para não cortar texto — em especial a subcategoria (hoje
  `.edsub` é fixo em 130px e trunca subs longas). Larguras flexíveis; célula de descrição
  e de subcategoria com espaço adequado; valor/data seguem mono à direita sem quebra.
- A edição inline **já dispara** o aprendizado (via o PATCH do §5). Um painel dedicado de
  "regras aprendidas" fica como *nice-to-have* futuro.

## 8. Migração

`migrations/0002_associacoes.sql`: `alter table transacoes add column ...` (contraparte_nome,
contraparte_chave); recria o check de `origem_categoria`; `create table associacoes`.
Aplicada no Neon no checkpoint de deploy. Idempotente onde der (`if not exists`).

## 9. Testes

- Puros (node): `normalizarChave`, `normalizarNome`, derivação de chave/tipo, a decisão
  de aplicar regra (associação + contraparte → categoria), e `subsPorCategoria(cats)`
  (agrupa `/api/categorias` por macro → lista de subs, para o combobox).
- `db.test`: `upsertAssociacao` (insert e incremento de `n`), `buscarAssociacao`
  (prioridade pix_cpf > nome), `inserirTransacao` gravando contraparte, `atualizarTransacao`
  aceitando `descricao`.
- `extrair`: o `normalizado` carrega contraparte/chave; regra aplicada sobrepõe o modelo.
- Integração leve: PATCH de categoria gera associação; captura seguinte auto-aplica.

## 10. Fora de escopo / diferido

- **Retroativo (resolvido pelo §12):** a transação da Viviane já corrigida não tem
  contraparte guardada. Em vez de bootstrap manual, o **modo ensino (§12)** semeia as
  regras a partir dos comprovantes guardados no Dropbox — ensina o passado sem esperar
  novas capturas.
- Painel de "regras aprendidas" (ver/editar/remover associações) — nice-to-have futuro.
- Aprendizado por outros sinais além da contraparte (valor recorrente, descrição) — depois.
- **Gemini não estar vencendo** as leituras (hoje o Claude carrega tudo): investigação
  separada, fora deste incremento (não bloqueia).

## 11. Riscos

- **Nome como chave** confunde homônimos e varia (acentos/abreviações) → por isso a chave
  Pix/CPF tem prioridade e o nome é só reserva, normalizado.
- **Auto-aplicar** pode propagar um erro se a 1ª correção foi equivocada; mitigado porque
  o Caio revê no app e uma nova correção atualiza a regra (`upsert`).
- Comprovantes sem chave nem nome legível não aprendem — aceitável (raro).

## 12. Modo ensino (bootstrap do classificador) — parte do Inc 2

Objetivo: ensinar as associações **sem esperar novos gastos**, aproveitando que o Caio
guarda quase todos os comprovantes. Dois canais, ambos escrevem em `associacoes`:

### 12a. Teach-command no Telegram (incremental)
- O Caio manda um comprovante **com legenda de comando**:
  `/aprender <Categoria> > <Subcategoria>` (o `>` separa; sub opcional).
- O bot **extrai a contraparte** (mesmo pipeline), valida a Categoria contra as categorias
  reais, e faz `upsert` em `associacoes` — **dry-run: NÃO cria transação** (evita duplicar
  com o histórico importado). Responde: `✓ aprendido: <contraparte> → Categoria › Sub (n=N)`.
- Requer `parseUpdate` capturar `message.caption`; um ramo "teach" antes do fluxo normal.

### 12b. Lote pelo Dropbox (ensina o passado de uma vez)
Dois passos (padrão dos tools, com relatório — como o `import_planilha`):
1. `tools/ensino_extrair.py <pasta>`: varre os comprovantes do Dropbox, extrai a contraparte
   de cada um (Gemini), **agrupa por contraparte única** (chave normalizada), anexa o palpite
   de categoria do modelo, e escreve `contrapartes.csv` (uma linha por contraparte:
   chave, tipo, nome, n_ocorrencias, sugestao_macro, sugestao_sub).
2. O Caio **revê/edita** o CSV (confirma a categoria de cada contraparte — uma vez por pessoa).
3. `tools/ensino_aplicar.py contrapartes.csv`: `upsert` de todas as associações confirmadas.
- Assim o Caio rotula ~contrapartes únicas (poucas dezenas), não milhares de comprovantes.
- Reaproveita `contraparte.js`/normalização (via port em Python ou chamando a mesma lógica);
  a normalização de chave/nome tem de **casar** com a do worker pra o lookup bater.

### Notas
- Ambos são **aditivos** ao núcleo do Inc 2 (dependem de contraparte + `associacoes`); entram
  como tasks finais do plano.
- O lote custa chamadas Gemini (1 por comprovante) — barato com `gemini-flash-latest`.
- Segurança: os CSVs de contraparte contêm nome/chave de terceiros → `contrapartes*.csv`
  entra no `.gitignore` (o `*.csv` já está coberto).
