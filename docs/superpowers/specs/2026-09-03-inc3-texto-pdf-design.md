# Incremento 3 — Bloco 1: lançamento por texto + PDF de comprovante

**Data:** 2026-09-03
**Status:** desenho aprovado na conversa → vira plano
**Projeto:** `C:\Users\caioc\Caio\financas` (Inc 1, 2 e 2.5 em produção)

---

## 1. Contexto e problema

A captura hoje é **imagem-apenas** via Telegram. O bot recusa texto (`ev.tipo === "texto"`)
e PDF (`ev.tipo === "pdf"`) com "em breve". Este bloco entrega as duas entradas menores e de
baixo risco antes do bloco grande (extrato/fatura + conciliação, que é multi-transação):

- **Texto simples:** mandar `15,50 padaria /Casa 29/08` pro bot e virar 1 transação.
- **PDF de comprovante único:** mandar um recibo em PDF (não foto) e virar 1 transação, pela
  mesma máquina da imagem.

Multi-transação (extrato bancário, fatura de cartão com muitas linhas) **está fora deste
bloco** — é o próximo, com spec próprio.

## 2. Decisões

| Tema | Decisão |
|---|---|
| Canal do texto | **Telegram, texto livre** (mesmo inbox das fotos). |
| Interpretação do texto | **Claude** (chamada texto, sem imagem) extrai valor/data/natureza/descrição. |
| Categoria no texto | O **Caio marca** a categoria no texto; o Claude casa contra o catálogo real. **Sem marcação → Outros.** Nunca inferir categoria pela descrição. |
| `origem_categoria` do texto | `manual` (a categoria veio do usuário, não do modelo). |
| `fonte` do texto | `manual`. Sem documento/Dropbox (não há arquivo). |
| PDF de comprovante | Tratado como **1 comprovante** pela máquina da imagem (dedup, Dropbox, extração, ids). |
| `fonte` do PDF | **`imagem`** (não poluir o vocabulário fixo; um recibo PDF é "imagem-like"). |
| Multi-transação | **Fora de escopo** (próximo bloco). Se um extrato/fatura vier aqui, lê como 1 transação. |

## 3. Capacidade A — texto simples

Fluxo em `tratarUpdate` (branch `ev.tipo === "texto"`, hoje um stub):

1. `parseUpdate` já entrega o texto. Passa por um extrator de texto novo (`worker/texto.js`).
2. **`worker/texto.js`** (extração via Claude, injetável p/ teste):
   - `extrairTexto(texto, catalogoLista, { callClaudeTexto })` → `{ ok, normalizado?, erros? }`.
   - `normalizado`: `{ dataISO, valorCents, natureza, macro, sub, descricao }` — `macro/sub` são
     **nomes** (ou null), resolvidos a id depois. `valorCents` via `parseBRtoCents` (money.js).
   - Regras do prompt: extrair valor e data (`dd/mm` → ano atual; sem data → hoje, em ISO);
     `natureza` = despesa por padrão, receita se o texto indicar; `descricao` = o texto limpo;
     **categoria só se o Caio nomear uma da lista fornecida** (tolera espaço/acento/erro leve),
     senão `macro=null`. Confiança/limiar como no de imagem.
3. `index.js` resolve `resolverCategoria(macro, sub, catalogo)` (fallback Outros), grava
   `inserirTransacao({ ..., fonte:'manual', origem_categoria:'manual' })`. Sem documento.
4. Confirmação igual à da foto (com botão apagar). Se `valorCents` não sair → responde pedindo
   reenvio com um exemplo (`"ex.: 15,50 padaria /Casa 29/08"`).

**Puro/testável:** um parser determinístico dos "pedaços óbvios" pode pré-extrair valor/data
por regex antes do Claude? Decisão: **não** — deixa o Claude fazer tudo (menos brittle p/
texto livre em pt-BR); o que é puro e testado é a montagem do prompt e o `parseBRtoCents`.
`extrairTexto` é testado com `callClaudeTexto` fake (entrada→saída), sem rede.

## 4. Capacidade B — PDF de comprovante único

Branch `ev.tipo === "pdf"` (hoje stub) passa a reusar o fluxo da imagem:

1. `deps.baixar(fileId)` traz `{ bytes, mime='application/pdf' }`.
2. **Viabilidade (1º passo, spike):** confirmar que `callGeminiHTTP`/`callClaudeHTTP` aceitam
   `mime='application/pdf'` direto (Gemini `inline_data`, Claude `document`/`image` block).
   - Se **sim**: `extrair(bytes, 'application/pdf', catalogoLista, deps)` como hoje.
   - Se **não** (algum dos dois recusar PDF): converter a **1ª página** do PDF em imagem antes
     de chamar aquele provedor. Registrar a decisão no plano conforme o achado do spike.
3. Resto idêntico à imagem: dedup por hash, `subirDropbox`, resolve ids, `inserirTransacao`
   (`fonte:'imagem'`), confirmação. `nomeArquivo` ganha `ext='pdf'`.

## 5. Backend / código afetado

- **`worker/index.js`:** trocar os stubs de `texto` e `pdf` pelos fluxos acima; o `texto` usa o
  novo `deps.extrairTextoImpl`; o `pdf` reusa `deps.extrairImpl` + `deps.subir`.
- **`worker/texto.js`** (novo): `extrairTexto` + montagem de prompt + `callClaudeTextoHTTP`
  (chamada real, fora do fluxo puro). Espelha o estilo de `extrair.js`.
- **`worker/extrair.js`:** aceitar `application/pdf` (passar o mime nos blocos Gemini/Claude);
  fallback de conversão só se o spike exigir.
- **`worker/dropbox_nome.js`:** já aceita `ext`; garantir `pdf`.
- **Vocabulário:** inalterado (`fonte` segue `imagem|manual|extrato|fatura|importacao`).

## 6. Testes

- Puros: `extrairTexto` com `callClaudeTexto` fake — casos: valor+data+categoria marcada →
  ids; sem categoria → macro null (→ Outros no index); data omitida → hoje; receita; valor
  ilegível → `ok:false`. `parseBRtoCents` já coberto.
- `index.js` (fakes): branch texto grava `fonte='manual'`/`origem_categoria='manual'` e resolve
  categoria; branch pdf reusa o fluxo de imagem (dedup, Dropbox, insert) com `fonte='imagem'`.
- Spike do PDF: teste de fumaça manual (controller) com 1 PDF real de recibo no deploy.

## 7. Fora de escopo / riscos

- **Fora:** extrato/fatura multi-transação + conciliação (próximo bloco); formulário de
  lançamento no app web; edição de lançamento por texto.
- **Risco (texto ambíguo):** datas/valores mal formatados → o Claude erra. Mitigado por mensagem
  de erro com exemplo e pela edição fácil no app.
- **Risco (PDF multi-página/extrato mandado aqui):** lido como 1 transação. Mitigado por escopo
  declarado; detecção "isto parece extrato" fica pro próximo bloco.
- **Risco (provedor recusa PDF):** coberto pelo spike + fallback de conversão da 1ª página.
