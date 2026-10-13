-- 0017 (G4): Projeto Casa — parâmetros da meta e a categoria marcada por flag. Aditiva e
-- idempotente; sem semente de valores (custo, reserva e data alvo entram pelo app).
--
-- Parâmetro com vigência (mesmo modelo do salario_param do G1): "a partir de vigente_desde, o
-- custo é X, a reserva é Y e a data alvo é Z". Vigente num mês = o mais recente até ele.
create table if not exists projeto_casa_param (
  vigente_desde     date   primary key,           -- sempre dia 01 do mês
  custo_total_cents bigint not null check (custo_total_cents > 0),
  reserva_cents     bigint not null check (reserva_cents >= 0),
  data_alvo         date
);

-- Categoria da obra por FLAG, nunca por nome (o defeito do fix de 25/09/2026: renomear na aba
-- Ajustes quebrava quem procurava o nome). Só uma pode ter a flag (índice parcial, como `padrao`).
-- A despesa continua no resumo do mês (é gasto real); fica fora só do ritmo da casa.
alter table categorias add column if not exists projeto_casa boolean not null default false;

create unique index if not exists categorias_projeto_casa_unica on categorias (projeto_casa) where projeto_casa;

-- cria a "Projeto Casa" só se nenhuma categoria tiver a flag. Não marca categoria existente: a
-- que já tem "casa" no nome é gasto doméstico, outra coisa. Se já houver uma categoria chamada
-- exatamente "Projeto Casa" sem a flag, o on conflict não faz nada (decide-se na mão).
insert into categorias (nome, natureza, projeto_casa)
select 'Projeto Casa', 'despesa', true
 where not exists (select 1 from categorias where projeto_casa)
on conflict (nome) do nothing;
