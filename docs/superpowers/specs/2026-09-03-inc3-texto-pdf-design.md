# Incremento 3 — Bloco 1: lançamento por texto + PDF de comprovante

**Data:** 2026-09-03
**Status:** desenho aprovado na conversa → vira plano
**Projeto:** `C:\Users\caioc\Caio\financas` (Inc 1, 2 e 2.5 em produção)

---

## 1. Contexto e problema

A captura hoje é **imagem-apenas** via Telegram. O bot recusa texto (`ev.tipo === "texto"`)
e PDF (`ev.tipo === "pdf"`) com "em breve". Este bloco entrega as duas entradas menores e de
baixo risco antes do bloco grande (extrato/fatura + conciliação, que é multi-transação):

- **Texto simples:** mandar `padaria 57,50 29/03/2026 pessoa=Caio categoria=Casa` e virar 1 transação.
- **PDF de comprovante único:** mandar um recibo em PDF (não foto) e virar 1 transação, pela
  mesma máquina da imagem.

Multi-transação (extrato bancário, fatura de cartão com muitas linhas) **está fora deste
bloco** — é o próximo, com spec próprio.

## 2. Decisões

| Tema | Decisão |
|---|---|
| Canal do texto | **Telegram**, formato **estruturado** (mesmo inbox das fotos). |
| Formato | `<descrição> <valor> <data> [pessoa=] [categoria=] [subcategoria=] [natureza=]`. Obrigatórios: descrição, valor, data. |
| Interpretação do texto | **Parser determinístico puro** (regex + `parseBRtoCents`), **sem IA**. Instantâneo, previsível, testável. |
| Categoria/pessoa no texto | Vêm dos `chave=valor` opcionais, casados contra catálogo/pessoas por nome. Sem `categoria=` → **Outros**; `pessoa=`/`categoria=`/`subcategoria=` que não existe → ignora (Outros/sem sub/sem pessoa) e **avisa na confirmação**. |
| `origem_categoria` do texto | `manual`. |
| `fonte` do texto | `manual`. Sem documento/Dropbox (não há arquivo). |
| Natureza no texto | `natureza=receita` opcional; padrão **despesa**. |
| PDF de comprovante | Tratado como **1 comprovante** pela máquina da imagem (dedup, Dropbox, extração, ids). |
| `fonte` do PDF | **`imagem`** (não poluir o vocabulário fixo; um recibo PDF é "imagem-like"). |
| Multi-transação | **Fora de escopo** (próximo bloco). Se um extrato/fatura vier aqui, lê como 1 transação. |

## 3. Capacidade A — texto simples (formato estruturado)

Fluxo em `tratarUpdate` (branch `ev.tipo === "texto"`, hoje um stub):

1. `parseUpdate` entrega o texto → `parseLancamentoTexto(texto)` (novo, `worker/texto.js`, **puro**).
2. **`parseLancamentoTexto(texto)`** → `{ ok:true, dados }` ou `{ ok:false, erro }`. `dados`:
   `{ valorCents, dataISO, descricao, pessoa?, categoria?, subcategoria?, natureza }` — `pessoa`/
   `categoria`/`subcategoria` são **nomes** (ou ausentes), resolvidos a id no index.
   - **Pares `chave=valor`:** chaves conhecidas = `pessoa|categoria|subcategoria|natureza`. O
     valor de cada par vai **até o próximo `chave=` conhecido ou o fim** — assim nomes com espaço
     funcionam (`categoria=Plano de saúde`). Case-insensitive na chave.
   - **Parte livre** (tudo antes do 1º `chave=` conhecido): identifica por *forma*, então a ordem
     entre eles é livre — **data** = token no padrão `dd/mm` ou `dd/mm/aaaa` (sem ano → ano atual;
     ISO na saída); **valor** = token que casa formato BR de dinheiro (`parseBRtoCents`);
     **descrição** = o resto, unido por espaço.
   - **Validação:** faltando descrição, valor ou data → `ok:false` com `erro` explicando o formato.
   - `natureza` = `despesa` por padrão; `receita` se `natureza=receita`.
