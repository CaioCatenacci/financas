-- Inc 4: planejamento orçamentário. Aditiva. Alvo por categoria (despesa), mês a mês.

-- baseline: "a partir de vigente_desde, o alvo desta categoria é V" (propaga pra frente
-- até um baseline mais novo). Alterar toda a sequência futura = inserir baseline no mês atual.
create table if not exists metas (
  categoria_id  uuid not null references categorias(id),
  vigente_desde date not null,                        -- sempre dia 01 do mês
  valor_alvo    numeric(12,2) not null check (valor_alvo >= 0),
  criado_em     timestamptz not null default now(),
  primary key (categoria_id, vigente_desde)
);

-- exceção: "só neste mês o alvo é V" (NÃO propaga). Alterar um mês pontual.
create table if not exists metas_excecao (
  categoria_id uuid not null references categorias(id),
  mes          date not null,                         -- sempre dia 01 do mês
  valor_alvo   numeric(12,2) not null check (valor_alvo >= 0),
  criado_em    timestamptz not null default now(),
  primary key (categoria_id, mes)
);
