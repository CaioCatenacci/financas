-- Inc 2: contraparte nas transações + tabela de associações aprendidas.
alter table transacoes add column if not exists contraparte_nome  text;
alter table transacoes add column if not exists contraparte_chave text;

-- origem_categoria ganha 'regra' (categoria veio de associação aprendida)
alter table transacoes drop constraint if exists transacoes_origem_categoria_check;
alter table transacoes add constraint transacoes_origem_categoria_check
  check (origem_categoria in ('modelo','manual','regra'));

create table if not exists associacoes (
  chave         text not null,
  tipo_chave    text not null check (tipo_chave in ('pix_cpf','nome')),
  macro         text not null,
  sub           text,
  n             integer not null default 1,
  atualizado_em timestamptz not null default now(),
  primary key (chave, tipo_chave)
);
