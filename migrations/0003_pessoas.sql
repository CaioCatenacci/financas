-- Inc 2.5 (Fase A): pessoas gerenciáveis + transacoes.pessoa_id (FK), com backfill.
create table if not exists pessoas (
  id    uuid primary key default gen_random_uuid(),
  nome  text not null unique,
  ativa boolean not null default true
);

-- semente inicial (editável na tela depois)
insert into pessoas (nome) values ('Caio'),('Paola'),('Lucca'),('Manuela'),('Casa')
  on conflict (nome) do nothing;

-- traz nomes de pessoa que já existem nas transações
insert into pessoas (nome)
  select distinct pessoa from transacoes
  where pessoa is not null and btrim(pessoa) <> ''
  on conflict (nome) do nothing;

alter table transacoes add column if not exists pessoa_id uuid references pessoas(id);

update transacoes t set pessoa_id = p.id
  from pessoas p
  where t.pessoa is not null and t.pessoa = p.nome and t.pessoa_id is null;
