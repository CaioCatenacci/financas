# Incremento 3 — Bloco 2: ingestão de extrato + fatura (Itaú), com reconciliação

**Data:** 2026-09-04
**Status:** desenho aprovado na conversa → vira plano
**Projeto:** `C:\Users\caioc\Caio\financas` (Inc 1, 2, 2.5 e Inc 3 bloco 1 em produção)

---

## 1. Contexto e problema

Hoje o ledger é alimentado por **fotos/texto** (comprovantes avulsos) — cobertura parcial e
manual. O extrato bancário (Itaú, ~6 meses por PDF) e a fatura do cartão (Itaú, mensal) trazem
o registro **completo**. O desafio não é ler o PDF — é **integrar sem duplicar**: o extrato
contém pix que já foram fotografados e o pagamento da fatura (cujos itens vêm da própria
fatura), além de muita linha que **não é gasto** (transferências entre contas próprias,
aplicações/investimentos).

## 2. Decisões (aprovadas na conversa)

| Tema | Decisão |
|---|---|
| Papel do extrato | **Espinha dorsal** do ledger: tudo é reconciliado contra ele; nada entra em dobro. |
| Linhas não-gasto | Transferências internas, aplicações/investimentos e o pagamento da fatura → **reconhecidas e marcadas**, fora do Resumo. |
| Mecanismo do "não-gasto" | **Flag `computa_resumo` boolean** (fonte da verdade; os resumos filtram) **+ categorias** "Transferências"/"Investimentos" como complemento de organização. |
| Parsing | **Determinístico do texto** (pypdf), por banco (Itaú), **+ checksum** (soma bate com a variação de saldo / total da fatura). |
| Ingestão | **Ferramenta local** (`tools/`, padrão `import_planilha`) com **preview p/ aprovar** antes de gravar. |
| Fatura × extrato | Os **itens da fatura** são os gastos (`fonte=fatura`); a **linha de pagamento** no extrato é marcada não-gasto. |
| Reconciliação | Casa linha do extrato ↔ transação já capturada por **valor exato + data em janela de ±3 dias**; casou → mantém a existente, marca conciliada, não duplica; ambíguo → preview. |
| Categoria (aprende) | Cada linha guarda o **descritor do estabelecimento como `contraparte_nome`** (data-sufixo removida), `contraparte_chave` null. No import, `buscarAssociacao` pelo descritor normalizado → categoria; senão **Outros**. Reclassificar no app dispara o **mesmo** `upsertAssociacao` (Inc 2) → o próximo import já vem certo. Objetivo: saber onde o dinheiro é gasto, com o app aprendendo os descritores recorrentes. |
| Idempotência | Cada linha ganha **chave estável** (`linha_hash`); reimportar / meses sobrepostos não duplicam. |
| Canal | Só o **bloco 1** (comprovante avulso) usa o bot; o lote (extrato/fatura) é a ferramenta local. |

## 3. Formato dos PDFs (Itaú, verificado nos exemplos)

**Extrato** (`extrato conta / lançamentos`): linhas `DD/MM/AAAA <descrição> <valor>`, com coluna
saldo à direita. Valor negativo = saída (despesa), positivo = entrada (receita). Linhas
`SALDO DO DIA` são marcadores → **ignorar**. Cabeçalho traz agência/conta e período. 9 páginas p/
6 meses no exemplo.

**Fatura** (`Lançamentos: compras e saques`): seção por cartão (`final XXXX`) e por titular;
linhas `DD/MM <estabelecimento> <valor>` (ano vem do período/vencimento da fatura). Rodapé traz
`Total dos lançamentos atuais`. Parcelas aparecem no texto do estabelecimento (`PARCELA x/y`).

## 4. Modelo de dados (migração 0006, aditiva)

```sql
-- flag que decide se a transação entra nos cálculos do Resumo (default: entra)
alter table transacoes add column computa_resumo boolean not null default true;
-- chave estável da linha de extrato/fatura p/ idempotência e reconciliação
alter table transacoes add column linha_hash text;
create unique index if not exists idx_transacoes_linha_hash on transacoes (linha_hash)
  where linha_hash is not null;
-- categorias de organização p/ o não-gasto (a flag é que exclui do Resumo; a categoria é rótulo)
insert into categorias (nome, natureza) values ('Transferências','despesa'), ('Investimentos','despesa')
  on conflict (nome) do nothing;
```

- `computa_resumo=false` nas linhas não-gasto (transferência interna, aplicação/investimento,
  pagamento de fatura). **Todos os resumos** ganham `and t.computa_resumo` no WHERE.
- `linha_hash` = hash estável de `banco|conta|data|descricao|valor|ordinal_no_dia`. Unique parcial
  (só quando não-nulo, pra não colidir com as transações de foto/texto que têm hash nulo).
- Na **reconciliação**, quando uma linha do extrato casa uma transação existente (foto/texto), a
  existente recebe o `linha_hash` da linha (fica "lastreada" no extrato e imune a reimport), sem
  criar linha nova.

## 5. Componentes / código

### tools (Python, local — puro no parsing, testável)
- **`tools/extrato_itau.py`** (puro): `parse_extrato(texto) -> [{data, descricao, valor_cents, natureza}]`
  + `checksum(linhas, saldos)`; ignora `SALDO DO DIA`. Testável por string.
- **`tools/fatura_itau.py`** (puro): `parse_fatura(texto) -> [{data, estabelecimento, valor_cents, parcela?}]`
  + total; ano do período. Testável por string.
