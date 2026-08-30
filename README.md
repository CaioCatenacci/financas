# Financas

Sistema pessoal de captura e análise de comprovantes financeiros com Cloudflare Worker e Neon.

Especificação completa: `docs/superpowers/specs/2026-08-29-captura-comprovantes-design.md`

---

## Pré-requisitos

Antes de começar, você precisa ter:

1. **Bot do Telegram** — criar via BotFather (`/newbot`), obter `TELEGRAM_TOKEN` e `TELEGRAM_SECRET`.
2. **App Dropbox** — criar em `https://www.dropbox.com/developers/apps`, gerar refresh token.
3. **Projeto Neon** — criar em `https://console.neon.tech/`, obter `DATABASE_URL`.
4. **Chaves da API Gemini** — obter em `https://aistudio.google.com/apikey`.
5. **Chaves da API Claude (Anthropic)** — obter em `https://console.anthropic.com/`.
6. **Node.js** e **Python 3.8+** instalados localmente.

---

## Setup

### 1. Configurar os Secrets do wrangler

Cada Secret é configurado via `wrangler secret put`:

```bash
wrangler secret put TELEGRAM_TOKEN           # token do bot (BotFather)
wrangler secret put TELEGRAM_SECRET          # secret_token (webhook)
wrangler secret put ALLOWLIST                # chat IDs permitidos (comma-separated ou JSON)
wrangler secret put GEMINI_KEY               # API key Google Gemini
wrangler secret put CLAUDE_KEY               # API key Anthropic
wrangler secret put DATABASE_URL             # connection string Neon (postgresql://...)
wrangler secret put DROPBOX_REFRESH          # OAuth refresh token
wrangler secret put DROPBOX_APP_KEY          # app key
wrangler secret put DROPBOX_APP_SECRET       # app secret
wrangler secret put APP_TOKEN                # token único do acesso (gerar: ex. `uuidgen`)
```

**Nota:** `ALLOWLIST` **deve ser Secret, não Text** — `wrangler deploy` sobrescreve
variáveis de texto.

### 2. Aplicar o schema do banco

```bash
psql "$DATABASE_URL" -f migrations/0001_init.sql
```

Isso cria as tabelas `transacoes`, `categorias` e `documentos`.

### 3. (Opcional) Importar o histórico da planilha

Se você tiver `Gastos.xlsx`:

```bash
DATABASE_URL=$(wrangler secret view DATABASE_URL) python tools/import_planilha.py "Dropbox/Financas/Gastos.xlsx"
```

Isso importa as linhas (2022–2026) como `fonte='importacao'`.
Relatório mostra contagens e linhas ambíguas.

Para atualizar (ex: corrigir mojibake): re-rodar é idempotente — substitui só
as linhas `fonte='importacao'`, nunca duplica.

---

## Executar

### Testes

```bash
npm test                    # Worker + app (node --test)
python -m pytest tests/      # import + mapeamento
```

O CI roda os dois automaticamente a cada push.

### Dev local

```bash
wrangler dev                # começa o Worker em http://localhost:8787
# Acesse http://localhost:8787/app?token=<APP_TOKEN> no navegador
# Bot de Telegram fica esperando no webhook
```

### Deploy pra produção

```bash
wrangler deploy
```

Após o deploy, registrar o webhook do Telegram:

```bash
curl -X POST https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://seu-worker.workers.dev/telegram",
    "secret_token": "<TELEGRAM_SECRET>"
  }'
```

Substitua `seu-worker` pelo domínio real do seu Worker.

---

## Estrutura do projeto

```
├── CLAUDE.md                        # Instruções pro assistente
├── CONTEXTO.md                      # História das decisões
├── README.md                        # Este arquivo
├── package.json                     # Dependências Node
├── wrangler.toml                    # Config do Cloudflare Worker
│
├── migrations/
│   └── 0001_init.sql               # Schema do Neon
│
├── worker/
│   ├── index.js                    # Worker principal (webhook + app + API)
│   ├── extrair.js                  # Interface de extração (Gemini + fallback)
│   ├── dropbox.js                  # Upload pro Dropbox
│   ├── money.js                    # Utilitários de conversão (centavos)
│   └── test-worker.mjs             # Testes (node --test)
│
├── tools/
│   └── import_planilha.py           # Import do histórico Excel
│
├── tests/
│   └── test_import.py              # Testes do import (pytest)
│
├── docs/
│   ├── index.html                  # App web (Lançamentos + Resumo)
│   └── superpowers/specs/          # Especificação
│
└── .gitignore                       # dados/, *.xlsx, *.csv, .env, __pycache__
```

---

## Fluxo E2E

1. **Captura:** mande foto de comprovante pro bot no Telegram.
2. **Extração:** bot lê a imagem via Gemini/Claude, extrai data/valor/categoria.
3. **Arquivo:** original sobe pro Dropbox em `/Finanças/Comprovantes/AAAA/AAAA-MM/`.
4. **Banco:** transação gravada em Neon com `fonte='imagem'`.
5. **Confirmação:** bot responde no Telegram com o resumo.
6. **Edição:** abra o app, corrija se preciso (categoria, valor, reembolso).
7. **Análise:** Resumo mostra gastos por categoria, evolução mensal, corte reembolso/IR.

---

## Troubleshooting

**"allowlist vazio recusa tudo":** Verifique que `ALLOWLIST` (como Secret) contém seu chat_id.
Teste: `curl -s https://api.telegram.org/bot<TELEGRAM_TOKEN>/getMe`

**"DATABASE_URL inválida":** Use `psql "$DATABASE_URL" -c "SELECT 1"` pra conferir a conexão.

**"Dropbox 401":** Refresh token expirou. Gere um novo no app Dropbox.

**"confiança < limiar, fallback pro Claude":** Verifique que `CLAUDE_KEY` está configurada.

---

## Mais informações

- Leia `CLAUDE.md` pra entender as convenções (dinheiro em centavos, Secrets, etc.).
- Leia `CONTEXTO.md` pra saber por que cada decisão foi tomada.
- Consulte a spec em `docs/superpowers/specs/` pra detalhes do design.
