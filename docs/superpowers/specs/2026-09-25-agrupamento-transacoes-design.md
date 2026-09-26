# Incremento 4.6 — Agrupamento de transações (duplicatas explícitas)

**Data:** 2026-09-25
**Status:** desenho aprovado na conversa → vira plano
**Projeto:** `C:\Users\caioc\Caio\financas` (Inc 1–4.5 em produção; fix da categoria padrão deployado)

---

## 1. Contexto e problema

O Caio lança na mão (Telegram, foto ou texto) o que é importante **no momento em que
acontece**, e no fechamento do mês importa a fatura fechada e o extrato do Itaú. Como só há
uma conta, **quase todo lançamento manual também aparece no extrato**. Hoje a reconciliação
do import trata isso assim:

- Linha do extrato com **valor exato ±3 dias** de um lançamento existente → "casado": o
  sistema **carimba o `linha_hash` no lançamento do Caio** e a linha do banco **não vira
  transação**. A duplicata some, mas a ligação é invisível: nada na tela diz "este lançamento
  foi conferido contra o extrato".
- Valor diferente (ex.: entrada de R$ 56.200 = salário de R$ 36.200 + R$ 20.000 de repasse
  recebido pra transferir à cunhada) → a linha entra como nova, o Caio marca "fora do resumo"
  na mão, e o porquê se perde. Daqui a um ano ninguém sabe por que aquela entrada está fora.

O que se quer: uma **associação explícita e visível** entre a linha do banco e o lançamento
que ela duplica, fácil de localizar, com a garantia de que **só um lado conta** — e que sirva
de memória do que aconteceu.

## 2. Decisões (aprovadas na conversa)

| Tema | Decisão |
|---|---|
| Quem conta | O **lançamento do Caio** é a transação "de verdade"; a linha do extrato fica como evidência ligada, fora do Resumo. (A linha do banco passa a **existir** como transação — hoje é absorvida.) |
| Forma | **Grupo com representante**: linhas com o mesmo `grupo_id`; exatamente um membro é `representante` e só ele conta. Não há entidade "grupo": a linha do grupo na tela **é** o representante. |
| Soma | **Não há regra de soma.** Um grupo é um conjunto de duplicatas, não uma decomposição. Membros com valor diferente do representante geram um **aviso** ("valores diferem"), nunca bloqueio. |
| Salário + repasse | Não é agrupamento, é decomposição — fica **fora** do modelo. O mesmo modelo cobre o caso na prática: agrupar a entrada de R$ 56.200 com o salário (representante) e registrar o porquê na descrição; a saída de R$ 20.000 fica "fora do resumo" como hoje (ou agrupada com um lançamento manual de repasse, se houver). |
| Onde ligar | **Só em Lançamentos**, depois do import. O import segue casando automaticamente valor exato ±3d e passa a gravar o grupo. O preview **não** ganha UI de conciliação. |
| Modelo | Opção 3 da conversa (`grupo_id` compartilhado) + flag `representante`. A opção "tabela própria N:M" foi descartada: nenhum caso pede um lançamento em dois grupos. |
| Histórico | Casamentos antigos (hash carimbado no lançamento, sem linha do extrato) ficam como estão — não há como reconstruir a linha absorvida. |

## 3. Modelo de dados (migração `0009_grupos.sql`, aditiva)

```sql
alter table transacoes add column if not exists grupo_id      uuid;
alter table transacoes add column if not exists representante boolean not null default false;

-- representante sem grupo não existe
alter table transacoes add constraint transacoes_representante_com_grupo
  check (not representante or grupo_id is not null);

-- no máximo UM representante por grupo (o "pelo menos um" é garantido pela API)
create unique index if not exists idx_transacoes_grupo_representante
  on transacoes (grupo_id) where representante;

create index if not exists idx_transacoes_grupo on transacoes (grupo_id) where grupo_id is not null;

-- a regra "quem conta" num lugar só: fora do resumo (flag do usuário) E, se agrupado, só o representante
alter table transacoes add column if not exists conta_no_resumo boolean
  generated always as (computa_resumo and (grupo_id is null or representante)) stored;
```

`computa_resumo` continua sendo a **flag que o Caio controla** ("fora do resumo").
`conta_no_resumo` é a regra efetiva, derivada — **todas as leituras agregadas** (Resumo,
Planejamento/metas, `resumoDiario`, `resumoMesVsAnterior`, `porPessoa`, etc.) trocam
`computa_resumo` por `conta_no_resumo`. É troca de identificador, sem lógica nova.

Vocabulário (CLAUDE.md): `grupo_id` = conjunto de duplicatas; `representante` = membro que
conta e que a tela mostra como a linha do grupo; **membro** = linha com `grupo_id` e
`representante=false`.

## 4. Regras (puras, em `worker/grupos.js`)

Funções puras, dados por parâmetro, no espírito de `metas.js`/`money.js`. Cada uma devolve
`{ ok:true, ... }` ou `{ ok:false, erro }` com mensagem legível (o Worker responde 400 com ela).

