-- 0009: grupos de transações (duplicatas explícitas com representante). Aditiva, idempotente.
--
-- Inc 4.6: um lançamento do Caio e a linha do extrato que o duplica entram no MESMO grupo;
-- exatamente um membro é o representante e só ele conta no Resumo. A regra "quem conta" fica
-- numa coluna gerada (conta_no_resumo) pra viver num lugar só — as leituras agregadas trocam
-- computa_resumo (flag do usuário: "fora do resumo") por ela.

alter table transacoes add column if not exists grupo_id      uuid;
alter table transacoes add column if not exists representante boolean not null default false;

-- representante sem grupo não existe
alter table transacoes drop constraint if exists transacoes_representante_com_grupo;
alter table transacoes add constraint transacoes_representante_com_grupo
  check (not representante or grupo_id is not null);

-- no máximo UM representante por grupo (o "pelo menos um" é garantido pela API/grupos.js)
create unique index if not exists idx_transacoes_grupo_representante
  on transacoes (grupo_id) where representante;

create index if not exists idx_transacoes_grupo
  on transacoes (grupo_id) where grupo_id is not null;

-- quem conta: fora do resumo (flag do usuário) E, se agrupado, só o representante
alter table transacoes add column if not exists conta_no_resumo boolean
  generated always as (computa_resumo and (grupo_id is null or representante)) stored;
