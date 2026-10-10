-- 0014 (G3): diagnóstico mensal — a análise escrita do mês, uma por mês. Aditiva, sem semente:
-- quem escreve é o assistente pela API (PUT /api/diagnostico); o app só guarda e mostra.
-- O CHECK é só o formato; o Worker valida o mês de verdade (01..12) antes de gravar.
create table if not exists diagnosticos (
  mes           text        primary key check (mes ~ '^\d{4}-\d{2}$'),
  texto         text        not null,
  atualizado_em timestamptz not null default now()
);
