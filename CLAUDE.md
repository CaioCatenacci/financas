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
- `costing.py` / `extrair.js` são **puros**: sem banco, sem rede, sem I/O. Tudo entra
  por parâmetro. Torna auditável quando o número parece errado.
- Comentários e testes **em português**, explicando o *porquê*, não o *quê*.
- No JS, `parseBRtoCents()` sempre: teclado brasileiro entrega vírgula/ponto. Campo
  de número usa `type="text"` + `inputmode="decimal"`.

---

## Vocabulário fixo das colunas

**Estas combinações têm significado semântico preciso. Não inveniar novos valores.**

| Campo | Valores válidos | Significado |
|---|---|---|
| `natureza` | `despesa` \| `receita` | direção do fluxo |
| `esfera` | `pessoal` \| `empresa` | (empresa é Incremento 5) |
| `fonte` | `imagem` \| `manual` \| `extrato` \| `fatura` \| `importacao` | onde veio / como entrou |
| `origem_categoria` | `modelo` \| `manual` | quem sugeriu a categoria |
| `extraido_por` | `gemini` \| `claude` | qual modelo leu o comprovante |

Valores são **minúsculos, sem espaço, sem acentuação**. Validação no Worker.

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
| 2 | Classificador que aprende | app grava correções; sistema passa a acertar | Incremento 2 |
| 3 | Extrato + fatura | PDF → parsing → transações; conciliação | Incremento 3 |
| 4 | Planejamento | metas/realizado vs alvo | Incremento 4 |
| 5 | Camada PJ | receita empresa → cascata → despesas casa | Incremento 5 |
| 6 | Plus | investimentos; estrutura fina Dropbox | Incremento 6 |

A v1 (Incremento 1) é **imagem-apenas**. Texto e PDF voltam depois.
