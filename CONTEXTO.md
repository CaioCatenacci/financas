# Contexto — decisões do brainstorming (Incremento 1)

Este arquivo registra **por que** as decisões arquiteturais foram tomadas,
para evitar re-litigação depois. Leia antes de questionar.

---

## 1. Imagem-primeiro (95% do fluxo)

**Decisão:** a v1 recebe **só foto/print de comprovante** no Telegram.
Texto manual (`"15,50 padaria 29/08"`) vira fast-follow (Inc 1.5).
PDF de extrato/fatura fica pra Incremento 3.

**Por que:** os últimos 2 anos de histórico do Caio mostram ~95% imagem — foto
do comprovante pix/transferência no WhatsApp, mandada pro Telegram.
Texto é raro, e PDF de extrato nem vai entrar na v1.
**Começar simples** (só o modo dominante) significa código menor, testes mais limpos,
e entrega mais rápida.

Se depois virar 40% texto, é painless adicionar — a rota `/telegram` já tem lugar
pra nova lógica. Mas agora o caminho feliz é foto.

---

## 2. Um Worker só (divergindo da LM Ateliê propositalmente)

**Decisão:** um único Cloudflare Worker faz webhook + app + API.

**Por que:** a LM Ateliê tem múltiplos Workers (bot separado de app) porque é
ferramenta comercial — permite versionamento independente, scaling separado.
Financas é ferramenta pessoal de um usuário.
Simplicidade vence: um deploy, um .env, uma verdade. O Caio não precisa escalar
o bot separado do app.

---

## 3. Gemini Flash padrão + fallback Claude (modelo trocável)

**Decisão:** `extrair.js` tenta Gemini Flash (JSON estruturado nativo, barato).
Se erro **ou** confiança < LIMIAR (default 0.6) → fallback Claude (modelo visão barato, ex. Haiku).
Interface é trocável: `extrair(bytes, mime, categorias) → JSON normalizado`.

**Por que:** Gemini Flash é mais barato e tem JSON nativo — bom pra maioria.
Claude é fallback quando Gemini falha ou erra (ex: lê valor errado na imagem).
O LIMIAR de confiança é **parâmetro** pra calibrar com comprovantes reais.

Modelos locais (Ollama, LLaMA) foram descartados porque o Worker roda na nuvem
e não alcança localhost — usá-los ressuscitaria a arquitetura server-em-casa→tunnel
que **matou a v1 da LM Ateliê** (Paola nunca conseguiu abrir a URL porque o servidor
de casa vivia fora do ar). Nada disso aqui.

---

## 4. Dropbox: pasta por data, categoria no nome (banco é o índice)

**Decisão:** arquivo sobe pra `/Finanças/Comprovantes/AAAA/AAAA-MM/`
Nome: `AAAA-MM-DD_macro_sub_valor_descricao.ext`
(ex: `2026-08-29_Casa_Limpeza_15.50_padaria.jpg`)

O caminho **não muda** ao re-classificar depois. A categoria "verdadeira" vive no banco.
O nome é só conveniência de quem folheia a pasta.

**Por que:** o Dropbox é arquivo perene + conveniência visual.
Banco é o índice — re-classificar no app muda `transacoes.macro/sub`, mas o
arquivo fica no mesmo lugar. Assim:
- Pessoa curiosa que folheia a pasta vê `Casa_Limpeza` e entende o contexto.
- Ao mesmo tempo, se o Caio acordar achando que "Limpeza" é subcategoria errada,
  edita no app e a transação agora aponta pra `Casa_Manutenção` — sem mover arquivo.
- Se o banco virar inacessível, o Dropbox ainda está lá, nomeado de forma que
  o Caio consegue remontar.

Nada de refatorar caminho com a categoria — dados em movimento.

---

## 5. Dois níveis de categoria + reembolso desde a v1

**Decisão:** `macro` (nível 1) + `sub` (nível 2, opcional).
`valor_reembolso` vira coluna gerada `valor_final = valor_total − reembolso`.
Ambos estão lá desde a v1.

**Por que:** o histórico real do Caio (planilha Excel) **já tem reembolso** —
plano de saúde que reimbursa (ex: dentista) — e **já segrega por tipo** (Saúde,
Educação, Casa, etc.).

Começar com essa estrutura significa:
- Import do histórico fica limpo (não precisa migração depois).
- O app já nasce editável (Caio já usa reembolso; não é feature futura).
- `valor_final` é **gerada** → nunca diverge entre telas.

Sub não é obrigatória (recorrência define — um-offs viram descrição só);
mas macro é sempre.

---

## 6. Importar histórico na v1

**Decisão:** import único da planilha Gastos.xlsx (2022–2026) na v1.

**Por que:** o Caio quer histórico longo pra análise (ver "guardado" ao longo
dos meses, detectar padrões).
Deixar pra depois significaria meses com dado incompleto no app — confuso.
Fazer agora é painless: `python tools/import_planilha.py` com `--idempotente`
(re-rodar substitui só linhas `fonte='importacao'`, nunca duplica).

Relatório de import mostra o que aconteceu (contagens, linhas ambíguas).
Nada silencioso.

---

## 7. Correção no app, não no Telegram

**Decisão:** bot confirma o que leu; **edição só no app.**
Telegram recebe só botão Apagar (foto que não é comprovante).

**Por que:** o Telegram é caixa de entrada; o app é análise + edição.
Separação limpa: bot foca em velocidade de captura;
app foca em precisão/aprendizado.

Essa divisão também prepara bem pro Incremento 2 (classificador que aprende):
as correções vão morar no app, que passará a treinar o modelo.

---

## 8. Modelo de categoria: recorrência define sub

**Decisão:** `sub` (nível 2) só aparece na lista se o `Gasto` é recorrente
(≥ `MIN_OCORRENCIAS`, default 3). Gastos únicos (ex: "Cama nova", "TV Nova")
ficam como `descricao` só, não viram sub.

**Por que:** a lista de categorias do app fica limpa e usável. Um-offs clutter.
Mas nada se perde: o rótulo cru está em `descricao` de qualquer forma.

No app, ao corrigir, o Caio pode criar sub nova se quiser (feature futura).
Mas na v1, import já entrega uma estrutura limpa.

---

## 9. Falha fechada, não aberta

**Decisão:** allowlist do bot **vazia recusa todos**.
App atrás de token.
Secrets nunca em código/repo.

**Por que:** segurança por padrão. Se listar falhar, recusa é a escolha segura.
Se token vazar, reavaliar toda a arquitetura — mas pelo menos vazio é melhor
que "oops, esqueci de ativar a lista".

---

## Não fizemos (por que não faz sentido ainda)

| O que | Por que não | Quando |
|---|---|---|
| Extrato + fatura | PDF parsing é complexo; v1 é imagem. | Incremento 3 |
| Classificador que aprende | Sem histórico de correções, não há o que treinar. | Incremento 2 (usa histórico de edições do app) |
| Conciliação | Depende de Incremento 3 (extrato/fatura). | Incremento 3 |
| Metas / planejamento | Dados não existem ainda. | Incremento 4 |
| PJ em cascata | Estrutura simples pro Caio pessoa física primeiro. | Incremento 5 |
| Investimentos | Escopo separado; dados ainda a coletar. | Incremento 6 |

Cada incremento entrega valor E2E. Nada é plumbing que ficaria inútil sozinho.