3. `index.js`: resolve `categoria/sub` via `resolverCategoria(nome, catalogo)` (fallback Outros) e
   `pessoa` por nome (lookup em `pessoas`; não achou → null). Grava
   `inserirTransacao({ ..., fonte:'manual', origem_categoria:'manual' })`. Sem documento/Dropbox.
4. **Confirmação** igual à da foto (com botão apagar), incluindo um aviso quando algum
   `chave=valor` não bateu (ex.: `⚠ pessoa "Xuxa" não existe — deixei sem pessoa`).
5. `ok:false` → responde com o formato e um exemplo:
   `"ex.: padaria 57,50 29/03/2026 pessoa=Caio categoria=Casa"`.

**Puro/testável:** `parseLancamentoTexto` não toca rede/banco — testado inteiramente por
entrada→saída. A resolução nome→id (categoria/pessoa) fica no index (com fakes).

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

- **`worker/index.js`:** trocar os stubs de `texto` e `pdf` pelos fluxos acima; o `texto` chama
  `parseLancamentoTexto` + resolve categoria/pessoa por nome; o `pdf` reusa `deps.extrairImpl` +
  `deps.subir`. Precisa de um lookup de pessoa por nome (novo `db.pessoaPorNome(nome)`).
- **`worker/texto.js`** (novo): `parseLancamentoTexto` — **puro** (sem rede/banco/IA).
- **`worker/db.js`:** `pessoaPorNome(nome)` (case-insensitive, só ativas) p/ o texto resolver
  `pessoa=`.
- **`worker/extrair.js`:** aceitar `application/pdf` (passar o mime nos blocos Gemini/Claude);
  fallback de conversão só se o spike exigir.
- **`worker/dropbox_nome.js`:** já aceita `ext`; garantir `pdf`.
- **Vocabulário:** inalterado (`fonte` segue `imagem|manual|extrato|fatura|importacao`).

## 6. Testes

- Puros (`parseLancamentoTexto`): ordem livre na parte livre (valor/data/descrição em qualquer
  ordem); `dd/mm` → ano atual e `dd/mm/aaaa`; `categoria=Plano de saúde` (valor com espaço até o
  próximo `chave=`); `natureza=receita`; múltiplos pares; faltando obrigatório → `ok:false`;
  `pessoa=`/`categoria=` capturados como nomes. `parseBRtoCents` já coberto.
- `index.js` (fakes): branch texto grava `fonte='manual'`/`origem_categoria='manual'`, resolve
  categoria (Outros se não achar) e pessoa (null se não achar), e avisa o não-encontrado na
  confirmação; branch pdf reusa o fluxo de imagem (dedup, Dropbox, insert) com `fonte='imagem'`.
- Spike do PDF: teste de fumaça manual (controller) com 1 PDF real de recibo no deploy.

## 7. Fora de escopo / riscos

- **Fora:** extrato/fatura multi-transação + conciliação (próximo bloco); formulário de
  lançamento no app web; edição de lançamento por texto.
- **Risco (formato):** exige seguir a estrutura (descrição + valor + data + pares). Mitigado por
  mensagem de erro com o formato e um exemplo quando falta obrigatório; edição fácil no app.
- **Risco (ambiguidade na parte livre):** descrição com número que pareça valor, ou data dúbia.
  Mitigado por heurística documentada nos testes (valor = formato BR de dinheiro; data = padrão
  de data) e pela confirmação que ecoa o que foi entendido.
- **Risco (PDF multi-página/extrato mandado aqui):** lido como 1 transação. Mitigado por escopo
  declarado; detecção "isto parece extrato" fica pro próximo bloco.
- **Risco (provedor recusa PDF):** coberto pelo spike + fallback de conversão da 1ª página.
