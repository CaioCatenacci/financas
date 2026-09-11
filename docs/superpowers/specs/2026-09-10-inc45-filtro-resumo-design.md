# Incremento 4.5 — Filtro único de mês + Resumo por mês fechado

**Data:** 2026-09-10
**Status:** desenho aprovado na conversa → vira plano
**Projeto:** `C:\Users\caioc\Caio\financas` (Inc 1–4 em produção; Inc 4 = planejamento)

---

## 1. Contexto e problema

O Inc 4 entregou o planejamento (alvo por categoria/mês). Ao usar ao vivo, três coisas
ficaram claras:

1. O filtro de tempo por presets (mês atual / mês passado / ano / 12m / tudo) não faz sentido
   para as telas de análise agora que o eixo natural virou **um mês fechado por vez** — é o
   mês que tem orçamento pra comparar. O seletor de mês único (que a aba Planejamento já usa)
   é mais prático e deveria valer em todas as telas.
2. A grade do Planejamento começava num mês fixo (junho), sem ano, e ignorava o filtro do topo.
3. Os gráficos do Resumo foram desenhados para janelas longas (evolução de 12 meses); com o mês
   fechado como unidade, vários deles mudam de forma — e falta um gráfico que mostre
   **orçamento × realizado** de relance.

Este incremento unifica o filtro e redesenha o Resumo em cima do modelo "mês fechado". Não
mexe no modelo de dados (metas/transações) — é UI + agregação.

## 2. Decisões (aprovadas na conversa)

| Tema | Decisão |
|---|---|
| Filtro global | Um seletor único **mês/ano** (`<input type="month">`) no topo, estado `estado.mes` (`'YYYY-MM'`). Some o filtro de presets e `periodoRange`. Trocar de mês re-renderiza a aba ativa. |
| Lançamentos | Mês único por padrão **+ um atalho "Todos os meses"** (chip) que carrega tudo, para reclassificar em massa. Ligado, ignora o mês. |
| Resumo / Planejamento | Sempre um mês fechado (o do seletor). |
| Grade do Planejamento | Começa no **mês selecionado** e vai **12 meses à frente** (rola na horizontal pro que não couber); colunas rotuladas **com o ano**; **cores por célula** por estouro (verde/amarelo/vermelho via `statusMeta`) nos meses corridos/corrente, neutro no futuro. |
| Evolução mensal | Vira **curva diária acumulada + linha de orçamento (pace)**: gasto acumulado ao longo dos dias do mês vs. a reta de 0 até o orçamento total do mês. No mês corrente, a linha real para em hoje. |
| Dumbbell (categoria × mês anterior) | Mantém, **ancorado no mês selecionado** vs. o anterior (meses fechados). |
| Waterfall | Mantém. |
| Categoria | Vira **sunburst** (anel interno = categoria, externo = subcategoria), com **clique para focar** uma categoria (expande as subs dela; clique no centro volta). |
| Pessoa | Vira **rosca (donut)** — troca a barra atual, ocupa menos espaço, total no centro. |
| Bullet por categoria (novo) | Bloco de **espaço maior**: uma linha por categoria de despesa — barra = realizado, marcador vertical = **orçamento do mês**, cor da barra por estouro. Painel-título de acompanhamento; dado de `/api/metas?mes=`. |
| Papéis | O bullet (Resumo) é para **ver**; a tabela do mês (aba Planejamento) continua para **editar** os alvos. |
| Escopo negativo | Nenhuma coluna/tabela nova; sem drill profundo além do foco-1-nível no sunburst. |

## 3. Faseamento

Para não deixar o Resumo quebrado no meio da transição:

- **Fase 1 — filtro único + Planejamento + Lançamentos.** O seletor novo; a grade respeita o
  filtro (12 meses à frente, ano nos rótulos, cores por célula); Lançamentos vira mês único +
  "Todos os meses". **O Resumo mantém o filtro de presets por ora** (estado transitório: as
  telas de análise novas usam o seletor de mês, o Resumo ainda usa os presets até a Fase 2).
- **Fase 2 — Resumo por mês fechado.** Redesenho dos gráficos (curva diária, dumbbell ancorado,
  waterfall, sunburst, pessoa donut, bullet) e **remoção do filtro de presets** (aí nada mais
  depende dele; o Resumo passa ao seletor de mês global).

## 4. Estado e filtro (front)

- `estado.mes` = `'YYYY-MM'` (default: mês corrente). Substitui `estado.periodo`.
- `estado.lancTudo` = boolean (Lançamentos: "Todos os meses" ligado?).
- Helper puro novo em `app.js`: `rangeDoMes(mes) -> { de:'YYYY-MM-01', ateExcl:'YYYY-MM-01'(mês+1) }`
  (meio-aberto, coerente com o backend). Substitui `periodoRange`.
- `carregar()` passa a usar `rangeDoMes(estado.mes)` para o Resumo (Fase 2) e Lançamentos.
  Lançamentos com `estado.lancTudo` busca sem filtro de data (janela ampla, como o "tudo" atual).

## 5. API (agregação)

Fase 2 (Resumo). Sem rota nova de metas — o Resumo passa a buscar **dois** endpoints já
existentes/estendidos: `/api/resumo?mes=` e `/api/metas?mes=`.

