-- 0010: corrige o ano das linhas de fatura importadas com o ano errado (dados; idempotente).
--
-- Contexto (C8, 08/10/2026): a fatura do Itaú traz só dia/mês da compra e o parser completava com
-- o ano da fatura. Parcela de compra do fim do ano anterior (ex.: compra de outubro, parcela 12/12
-- na fatura de setembro do ano seguinte) ganhava o ano da fatura e caía num mês futuro. As faturas
-- de 2026 importadas em 08/09/2026 deixaram linhas em outubro-dezembro de 2026 (gasto que não
-- aconteceu) e parcelas de compras de 2025 datadas em 2026.
--
-- Decisões do Caio registradas no card C8:
--   A) daqui pra frente a parcela fica no mês da fatura em que foi cobrada (já no worker/fatura.js);
--   1) o histórico NÃO é refeito: só as linhas erradas voltam um ano; o preview reconhece a chave
--      antiga (linha_hash calculada do jeito de antes), por isso a linha_hash NÃO muda aqui;
--   a) entram também as parcelas de 2025 datadas no passado de 2026 (mês da data + nº da parcela
--      - 1 > 9 só cabe se a compra foi no ano anterior);
--   b) o critério vai no próprio arquivo, não uma lista de ids.
--
-- Idempotente: depois de aplicada, as linhas ficam em 2025 — deixam de estar no futuro e deixam
-- de estar datadas em 2026 —, então rodar de novo não pega nada. Conferido no banco em 08/10/2026:
-- o critério pega exatamente 81 linhas (78 futuras + 3 parcelas).

update transacoes
   set data = data - interval '1 year'
 where fonte = 'fatura'
   and criado_em::date = date '2026-09-08'
   and (
         data > criado_em::date
      or (
               extract(year from data) = 2026
           and descricao ~ '\(parc [0-9]{2}/[0-9]{2}\)'
           and extract(month from data)
               + (substring(descricao from '\(parc ([0-9]{2})/[0-9]{2}\)'))::int - 1 > 9
         )
       );