1. **`decidirAgrupar(selecionadas)`** — 2 ou mais linhas (cada uma `{id, fonte, criado_em,
   grupo_id, representante}`):
   - nenhuma em grupo → novo `grupo_id` (uuid gerado pelo chamador e passado por parâmetro,
     pra função ficar determinística nos testes); representante = a linha que **não** é
     `fonte='extrato'`/`'fatura'`; havendo várias, a de `criado_em` mais antigo.
   - exatamente um grupo entre as selecionadas → as demais entram nele; o representante
     **não muda**.
   - dois ou mais grupos distintos → `erro: "desagrupe antes: a seleção tem linhas de grupos diferentes"`.
   - menos de 2 linhas → erro.
2. **`decidirRepresentar(membros, novoId)`** — troca atômica: `novoId` vira representante, o
   antigo deixa de ser. `novoId` fora do grupo → erro.
3. **`decidirTirar(membros, id)`** — `id` sai do grupo (`grupo_id=null, representante=false`);
   se era o representante → erro `"escolha outro representante antes de tirar este"`; se sobra
   1 membro → o grupo **dissolve** (o que sobrou também limpa `grupo_id`).
4. **Desagrupar** — limpa `grupo_id`/`representante` de todos; cada linha volta a contar
   sozinha com seu `computa_resumo` como estava.
5. **`podeApagar(membros, id)`** — apagar representante de grupo com outros membros → erro
   (mesma mensagem de 3); apagar membro comum → regra 3 (dissolve se sobrar 1). Vale pro
   `DELETE /api/transacoes/:id` **e** pro botão `del:` do Telegram.
6. **`valoresDiferem(representante, membros)`** — true se algum membro tem `valor_final`
   diferente do representante. Só informa; usada pelo selo na tela.
7. Editar categoria/pessoa/`computa_resumo` na linha do grupo (ou em massa) edita **o
   representante**; membros guardam o que tinham.

## 5. Import do extrato

**Preview inalterado** (`montarPreviewExtrato`): parse → checksum → classifica → reconcilia,
mesmos status (`novo`/`casado`/`ambiguo`/`naoGasto`/`jaTem`).

**Candidatos ao casamento** (`db.transacoesNaJanela`) mudam de "quem não tem hash" para:
`fonte not in ('extrato','fatura') and linha_hash is null` (hash antigo carimbado = já
conciliado no modelo velho) `and not exists (membro do mesmo grupo com fonte='extrato')`
(um lançamento casa com uma linha do banco **uma vez**). Devolve também `grupo_id` da
candidata, que o app precisa pra decidir "entra no grupo existente".

**Aplicar um `casado`** (`montarDecisao`, puro no app; `db.aplicarImportacao`, uma
`sql.transaction`): em vez de carimbar o hash no lançamento do Caio,
1. **insere a linha do extrato** como transação normal (`fonte='extrato'`, `linha_hash`,
   categoria resolvida como um "novo", `computa_resumo=true`, `grupo_id=G`,
   `representante=false`);
2. **põe o lançamento casado no grupo**: se `grupo_id` era null → `grupo_id=G,
   representante=true`; se já tinha grupo → `G` = esse grupo, e nada muda nele (o
   representante fica quem era).

`G` nasce no navegador (`crypto.randomUUID()`), dentro de `montarDecisao`, que passa a
devolver `casados: [{ linha: <row a inserir>, matchId, grupoExistente }]`. O servidor só
grava. `db.carimbarLinhaHash` deixa de ser chamado pelo fluxo do app (fica pro Python).

**Idempotência** segue pelo hash: `hashesNaJanela` continua lendo `linha_hash` de qualquer
linha (novas na linha do extrato; antigas carimbadas no lançamento) → reimport vê `jaTem`.

**Ambíguos**: como hoje ("tratar como novo"; agrupar depois em Lançamentos). **Fatura** e
`marcarPagamentoFaturaNaoGasto`: sem mudança. Mensagem de resultado: "conciliados N" →
"agrupados N".

**Importadores Python** (`tools/importar_extrato.py`, `importar_fatura.py`) **não mudam**:
seguem carimbando o hash (modelo antigo). O app é o caminho oficial; vai pro BACKLOG
"alinhar ou aposentar os importadores Python".

## 6. API (Worker, atrás do token)

| Rota | Corpo | Faz |
|---|---|---|
| `POST /api/grupos` | `{ ids: [...] }` | agrupar (regra 1); devolve `{ grupo_id, representante_id }` |
| `DELETE /api/grupos/:grupo_id` | — | desagrupar (regra 4) |
| `PATCH /api/grupos/:grupo_id` | `{ representante_id }` | trocar representante (regra 2) |
| `DELETE /api/grupos/:grupo_id/membros/:id` | — | tirar membro (regra 3) |

Fluxo de cada rota: `db.membrosDoGrupo`/`db.transacoesPorIds` (leitura) → função pura decide →
`db.gravarGrupo(mudancas)` aplica **numa única `sql.transaction`** (lista de `{id, grupo_id,
representante}`). Erro de regra → `400 {erro}` (helper `erroJson` já existe).

