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
`pessoa_id` pelo nome). A Fase B (categorias FK + genericização + tela de gestão) é
separada e não roda sem aprovação do mapa de genericização.

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
npm test                                      # Worker + app (node --test auto-discovery)
python -m pytest tests/                       # import e mapeamento
```

O CI (`.github/workflows/ci.yml`) roda os dois.

---

## Roadmap dos incrementos

| # | Incremento | O que faz | Status |
|---|---|---|---|
| 1 | **Captura + ver** | imagem → extrai → grava + Dropbox → app lista/resumo; importa histórico | implementação |
| 1.5 | Lançamento manual | texto (`"15,50 padaria 29/08"`) via Claude, validado | *fast-follow* |
| 2 | Classificador que aprende | app grava correções; sistema passa a acertar | implementado |
| 3 | Extrato + fatura | PDF → parsing → transações; conciliação | Incremento 3 |
| 4 | Planejamento | metas/realizado vs alvo | Incremento 4 |
| 5 | Camada PJ | receita empresa → cascata → despesas casa | Incremento 5 |
| 6 | Plus | investimentos; estrutura fina Dropbox | Incremento 6 |

A v1 (Incremento 1) é **imagem-apenas**. Texto e PDF voltam depois.
