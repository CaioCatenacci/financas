# Backlog — Financas

Lista única do que ficou pra depois. Antes deste arquivo, o backlog vivia espalhado nas
seções "Fora de escopo / diferido" das specs (`docs/superpowers/specs/`), na tabela "Não
fizemos" do `CONTEXTO.md` e nos "minors deferred" dos ledgers de execução (não versionados).
A partir daqui, **tudo que se decide adiar entra aqui**, com a origem. Quando um item vira
incremento, sai daqui e ganha spec/plan como os outros.

Regra de priorização (a mesma do projeto): dor real no uso diário primeiro; incremento só
entra se entrega valor de ponta a ponta; desconfiar de infraestrutura.

Legenda de prioridade: **P1** = próximo a fazer · **P2** = vale a pena, sem urgência ·
**P3** = só se fizer falta.

---

## Bugs conhecidos

| # | Item | Prioridade | Origem |
|---|---|---|---|
| B1 | **Telegram sem retorno** (texto manual e foto): webhook devolvia 500 porque `Outros` foi renomeada pra `Não Identificado` e o fallback era por nome. **Corrigido no código** (categoria padrão por flag, migração `0008`, try/catch no handler — ver CONTEXTO §15). Pendente: aplicar `0008` no Neon e fazer deploy. | P1 | relato do Caio, 25/09/2026; `wrangler tail` |

## A. Incrementos grandes (roadmap)

| # | Item | Prioridade | Origem |
|---|---|---|---|
| A1 | **Inc 5 — camada PJ:** receita empresa → cascata → despesas casa. Inclui resolver a ambiguidade "Salário de cliente é receita pessoal ou da empresa" (hoje `esfera='empresa'` só onde o import marcou `Tipo='Empresa'`). | P2 | CONTEXTO "Não fizemos"; spec Inc 1 §14 |
| A2 | **Inc 6 — investimentos + estrutura fina do Dropbox.** Formato do export de investimentos ainda a investigar. | P3 | CONTEXTO "Não fizemos"; spec Inc 1 §14 |

## B. Classificador e captura

| # | Item | Prioridade | Origem |
|---|---|---|---|
| B2 | **Painel de regras aprendidas** no app: ver/editar/remover `associacoes`. Hoje só corrige via nova correção ou pelos tools Python. | P2 | spec Inc 2 §10 |
| B3 | **Aprender por outros sinais** além da contraparte (valor recorrente, descrição). | P3 | spec Inc 2 §10 |
| B4 | **Gemini não vence as leituras** — o Claude carrega tudo. Investigar prompt/modelo e **calibrar o limiar 0.6** com comprovantes reais (nunca foi feito). Impacta custo. | P2 | spec Inc 1 §14; spec Inc 2 §10 |
| B5 | **Texto manual — natureza:** salva `despesa` se esquecer `natureza=receita` sob categoria de receita; a confirmação não ecoa a natureza. Minors: `"R$ "` vaza pra descrição; valor só-milhar sem centavos não é reconhecido. | P2 | review final Inc 1.5 |
| B6 | **Regex de data exige zero-padding** na extração (rejeita `5/1/2026`) — revisar se o modelo devolver data fora do padrão. | P3 | ledger Inc 1 |

## C. Importação de extrato/fatura

| # | Item | Prioridade | Origem |
|---|---|---|---|
| C1 | **Outros bancos.** Parser é só Itaú. | P3 | spec Inc 3 §9 |
| C2 | **UX de ambíguos na aba Importar:** única ação é "tratar como novo"; casar manualmente com um candidato ficou pra depois. | P2 | spec upload-tela §7 |
| C3 | **Re-aplicar fatura não é idempotente** na marcação do pagamento no extrato (só os inserts deduplicam por `linha_hash`). | P3 | ledger Inc 3 |
| C4 | **Guardar o PDF original** (hoje só o texto é usado). | P3 | spec upload-tela §7 |
| C5 | **Sugestão de casamento aproximado** no import (valor próximo/descrição), além do exato ±3d. | P3 | spec agrupamento §10 |
| C6 | **Alinhar ou aposentar os importadores Python** (`importar_extrato.py`/`importar_fatura.py`): seguem no modelo antigo (hash carimbado), o app grava grupos. | P3 | spec agrupamento §5 |

