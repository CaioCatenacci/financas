-- Inc 2.5 (Fase B) — LIMPEZA (DESTRUTIVA). Só após o cutover validado em produção.
-- Remove as colunas string vestigiais e a tabela legada; nada no código as lê mais
-- (categorias por id desde a 0004 + cutover). Aplicada pelo script apply_0005.mjs.

-- 1) segurança: toda transação precisa de categoria_id antes do NOT NULL
update transacoes set categoria_id = (select id from categorias where nome = 'Outros')
  where categoria_id is null;
alter table transacoes alter column categoria_id set not null;

-- 2) drop das colunas string (transacoes.macro/sub/pessoa; associacoes.macro/sub)
alter table transacoes  drop column if exists macro;
alter table transacoes  drop column if exists sub;
alter table transacoes  drop column if exists pessoa;
alter table associacoes drop column if exists macro;
alter table associacoes drop column if exists sub;

-- 3) a tabela antiga de categorias (macro/sub) foi substituída pela nova por id
drop table if exists categorias_legacy;
