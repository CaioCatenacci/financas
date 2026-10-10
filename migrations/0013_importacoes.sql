-- 0013 (G2): fechamento do mês — o que falta importar. Aditiva, sem semente: o histórico já
-- importado entra por arquivo local (dados/, fora do repositório), na entrega.
--
-- Uma linha por import aplicado, com o período que o próprio arquivo cobre: extrato (Itaú/C6) do
-- primeiro ao último "Saldo do dia" do PDF; fatura do dia 01 ao último dia do mês do vencimento;
-- Wise da primeira à última conversão do CSV. A cobertura de uma fonte é max(ate) por conta/tipo
-- (a última data com movimento não diz até onde o PDF foi; por isso grava-se o período, não se
-- infere das transações).
create table if not exists importacoes (
  id        uuid        primary key default gen_random_uuid(),
  conta     text        not null,                  -- 'itau' | 'c6' | 'wise'
  tipo      text        not null check (tipo in ('extrato','fatura','wise')),
  de        date,
  ate       date        not null,
  criado_em timestamptz not null default now()
);

create index if not exists idx_importacoes_conta_tipo on importacoes (conta, tipo, ate);
