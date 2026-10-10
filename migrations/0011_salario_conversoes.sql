-- 0011 (G1): salário por competência. Aditiva, sem semente — o parâmetro e a carga histórica
-- entram por arquivo local (dados/, fora do repositório: nenhum valor real aqui).

-- baseline com vigência (mesmo modelo de metas): "a partir de vigente_desde, o salário mensal
-- é usd_cents dólares". O mês anterior ao primeiro parâmetro não tem salário em dólar.
create table if not exists salario_param (
  vigente_desde date   not null primary key,   -- sempre dia 01 do mês
  usd_cents     bigint not null check (usd_cents >= 0)
);

-- cada conversão USD → BRL (CSV da Wise ou carga única da Nomad). A alocação FIFO aos meses
-- roda em JS puro (worker/salario.js); aqui só o fato. linha_hash = sha256 do id da origem
-- (TransferWise ID na Wise): reimportar o mesmo CSV não duplica.
create table if not exists conversoes (
  id         uuid   primary key default gen_random_uuid(),
  data       date   not null,
  usd_cents  bigint not null check (usd_cents > 0),
  brl_cents  bigint not null check (brl_cents >= 0),
  origem     text   not null check (origem in ('wise','nomad')),
  linha_hash text   not null unique,
  criado_em  timestamptz not null default now()
);

create index if not exists idx_conversoes_data on conversoes (data);
