-- 0016 (A2): "PERS BLACK" no extrato do Itaú é o pagamento da fatura do cartão, não aplicação.
-- Dados; aditiva (UPDATE, sem DELETE/DROP); idempotente; critério no arquivo, nunca lista de ids.
--
-- O classificador (worker/classificar.js) passou a mandar PERS BLACK para Banco — a categoria que o
-- Caio escolheu à mão nas linhas de 2026. As linhas antigas, de 2025, ficaram em Investimentos pela
-- regra velha e contariam como aporte no rendimento do patrimônio. Esta migração as leva para
-- Banco, continuando FORA do resumo (o gasto já entrou pela fatura).
--
-- Contagem conferida no banco em 2026-10-12 (o ensaio deve mostrar o mesmo): 6 linhas de 2025 em
-- Investimentos (extrato, computa_resumo=false); as 8 de 2026 já estão em Banco. Depois de
-- aplicar, PERS BLACK só aparece em Banco: 6 em 2025 e 8 em 2026.
--
-- Idempotente: só pega linha que ainda está em Investimentos; rodar de novo não pega nada. Sem a
-- categoria Banco no catálogo, não mexe em nada (categoria_id é not null).
update transacoes
   set categoria_id    = (select id from categorias where nome = 'Banco'),
       subcategoria_id = null,
       computa_resumo  = false
 where descricao ilike '%PERS BLACK%'
   and categoria_id = (select id from categorias where nome = 'Investimentos')
   and exists (select 1 from categorias where nome = 'Banco');