## D. Planejamento e Resumo

| # | Item | Prioridade | Origem |
|---|---|---|---|
| D1 | **Meta de receita** e recorte de orçamento por pessoa/esfera. | P3 | spec Inc 4 §9; spec Inc 4.5 §8 |
| D2 | **Alvo por subcategoria.** | P3 | spec Inc 4 §9 |
| D3 | **Alerta de estouro no Telegram** (hoje só visual no app). | P2 | spec Inc 4 §9 |
| D4 | **Rollover de saldo não gasto** entre meses. | P3 | spec Inc 4 §9 |
| D5 | **Comparação entre períodos longos** (ano vs ano, 12 meses) — saiu com os presets no Inc 4.5. | P3 | CONTEXTO §14 |
| D6 | **Drill multi-nível no sunburst** e **exportar/imprimir gráficos.** | P3 | spec Inc 4.5 §8 |

## E. Dívida técnica e higiene

| # | Item | Prioridade | Origem |
|---|---|---|---|
| E1 | **Teste servido como asset público:** `public/app.test.mjs` vai no deploy. Mover pra fora de `public/` (há worktree com essa mudança pendente) e ajustar o `npm test`. | P2 | ledger Inc 3 |
| E2 | **XSS via `innerHTML`** em descrição/labels do app. Fonte confiável + token único, mas ficou "triar no review final" e nunca foi. | P3 | ledger Inc 1 |
| E3 | **Sem cross-check `categoria.natureza` × `transacao.natureza`** ao gravar. | P3 | ledger Inc 1.5 |
| E4 | **Docs desatualizados:** roadmap em `CLAUDE.md` (1.5 e 3 já entregues), estrutura no `README.md` (`docs/index.html`, `test-worker.mjs`), `CLAUDE.md` sem seção do Inc 3. | P2 | análise 25/09/2026 |
| E5 | **Branch `redesign-dashboard`** existe sem commits — decidir se vira algo ou apagar. | P3 | análise 25/09/2026 |
| E6 | **Sem logs persistidos no Worker** (`[observability]` desligado no `wrangler.toml`) — um erro só aparece se alguém estiver com `wrangler tail` aberto na hora. | P2 | investigação do B1 |

## F. Grupos (Inc 4.6) — residuais do review final

| # | Item | Prioridade | Origem |
|---|---|---|---|
| F1 | **Grupo da Fase A com foto + manual de mesmo valor** deixa a linha do extrato `ambíguo` no import (dois candidatos). Colapsar candidatos que compartilham `grupo_id` casaria direto no grupo. | P3 | review final Inc 4.6 |
| F2 | **Aplicar depois de preview velho** pode deixar a linha do extrato num grupo sem representante (guard `grupo_id is null` não pega; grupo dissolvido no meio). Único usuário, improvável; `decidirAgrupar` também não checa que o grupo existente tem representante. | P3 | review final Inc 4.6 |
| F3 | **Entrada malformada nas rotas de grupo vira 500** (id não-uuid no cast `::uuid[]`, `ids` não-array). O app sempre manda uuid válido; validar e responder 400. | P3 | review final Inc 4.6 |
| F4 | **Membros órfãos** (representante fora do período) renderizam com controles de edição completos; o toggle "fora do resumo" neles não afeta o Resumo. | P3 | review final Inc 4.6 |
| F5 | **Teste do predicado de candidatos** (`transacoesNaJanela`) é só regex no SQL; a rota de tirar membro não testa "id de outro grupo" (mesmo caminho de `decidirTirar`). | P3 | review final Inc 4.6 |
| F6 | **Edição em massa / PATCH em id de membro** pela API (UI não expõe): efeito é só o aprendizado por descrição de extrato. Decidir se restringe. | P3 | review final Inc 4.6 |
