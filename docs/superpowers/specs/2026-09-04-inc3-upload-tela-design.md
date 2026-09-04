# Incremento 3 — Bloco 3: upload de extrato/fatura no app, com tela de revisão

**Data:** 2026-09-04
**Status:** rascunho (spec começado sob limite de quota; **confirmar a decisão central §3 no início da próxima sessão** antes de virar plano)
**Projeto:** `C:\Users\caioc\Caio\financas`

---

## 1. Contexto e problema

O bloco 2 entregou a ingestão de extrato/fatura por **ferramenta local no terminal**
(`python -m tools.importar_extrato ...`). O Caio disse claramente que **isso não o atende** —
ele quer **subir os PDFs pelo app**, ver um **preview/checagem na própria tela** e só então
**aplicar**. Este bloco move a ingestão do terminal para o app web, reusando toda a lógica já
validada (parse, checksum, reconciliação, não-gasto, aprendizado por descritor).

## 2. O que já existe (reusar, não reinventar)

Lógica pura já validada em Python (`tools/`): `extrato_itau.parse_extrato`+`conferir_checksum`,
`fatura_itau.parse_fatura`, `classificar_linha` (descritor/não-gasto/associação), `reconciliar`
(`linha_hash`+match valor+data±3d). Modelo de dados já pronto (0006): `computa_resumo`,
`linha_hash`, categorias org. Resumos já filtram `computa_resumo`. **A regra é portar essa
lógica, não redesenhá-la.**

## 3. Decisão central (CONFIRMAR antes de planejar)

**O PDF não pode ser parseado no Worker (Cloudflare):** não há pypdf/lib de PDF prática lá.
Então onde extrair o texto do PDF?

- **(a) Extrair no browser + parsear no Worker (recomendado):** o app usa **pdf.js** (CDN
  permitido) pra extrair o texto do PDF (inclusive "modo layout" p/ a fatura de 2 colunas) e
  faz `POST /api/importar/preview { tipo, texto, meta }`. O Worker roda os parsers/checksum/
  classificação/reconciliação **em JS** (portados de `tools/`), devolve o preview. O PDF em si
  **não** sai do browser (não sobe pro servidor/Dropbox) — só o texto extraído. Menos dado
  sensível trafegando, e o Worker nunca precisa de lib de PDF.
- **(b) Subir o PDF pro Worker e extrair lá:** exige uma lib de PDF em JS rodando no Worker
  (unpdf) — mais pesado, e o Worker passa a lidar com bytes de PDF. Não recomendado.

Consequência de (a): **portar `tools/extrato_itau|fatura_itau|classificar_linha|reconciliar`
para `worker/*.js`**, com testes espelhados (as fixtures/casos do pytest viram `node --test`).
Os `tools/*.py` continuam existindo (o CLI ainda funciona).

## 4. Fluxo (tela nova "Importar")

1. Aba **"Importar"** no app (ao lado de Resumo/Lançamentos/Ajustes).
2. Caio escolhe **tipo** (extrato / fatura), o **arquivo** (drag&drop) e, p/ fatura, ano+mês; p/
   extrato, a conta (ou detecta do cabeçalho).
3. Browser extrai o texto (pdf.js) → `POST /api/importar/preview`.
4. Worker: parse + **checksum** (não fecha → devolve erro, não deixa aplicar) + classifica +
   reconcilia contra o banco → devolve **preview** agrupado: **novos** (n, soma), **casados**
   (n), **não-gasto** (n, soma), **ambíguos** (lista), **checksum** (ok/diferença).
5. **Tela de revisão:** Caio vê os grupos; pode **resolver ambíguos** (casar com uma transação
   existente sugerida, ou marcar como novo), **ajustar categoria/pessoa** de linhas novas, e
   **marcar/desmarcar não-gasto**. (v1 pode ser enxuta: mostrar os grupos + resolver ambíguos +
   confirmar; o ajuste fino de categoria segue em Lançamentos como hoje.)
6. **Aplicar:** `POST /api/importar/aplicar { ... }` grava (novos + não-gasto inseridos por id;
   casados carimbam `linha_hash`; idempotente por `linha_hash`). Confirmação com contagens.

## 5. Backend / código

- **`worker/` (portes puros):** `extrato.js`, `fatura.js`, `classificar.js`, `reconciliar.js`
  espelhando os `tools/*.py` (mesma lógica, testes em `node --test`).
- **`worker/db.js`:** `catalogo`/`buscarAssociacao` já existem; add consultas de apoio
  (`transacoesNaJanela(de,ate)` só `linha_hash is null` p/ reconciliar; `hashesNaJanela`).
  `inserirTransacao` já grava por id + `computa_resumo`/`linha_hash`.
- **`worker/index.js` + /api:** `POST /api/importar/preview` (texto→preview, sem gravar) e
  `POST /api/importar/aplicar` (grava a decisão revisada). Ambos atrás do token.
- **`public/`:** aba "Importar", upload + pdf.js (CDN) + a tela de revisão; nova função pura de
  montagem do preview/estado testável.

## 6. Escopo / fases

- **Fase 1 — portes + endpoints:** portar os 4 módulos p/ JS (com testes), `/api/importar/preview`
  e `/aplicar`, sem UI (testado por `node --test` + curl). É a espinha.
- **Fase 2 — tela:** aba Importar + pdf.js + preview + aplicar + resolver ambíguos.

## 7. Fora de escopo / riscos

- **Fora:** outros bancos (só Itaú); guardar o PDF (só o texto é usado).
- **Risco (paridade do porte):** o JS tem que bater com o Python já validado → **testes
  espelhados** (mesmas fixtures) + o checksum como rede.
- **Risco (pdf.js no browser):** tamanho do extrato (6 meses/9 páginas) e o "modo layout" da
  fatura — validar que o pdf.js extrai o texto tão bem quanto o pypdf (pode exigir montar as
  linhas por posição/coordenada). É o ponto técnico a provar cedo na Fase 1.
- **Risco (reconciliação/ambíguos na tela):** a UX de casar ambíguo manualmente é nova — manter
  v1 simples (sugestão + aceitar/rejeitar), refinar depois.
