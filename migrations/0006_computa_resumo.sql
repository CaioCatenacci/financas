-- Inc 3 bloco 2: flag de "não-gasto" + chave de linha p/ idempotência/reconciliação. Aditiva.

alter table transacoes add column if not exists computa_resumo boolean not null default true;
alter table transacoes add column if not exists linha_hash text;

create unique index if not exists idx_transacoes_linha_hash on transacoes (linha_hash)
  where linha_hash is not null;

-- Categorias de organização p/ o não-gasto (a flag é que exclui do Resumo; a categoria é rótulo)
insert into categorias (nome, natureza) values ('Transferências', 'despesa'), ('Investimentos', 'despesa')
  on conflict (nome) do nothing;
