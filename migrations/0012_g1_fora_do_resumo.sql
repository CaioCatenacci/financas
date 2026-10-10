-- 0012 (G1): tira do resumo o que não é gasto nem receita de verdade, agora que a receita do mês é
-- o salário alocado por competência (worker/salario.js). Dados; idempotente; critério no arquivo
-- (nunca lista de ids); sem nome de pessoa (o repositório é público) — as linhas com nome próprio
-- (PIX TRANSF <Caio> no Itaú, Pix recebido de <PJ> no C6) saem por arquivo local de dados/, com
-- `python tools/db.py aplicar`, junto com a carga da Nomad (dados/g1_carga_nomad.sql).
--
-- Contagens conferidas no banco em 2026-10-10 (ensaio deve mostrar o mesmo):
--   (a) APLICACAO/RESGATE de extrato que ainda contam: 17 (16 receitas + 1 despesa, 2025-09 a 2026-05)
--   (b) Pix recebido de OURIBANK%: 12 (2025-10-10 a 2026-01-20)
--   (c) TED da Caixa (receita, extrato): 2 — as duas viram Receita › Outros; só a de 2025-12-08
--       (herança) sai do resumo; a de 2025-08-29 (restituição/FGTS) continua contando
--   (d) Receita › Salário da planilha (fonte importacao) entre 2025-04-01 e 2025-10-31: 7
--   (e) lançamentos manuais de salário em 2026-09: 2 (uma sem sub Salário — por isso o critério é
--       a descrição, não a subcategoria)
--
-- Idempotente: cada update só pega linha que ainda conta (conta_no_resumo) ou que ainda está na
-- categoria antiga; rodar de novo não pega nada. As categorias entram por subselect; se alguma
-- não existir, coalesce mantém a atual (nunca null: categoria_id é not null).

-- (a) aplicação e resgate são movimento de investimento: fora do resumo, categoria Investimentos
update transacoes
   set computa_resumo = false,
       categoria_id = coalesce((select id from categorias where nome = 'Investimentos'), categoria_id),
       subcategoria_id = case when (select id from categorias where nome = 'Investimentos') is null then subcategoria_id else null end
 where fonte = 'extrato'
   and descricao ~* 'APLICACAO|RESGATE'
   and conta_no_resumo;

-- (b) chegada da Nomad pelo Ouribank no C6: transferência entre contas próprias
update transacoes
   set computa_resumo = false,
       categoria_id = coalesce((select id from categorias where nome = 'Transferências'), categoria_id),
       subcategoria_id = case when (select id from categorias where nome = 'Transferências') is null then subcategoria_id else null end
 where fonte = 'extrato'
   and natureza = 'receita'
   and descricao ilike 'Pix recebido de OURIBANK%'
   and conta_no_resumo;

-- (c) as duas TEDs da Caixa: Receita › Outros (hoje em Não Identificado)
update transacoes
   set categoria_id = (select id from categorias where nome = 'Receita'),
       subcategoria_id = (select s.id from subcategorias s join categorias c on c.id = s.categoria_id
                           where c.nome = 'Receita' and s.nome = 'Outros')
 where fonte = 'extrato'
   and natureza = 'receita'
   and descricao ilike 'TED%CAIXA%'
   and exists (select 1 from categorias where nome = 'Receita')
   and categoria_id is distinct from (select id from categorias where nome = 'Receita');

-- (c) só a de 2025-12-08 (herança) sai do resumo
update transacoes
   set computa_resumo = false
 where fonte = 'extrato'
   and natureza = 'receita'
   and descricao ilike 'TED%CAIXA%'
   and data = date '2025-12-08'
   and conta_no_resumo;

-- (d) salário da planilha de abr–out/2025: contaria em dobro com o salário alocado
update transacoes t
   set computa_resumo = false
  from categorias c, subcategorias s
 where c.id = t.categoria_id and s.id = t.subcategoria_id
   and c.nome = 'Receita' and s.nome = 'Salário'
   and t.fonte = 'importacao'
   and t.natureza = 'receita'
   and t.data between date '2025-04-01' and date '2025-10-31'
   and t.conta_no_resumo;

-- (e) os dois lançamentos manuais de salário de 2026-09 (salário não se lança à mão)
update transacoes
   set computa_resumo = false
 where fonte = 'manual'
   and natureza = 'receita'
   and data >= date '2026-09-01' and data < date '2026-10-01'
   and descricao ~* 'sal[aá]rio'
   and conta_no_resumo;
