-- Inc 2.5 (Fase B): categorias/subcategorias por id (FK) + genericização no backfill.
-- ADITIVA: os ids convivem com as colunas string (transacoes.macro/sub, associacoes.macro/sub)
-- até a limpeza (0005). Nunca dropar coluna antes do código usar ids.
--
-- Conflito de nome: já existe a tabela `categorias` (modelo antigo macro/sub), lida por
-- listarCategorias (app + extração). Renomeamos para `categorias_legacy` e criamos a nova
-- `categorias` normalizada. O rename é GUARDADO no script de aplicação (só renomeia se
-- `categorias_legacy` ainda não existir) — SQL puro não expressa isso com segurança.

-- 1) libera o nome (rename guardado no apply):
alter table categorias rename to categorias_legacy;

-- 2) novo modelo normalizado
create table categorias (
  id       uuid primary key default gen_random_uuid(),
  nome     text not null unique,
  natureza text not null default 'despesa' check (natureza in ('despesa','receita')),
  ativa    boolean not null default true
);

create table subcategorias (
  id           uuid primary key default gen_random_uuid(),
  categoria_id uuid not null references categorias(id),
  nome         text not null,
  ativa        boolean not null default true,
  unique (categoria_id, nome)
);

-- 3) ids nas transacoes e associacoes (nullable durante a transição)
alter table transacoes  add column if not exists categoria_id    uuid references categorias(id);
alter table transacoes  add column if not exists subcategoria_id uuid references subcategorias(id);
alter table associacoes add column if not exists categoria_id    uuid references categorias(id);
alter table associacoes add column if not exists subcategoria_id uuid references subcategorias(id);

-- 4) fallback garantido
insert into categorias (nome, natureza) values ('Outros', 'despesa')
  on conflict (nome) do nothing;

-- 5) backfill: feito pelo script apply_0004.mjs, que lê docs/genericizacao-map.csv (aprovado):
--    - insere categorias/subcategorias genéricas;
--    - mapeia (macro,sub) de transacoes/associacoes -> categoria_id/subcategoria_id;
--    - move o favorecido do mapa p/ descricao SÓ quando a descricao é redundante
--      (null/vazia OU = macro OU = sub); descricoes específicas ficam intactas;
--    - o que não estiver no mapa cai em 'Outros' (com relatório).
