-- 0019 (A1): a esfera vira propriedade da CATEGORIA, e a transação a herda. Aditiva e idempotente.
--
-- Decisão de 15/10/2026: a esfera diz o que o dinheiro é, não a conta por onde passou (a receita
-- PJ cai no Itaú ou no C6, e as contas da empresa saem de qualquer das duas). Desde o G1 o salário
-- não é transação, então a esfera só marca despesa da empresa: Empresa = empresa; o resto,
-- inclusive Impostos/IR, = pessoal. Quem grava categoria (captura, import, reclassificação, aba
-- Ajustes) passa a copiar a esfera da categoria (esferaDaCategoria, worker/categorias.js).
alter table categorias add column if not exists esfera text not null default 'pessoal';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'categorias_esfera_check') then
    alter table categorias add constraint categorias_esfera_check check (esfera in ('pessoal','empresa'));
  end if;
end $$;

-- semente: a categoria "Empresa" (por nome só aqui, uma vez; dali em diante vale o seletor da aba
-- Ajustes). O guard evita re-marcar se a migração rodar de novo depois de alguém mexer no seletor.
update categorias set esfera = 'empresa'
 where nome = 'Empresa' and esfera <> 'empresa'
   and not exists (select 1 from categorias where esfera = 'empresa');

-- histórico: toda transação passa a ter a esfera da sua categoria (hoje só move pessoal → empresa
-- dentro da categoria Empresa; não existe empresa fora dela).
update transacoes t set esfera = c.esfera
  from categorias c
 where c.id = t.categoria_id and t.esfera <> c.esfera;