`DELETE /api/transacoes/:id` e o `del:` do Telegram passam por `podeApagar` antes de apagar;
se a exclusão dissolve o grupo, a mesma transação limpa o membro que sobrou.

`GET /api/transacoes` (`listarTransacoes`) passa a devolver `grupo_id`, `representante` e
`conta_no_resumo` (já vem do `t.*`). Membros vêm na lista normal — quem monta grupo é o app.

## 7. UI (Lançamentos)

- **`montarLinhas(rows)`** (puro, `public/app.js`): transforma a lista plana em linhas de
  tabela — transações soltas e grupos `{ representante, membros }` — ordenadas pela data (e
  `criado_em`) do representante. Membros nunca aparecem como linha própria.
- **Linha do grupo** = dados do representante + controle `▸ N` (N membros) + selo "grupo" +
  selo "valores diferem" quando `valoresDiferem`. Clique no controle expande os membros logo
  abaixo, recuados, cada um com seus dados (data, descrição, categoria, valor, fonte). Estado
  expandido é só de tela (`estado.expandidos`, `Set` de `grupo_id`), não persiste.
- **Filtros** (`filtrarTransacoes`): categoria, pessoa, origem, "gasto/fora do resumo" filtram
  pelo representante; **busca por texto** bate se o representante **ou qualquer membro** bater
  (é como se acha uma linha do banco que "sumiu" num grupo). Chip novo **"agrupados"** lista só
  grupos.
- **Ações**: botão **"agrupar"** na barra de seleção múltipla (habilita com ≥2 selecionados;
  selecionar uma linha de grupo seleciona o grupo, e agrupar com ele na seleção faz os outros
  entrarem nele); na linha do grupo, **"desagrupar"** (com `confirm`); em cada membro expandido,
  **"representar"** e **"tirar do grupo"**. Membros **não** têm selects de categoria/pessoa —
  pra editar um, tire-o do grupo ou torne-o representante.
- Edição inline e em massa na linha do grupo agem no representante (é a mesma linha de sempre).
- **Resumo e Planejamento**: nenhum controle novo; só passam a contar por `conta_no_resumo`.

## 8. Testes

- **`worker/grupos.test.mjs`** (puro): novo grupo escolhe representante não-extrato mais
  antigo; seleção com um grupo entra nele sem trocar representante; dois grupos → erro; <2 →
  erro; representar troca atomicamente e recusa id fora do grupo; tirar membro comum; tirar
  representante recusa; dissolve ao sobrar 1; `podeApagar` recusa representante com membros;
  `valoresDiferem` acusa 56.200 vs 36.200 e não acusa iguais.
- **`worker/db.test.mjs`** (`fakeSql`): `gravarGrupo` numa única `sql.transaction`; leituras
  agregadas consultam `conta_no_resumo` (regex em cada query de Resumo/metas); `transacoesNaJanela`
  exclui extrato/fatura/hash antigo/grupo com extrato e devolve `grupo_id`; `aplicarImportacao`
  com casado insere a linha do extrato e atualiza o casado na mesma transação.
- **`worker/index.test.mjs`**: as 4 rotas com `db` falso, erros de regra → 400 legível;
  `DELETE /api/transacoes/:id` e `del:` do Telegram recusam representante com membros.
- **`public/app.test.mjs`**: `montarLinhas` (grupos, ordem, membros fora da lista);
  `filtrarTransacoes` acha grupo por texto de membro e chip "agrupados"; `montarDecisao` gera
  pra cada casado a linha do extrato com `grupo_id` e o `matchId`, reutilizando `grupoExistente`
  quando há.
- **Migração 0009**: aplicada ao vivo e conferida (coluna gerada validada contra uma consulta
  manual **antes** de trocar as leituras).
- **Smoke ao vivo** após deploy: agrupar o salário com a entrada de R$ 56.200 (quando setembro
  for importado), ver "valores diferem", conferir o Resumo, desagrupar (valor dobra),
  reagrupar; importar um extrato com um casado e ver o grupo nascer.

## 9. Faseamento (cada fase deployável sozinha)

- **Fase A — modelo + Lançamentos:** migração 0009, `conta_no_resumo` nas leituras,
  `grupos.js`, rotas, UI de grupo (agrupar/desagrupar/representar/tirar/expandir/filtros).
  Entrega o valor principal (ligar duplicatas na mão e ver que só uma conta) sem tocar no import.
- **Fase B — import grava grupo:** candidatos, `montarDecisao` com linha do extrato +
  `grupo_id`, `aplicarImportacao`. Aditiva por cima da A.

## 10. Fora de escopo

- Sugestão automática de casamento por valor **aproximado** ou descrição (só o exato ±3d de
  hoje). → BACKLOG.
- Decomposição de uma linha do banco em partes com soma obrigatória (o caso salário+repasse
  como *modelo*). Descartado na conversa: o grupo com representante + descrição cobre o uso.
- Um lançamento em dois grupos (tabela N:M).
- Reconstruir os casamentos antigos (hash carimbado) como grupos.
- Alinhar os importadores Python ao modelo novo. → BACKLOG.
- Persistir o estado expandido/colapsado.