- **`tools/classificar_linha.py`** (puro): dado `descricao`/`valor`:
  - **descritor:** `normalizar_descritor(descricao)` — remove o sufixo de data (`…30/12`), prefixos
    de meio (`PIX QRS`/`PIX TRANSF`/`PAG BOLETO`/`DA `), números soltos, colapsa espaços — p/ que
    o **mesmo estabelecimento colapse na mesma chave** entre meses (ex.: `PIX QRS AMAZON.COM.30/12`
    e `…28/11` → `amazon com`). Esse descritor vira `contraparte_nome` da transação.
  - **categoria:** `buscarAssociacao(normalizarNome(descritor), 'nome')` → categoria/sub; senão
    `Outros`. Reusa `tools/contraparte.py` + `tools/categorias.py`. Como o descritor é gravado em
    `contraparte_nome`, **corrigir no app aprende pela via existente** (Inc 2) e o próximo import
    já classifica sozinho.
  - **não-gasto:** lista de padrões editável (`PIX TRANSF <nomes próprios>`, `APLICACAO`,
    `PERSONDIF`, `COR COMP CDB`, `PERS BLACK`, pagamento de cartão, etc.) → `computa_resumo=false`
    + categoria organizacional.
- **`tools/importar_extrato.py`** / **`tools/importar_fatura.py`** (I/O): lê PDF (pypdf), chama o
  parser, reconcilia contra o banco, monta o **preview** (novos / casados / não-gasto / checksum),
  pede confirmação, grava por id (`fonte='extrato'|'fatura'`, `computa_resumo`, `linha_hash`,
  `categoria_id`/`subcategoria_id` via resolução, `pessoa_id` null).

### worker (mínimo)
- **`worker/db.js`:** todos os `resumo*` ganham `and t.computa_resumo` (o corte por pessoa/categoria/
  KPIs/mensal/mês-vs-anterior/reembolso passam a ignorar o não-gasto). Sem mudança de assinatura.
- **`schema.sql`:** reflete `computa_resumo` + `linha_hash` + as 2 categorias.
- **UI (app):** opcional/menor — mostrar um selo "fora do resumo" na tabela de Lançamentos e um
  filtro "só não-gasto"; **fora do escopo mínimo** deste bloco (pode virar fast-follow).

## 6. Reconciliação (o núcleo)

1. Parse + checksum. Falhou o checksum → **aborta** e mostra a diferença (regra: conta que não
   fecha não é usada).
2. Para cada linha do extrato (que não é `SALDO DO DIA`):
   - **não-gasto?** (padrões) → marca `computa_resumo=false`, categoria organizacional.
   - **casa transação existente?** valor exato + `abs(data_extrato - data_tx) <= 3 dias` e ainda
     não conciliada. **1 candidato** → concilia (seta `linha_hash` na existente, não duplica).
     **>1 candidato** ou nenhum claro → vai pro preview como "ambíguo" p/ você decidir.
   - **linha_hash já existe?** → pula (reimport idempotente).
   - senão → **nova**: resolve categoria (associações → Outros), `fonte='extrato'`.
3. Preview agrupado: **novos** (n, soma), **casados** (n), **não-gasto** (n, soma), **ambíguos**
   (lista p/ decidir), **checksum** (ok/diferença). Confirma → grava.

## 7. Faseamento (um spec, duas fases)

- **Fase 1 — Extrato:** migração 0006 + `resumo*` com `computa_resumo` + `extrato_itau.py` +
  `classificar_linha.py` + `importar_extrato.py` (parse, checksum, não-gasto, reconciliação vs
  fotos, preview, inserção). É a espinha.
- **Fase 2 — Fatura:** `fatura_itau.py` + `importar_fatura.py` (itens `fonte=fatura`, parcelas) +
  marcar o pagamento correspondente no extrato como não-gasto. Reusa preview/classificação.

## 8. Testes

- Puros (pytest): `parse_extrato`/`parse_fatura` com amostras reais (fixtures de texto), incl.
  `SALDO DO DIA` ignorado, valor negativo/positivo, milhar+centavos, parcela `x/y`; `checksum`
  (bate / não bate); reconhecimento de não-gasto (cada padrão); reconciliação (casa 1, ambíguo,
  nenhum, janela de ±3 dias); `linha_hash` estável e idempotente; `normalizar_descritor`
  (mesmo estabelecimento em meses diferentes → mesma chave; data-sufixo/prefixo removidos).
- db (fakeSql): `resumo*` incluem `computa_resumo` no WHERE.
- Integração (manual/controller): rodar os 2 PDFs de exemplo, conferir preview + checksum.

## 9. Fora de escopo / riscos

- **Fora:** outros bancos (só Itaú agora); UI de revisão no app (a revisão é no terminal/preview);
  investimentos como classe de ativo (Inc 6); esfera empresa (Inc 5).
- **Risco (formato Itaú muda):** o parser é por-banco; o checksum é a rede que denuncia parse
  quebrado antes de gravar.
- **Risco (reconciliação erra):** janela de ±3 dias pode casar errado 2 gastos de mesmo valor;
  mitigado por mandar ambíguos pro preview (nunca auto-concilia com >1 candidato).
- **Risco (não-gasto mal reconhecido):** um gasto real classificado como transferência sai do
  Resumo; mitigado por os padrões serem conservadores + visível no preview + editável no app.
- **Risco (descritor):** normalizar de menos → o mesmo estabelecimento não colapsa (aprende
  várias vezes); de mais → estabelecimentos distintos colidem numa categoria. Mitigado por
  começar conservador (só remove data-sufixo/prefixos conhecidos) e por você corrigir no app
  (o aprendizado é por descritor, então ajusta rápido). Testes fixam casos recorrentes reais.
- **Risco (chave de reconciliação):** `linha_hash` com `ordinal_no_dia` depende da ordem estável
  do PDF; reimport do mesmo arquivo é estável, mas dois arquivos com a mesma linha precisam do
  mesmo ordinal — o parse deriva o ordinal da ordem de aparição no dia.
