# Incremento 4 — Planejamento orçamentário (alvo por categoria vs realizado)

**Data:** 2026-09-10
**Status:** desenho aprovado na conversa → vira plano
**Projeto:** `C:\Users\caioc\Caio\financas` (Inc 1, 2, 2.5 e Inc 3 em produção)

---

## 1. Contexto e problema

O ledger já registra o **realizado** com boa cobertura (comprovante, texto, extrato, fatura) e o
Resumo já soma gasto por categoria e por mês (`resumoPorCategoria`/`resumoMensal` em `worker/db.js`,
sobre `valor_final` filtrado por `computa_resumo`). O que falta é o **plano**: um **valor alvo por
categoria, mês a mês**, para comparar contra o gasto real e enxergar onde estourou.

O requisito que molda tudo é temporal: o alvo precisa poder ser **alterado num mês pontual** (sem
afetar os outros) **ou em toda a sequência futura** (a partir de um mês, daí pra frente).

Este é o Incremento 4 do roadmap ("Metas / planejamento", antes adiado porque "dados não existiam
ainda" — agora existem). Entrega valor E2E: nada aqui é plumbing que ficaria inútil sozinho.

## 2. Decisões (aprovadas na conversa)

| Tema | Decisão |
|---|---|
| Modelo temporal | **Baseline com vigência + exceção por mês.** Um alvo-base "vale a partir do mês X" e propaga pra frente até um baseline mais novo; uma exceção sobrepõe **só aquele mês** e não propaga. Meses passados ficam congelados no baseline que valia então → histórico do plano preservado, sem materializar linhas futuras nem precisar de horizonte. |
| Granularidade | Alvo por **Categoria (macro)**, não por subcategoria — mantém a superfície de planejamento enxuta. |
| Natureza | Só **despesa** (teto de gasto). Meta de receita fica de fora deste incremento. |
| Recorte | Sem pessoa/esfera — o alvo é por categoria, ponto. |
| Onde resolver "qual alvo vale" | **JS puro** (`worker/metas.js`, no estilo `money.js`/`extrair.js`: sem banco, sem rede). O SQL busca os dados crus (baselines, exceções, realizado); a precedência `exceção > baseline > sem-alvo` roda em JS testável. ~15 categorias/mês → sem questão de performance, e auditável quando o número parecer errado. |
| Dinheiro | Guardado `numeric(12,2)` (reais), igual a `transacoes.valor_total`; a API fala **centavos**, convertendo na borda (`centsToNumeric`). Alvo e realizado na mesma unidade, comparação em SQL exato — coerente com a convenção do projeto. |
| Mês | Normalizado como `date` dia-01 do mês; casa com `to_char(data,'YYYY-MM')` que o resumo já usa. |
| Semear alvos | **Sugestão pela média do realizado dos 3 meses anteriores** ao mês, por categoria (editável). Prefill do campo + "sugerir pra todas". |
| "Sugerir pra todas" | **Pré-preenche** os campos ainda vazios; o Caio **confirma** antes de gravar. Nada escrito silenciosamente. |
| Visão | **Duas**, mês como principal: tela do **mês** (acompanhamento) + **grade** categorias × meses (planejar a sequência). |
| Faseamento | **Fase A — mês** (fatia E2E completa, deployável sozinha) → **Fase B — grade** (aditiva, sem tocar na Fase A). |

## 3. Modelo de dados

Migração **aditiva** `migrations/0007_metas.sql`. Duas tabelas, uma por propósito.

```sql
-- baseline: "a partir deste mês, o alvo desta categoria é V" (propaga pra frente
-- até um baseline mais novo). Alterar toda a sequência futura = inserir baseline no mês atual.
create table metas (
  categoria_id  uuid not null references categorias(id),
  vigente_desde date not null,                    -- sempre dia 01 do mês
  valor_alvo    numeric(12,2) not null check (valor_alvo >= 0),
  criado_em     timestamptz not null default now(),
  primary key (categoria_id, vigente_desde)
);

-- exceção: "só neste mês o alvo é V" (NÃO propaga). Alterar um mês pontual.
create table metas_excecao (
  categoria_id uuid not null references categorias(id),
  mes          date not null,                     -- sempre dia 01 do mês
  valor_alvo   numeric(12,2) not null check (valor_alvo >= 0),
  criado_em    timestamptz not null default now(),
  primary key (categoria_id, mes)
);
```

Sem coluna nova em `transacoes`. O realizado continua vindo das transações via os mesmos filtros do
Resumo (`computa_resumo`, `natureza='despesa'`, `valor_final`).

## 4. Resolução do alvo efetivo (`worker/metas.js`, puro)

Interface pura, tudo por parâmetro (auditável):

```
alvoEfetivo(baselines, excecoes, categoriaId, mesISO) -> { valorCents, origem }
  origem: 'excecao' se há exceção(cat, mes)
          'baseline' se há baseline com vigente_desde <= mes (o mais recente)
          'sem-alvo'  caso contrário  (valorCents = null)
```

- `baselines`: linhas `{ categoria_id, vigente_desde, valor_alvo }` (todas; a função escolhe a vigente).
- `excecoes`: linhas `{ categoria_id, mes, valor_alvo }`.
- Precedência: **exceção > baseline mais recente ≤ mês > sem-alvo.**
- Meses passados resolvem sozinhos para o baseline que valia então (nenhum estado materializado).

Também puro, para o semear:

```
mediaSugestao(realizadoPorMes, mesISO, janela=3) -> valorCents
  média (arredondada em centavos) do realizado dos `janela` meses ANTERIORES a `mesISO`;
  meses sem dado contam como 0 no denominador? Não: média sobre os meses presentes na janela
  (se nenhum mês tem dado → sugestão null / campo vazio).
```

`db.js` fornece os dados crus; `metas.js` resolve célula a célula, tanto para a tela do mês quanto
para cada mês da grade.

## 5. API

Rotas novas em `worker/index.js`, atrás do token como todo `/api/*`. Centavos na borda; as de
escrita normalizam `YYYY-MM` → `date` dia-01 e validam (`valor_cents >= 0`, `categoria_id` existe).

**Leitura**

- `GET /api/metas?mes=YYYY-MM` — tela do mês. Uma linha por categoria de despesa:
  ```json
  { "mes": "2026-09",
    "linhas": [
      { "categoria_id": "…", "categoria": "Casa",
        "alvo_cents": 150000, "realizado_cents": 132090,
        "origem": "baseline", "diff_cents": 17910 }
    ],
    "total": { "alvo_cents": 0, "realizado_cents": 0, "diff_cents": 0 } }
  ```
  `origem ∈ 'excecao' | 'baseline' | 'sem-alvo'`; categoria sem alvo vem `alvo_cents: null` (mostra só
  realizado). `diff = alvo − realizado` (negativo = estourou). O total soma só categorias com alvo.

- `GET /api/metas/grade?de=YYYY-MM&ate=YYYY-MM` — grade. Categorias × meses da janela; cada célula com
  `alvo_cents` (+ `origem`) e `realizado_cents` (preenchido nos meses corridos/corrente, `null` no
  futuro). Default de janela quando `de`/`ate` ausentes: **3 meses passados + mês corrente + 8 à
  frente** (12 colunas), navegável.

- `GET /api/metas/sugestao?mes=YYYY-MM` — média do realizado dos 3 meses anteriores, por categoria:
  `{ categoria_id, sugestao_cents }[]`. Alimenta prefill e "sugerir pra todas".

**Escrita**

- `PUT /api/metas` — body `{ categoria_id, mes: "YYYY-MM", valor_cents, escopo }`:
  - `escopo: 'baseline'` → upsert `metas (categoria_id, vigente_desde = mes-01)`. "Deste mês em diante."
  - `escopo: 'excecao'` → upsert `metas_excecao (categoria_id, mes = mes-01)`. "Só este mês."
- `DELETE /api/metas?categoria_id=…&mes=YYYY-MM&escopo=excecao` — remove a exceção (o mês volta ao baseline).
- `DELETE /api/metas?categoria_id=…&mes=YYYY-MM&escopo=baseline` — remove aquele baseline (o mês passa ao
  baseline anterior, ou fica sem alvo).

`db.js` ganha: `metasBaselines()`, `metasExcecoes()`, `realizadoPorCategoriaMes(de, ate)` (leitura) e
`setBaseline(cat, mesISO, valorNumeric)`, `setExcecao(cat, mesISO, valorNumeric)`,
`apagarExcecao(cat, mesISO)`, `apagarBaseline(cat, mesISO)` (escrita).

## 6. UI — aba "Planejamento"

Aba nova ao lado de Lançamentos / Resumo / Ajustes / Importar (`public/index.html` + `public/app.js`,
padrões atuais).

**Visão principal — mês** (default: mês corrente):
- Seletor de mês.
- Tabela **Categoria | Alvo | Realizado | Falta / Estourou**. Última coluna com barra de progresso
  (realizado/alvo) e %; realizado > alvo → **vermelho**; ≥ 80% do alvo → **amarelo** (aviso); abaixo →
  normal. Selo discreto quando a linha é **exceção** (mês ajustado à mão).
- **Editar o alvo inline.** Ao salvar, um mini-popover pergunta o escopo: **"só este mês"** (exceção)
  ou **"deste mês em diante"** (baseline). O campo já vem preenchido com a sugestão (média 3 meses)
  quando ainda não há alvo.
- Categorias **sem alvo**: mostram realizado + um "definir alvo" (com sugestão prefilada).
- Botão **"Sugerir pra todas"**: pré-preenche os alvos ainda vazios com a média; o Caio revisa e
  confirma; ao confirmar, grava como **baseline** a partir daquele mês.
- Linha de **Total** (soma dos alvos com alvo vs soma do realizado).

**Visão secundária — grade** (categorias × ~12 meses):
- Célula = alvo; realizado sobreposto (menor/cinza) nos meses corridos; futuro mostra só o alvo
  projetado pelo baseline.
- Editar uma célula grava **baseline a partir daquele mês** (gesto natural da grade: "daqui pra
  frente"). A exceção pontual fica na tela do mês.

## 7. Faseamento (respeitando "nada entra sem E2E")

- **Fase A — mês:** `0007_metas.sql` → `db.js` (leitura+escrita) → `metas.js` (resolução+média) →
  `GET /api/metas`, `GET /api/metas/sugestao`, `PUT`/`DELETE /api/metas` → aba com a tela do mês.
  Fatia completa e deployável: define alvo, vê realizado, ajusta pontual ou daí em diante.
- **Fase B — grade:** `GET /api/metas/grade` + a visão secundária. Aditivo, sem tocar na Fase A.

## 8. Testes (padrão do repo, comentários em PT)

- `worker/metas.test.mjs` (puro):
  - precedência exceção > baseline > sem-alvo;
  - baseline propaga pra frente e para no baseline seguinte;
  - exceção não propaga (mês anterior e posterior seguem o baseline);
  - mês passado congelado no baseline de então;
  - `mediaSugestao`: 3 meses cheios; janela com meses faltando; nenhum dado → null.
- Integração em `worker/db.test.mjs` / `worker/index.test.mjs`: upsert de baseline/exceção; resolução da
  tela do mês (alvo/realizado/diff/origem/total); delete de exceção revertendo ao baseline; delete de
  baseline.
- CI já roda `npm test` (Node) e `pytest` (não afetado — sem mudança em `tools/`).

## 9. Fora de escopo (deste incremento)

- Meta de **receita** e recorte por **pessoa/esfera** (o alvo é por categoria de despesa).
- Alvo por **subcategoria**.
- Alertas/notificação de estouro no Telegram (só visual no app por ora).
- Rollover de saldo não-gasto entre meses.