- `GET /api/resumo?mes=YYYY-MM` (aceitar `mes`; manter `de`/`ate` como fallback compatível):
  internamente calcula o range do mês e devolve:
  - `kpis` (do mês) — como hoje.
  - `porCategoria` (do mês; já traz `macro` + `sub`) — alimenta o **sunburst**.
  - `porPessoa` (do mês) — alimenta a **rosca**.
  - `diario` **(novo)**: `[{ dia:'YYYY-MM-DD', total_cents }]` — soma de despesa (`computa_resumo`)
    por dia do mês. Alimenta a **curva diária**.
  - `mesVsAnterior` **(ancorado no mês)**: despesa por categoria no mês selecionado vs. o anterior.
    Alimenta o **dumbbell**.
  - (`mensal` sai — a evolução multi-mês deixa de existir no Resumo.)
- `worker/db.js`:
  - `resumoDiario(de, ateExcl) -> [{ dia, total_cents }]` (novo; `natureza='despesa'`,
    `computa_resumo`, `(round(sum(valor_final)*100))::bigint`, **`Number()` na borda**).
  - `resumoMesVsAnterior(mesRef)` — parametrizar pelo mês selecionado (hoje ancora em `max(data)`).
- O **orçamento total do mês** (reta de pace) e o **bullet** vêm de `GET /api/metas?mes=` (já existe:
  `total.alvo_cents` e `linhas[].{alvo_cents, realizado_cents, status}`).

**Convenção de dinheiro:** toda coluna `::bigint` nova é convertida com `Number()` na borda do
`db.js` (o bug do Inc 4 foi exatamente esquecer isso; os acumuladores `+` concatenam string). Os
testes devem exercitar um fake que devolve string.

## 6. UI (front)

### Fase 1
- **Topo:** trocar o bloco `.period` (index.html) por um seletor de mês compartilhado. Na Fase 1,
  o Resumo ainda mostra os presets (mantidos temporariamente); o seletor de mês governa
  Planejamento e Lançamentos.
- **Planejamento — grade:** `renderGrade()` passa a ancorar em `estado.mes` (12 meses a partir
  dele), rótulos com ano (ex.: `jun/26`), e cada célula recebe classe de status
  (`.status-normal/.aviso/.estouro`) calculada por `statusMeta(realizado, alvo)` nos meses
  `<=` corrente; futuro neutro. A tela do mês do Planejamento também segue `estado.mes`.
- **Lançamentos:** usa `estado.mes`; adicionar chip **"Todos os meses"** (liga `estado.lancTudo`).

### Fase 2
- **Topo:** remover os presets; o seletor de mês passa a valer também no Resumo.
- **Resumo** (renderers em `app.js`, contêineres em `index.html`):
  - `drawDiario()` (novo, substitui `drawEvo`): linha de gasto acumulado por dia + reta de pace
    (0 → orçamento total do mês). Real para em hoje no mês corrente.
  - `drawDumbbell()` — mantém, lendo `mesVsAnterior` ancorado.
  - `drawWaterfall()` — mantém.
  - `drawSunburst()` (novo, substitui `drawDonut`): dois anéis (categoria / subcategoria); subs
    são tons da cor da categoria; hover com valor/%; **clique numa categoria foca** (as subs dela
    preenchem o anel externo; clique no centro reseta).
  - `drawPessoaDonut()` (novo, substitui `drawPessoa`): rosca de despesa por pessoa, total no centro.
  - `drawBullet()` (novo): bloco largo; por categoria de despesa, barra = realizado, marcador =
    orçamento, cor por `status`; ordenado por % consumido desc.
- SVG inline no estilo dos gráficos atuais (sem libs externas), tema claro/escuro via as
  variáveis CSS já usadas.

## 7. Testes

- **Puros (`app.js`, `public/app.test.mjs`):**
  - `rangeDoMes('2026-09')` → `{de:'2026-09-01', ateExcl:'2026-10-01'}` (vira o ano em dezembro).
  - `acumularDiario(diario, diasDoMes)` (helper novo p/ a curva) → série acumulada correta,
    parando em hoje quando o mês é o corrente.
  - `paceOrcamento(totalCents, diasDoMes)` → reta linear (0 no dia 1, total no último dia).
  - manter/adaptar `agruparPorPessoa`/`construirWaterfall` (reusados pela rosca/waterfall).
- **`worker/db.test.mjs`:** `resumoDiario` (SQL: despesa+computa_resumo, agrupado por dia, `_cents`
  numérico — teste com fake devolvendo **string**); `resumoMesVsAnterior(mesRef)` (ancora no mês
  passado, não em `max(data)`).
- **`worker/index.test.mjs`:** `/api/resumo?mes=` devolve `diario` e `mesVsAnterior` do mês certo.
- Front (sunburst/bullet/rosca/curva): verificação manual no navegador (sem harness E2E), com a
  lógica testável empurrada para os helpers puros acima.

## 8. Fora de escopo

- Modelo de dados (metas/transações) — nada muda.
- Meta/orçamento de receita; recorte por pessoa no orçamento.
- Drill multi-nível no sunburst (só foco de 1 nível: categoria → suas subs).
- Exportação/print dos gráficos.
