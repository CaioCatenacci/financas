-- 0008: categoria padrão por FLAG, não por nome (aditiva, idempotente).
--
-- Contexto (25/09/2026): "Outros" foi renomeada na aba Ajustes pra "Não Identificado". O fallback
-- de resolverCategoria procurava o nome literal "Outros", devolveu null e o insert estourou o
-- NOT NULL de categoria_id → o webhook do Telegram respondia 500 e o bot ficou mudo.
--
-- Semântica a partir daqui (decisão do Caio):
--   * "Não Identificado" (padrao = true): recebe o que ninguém classificou; é a fila de triagem.
--   * "Outros": miscelânea deliberada — o Caio escolhe; NÃO é fallback.
-- Só uma categoria pode ser padrão (índice parcial). Renomear a padrão é livre (o código usa a
-- flag); desativá-la é bloqueado no db.desativarCategoria.

alter table categorias add column if not exists padrao boolean not null default false;

create unique index if not exists categorias_padrao_unica on categorias (padrao) where padrao;

-- marca "Não Identificado" como padrão (só se ainda não houver uma padrão)
update categorias set padrao = true
 where nome = 'Não Identificado'
   and not exists (select 1 from categorias where padrao);

-- se não existir nenhuma padrão (banco sem "Não Identificado"), cria uma
insert into categorias (nome, natureza, padrao)
select 'Não Identificado', 'despesa', true
 where not exists (select 1 from categorias where padrao);

-- "Outros" volta a existir como miscelânea deliberada (ativa, sem flag)
insert into categorias (nome, natureza) values ('Outros', 'despesa')
 on conflict (nome) do update set ativa = true;
