-- 0015 (A2): patrimônio por print — saldo por conta, mês a mês. Aditiva, sem semente: os prints
-- entram pelo Telegram (legenda /patrimonio), nenhum valor no repositório.
--
-- Um registro por produto lido no print, no MENOR grão que o print mostrar: cada título quando
-- aparece (CDB com taxa e vencimento, Tesouro = renda_fixa), o agregado quando é só o que há
-- (Fundos = fundos; Renda Fixa/CDB = renda_fixa; Cofrinhos/Caixinhas = caixa). Dentro de uma conta
-- e data, os títulos de uma família substituem o agregado dela (worker/patrimonio.js): o mesmo
-- print pode trazer os dois, e somar tudo contaria duas vezes.
--
-- `data` = a data que o print mostra (sem data visível, a da mensagem). `rendimento_print_cents` e
-- `periodo_rendimento` guardam o rendimento que o print mostra, com o período — só o de período
-- 'mes' vira rendimento do mês (nas contas sem extrato); o resto fica para consulta.
create table if not exists patrimonio (
  id                     uuid        primary key default gen_random_uuid(),
  data                   date        not null,
  pessoa_id              uuid        not null references pessoas(id),
  conta                  text        not null,          -- 'itau' | 'c6' | 'nubank' | 'mercadopago'
  produto                text        not null,
  familia                text        not null check (familia in ('fundos','renda_fixa','caixa','outros')),
  nivel                  text        not null check (nivel in ('titulo','agregado')),
  vencimento             date,
  taxa                   text,
  saldo_cents            bigint      not null check (saldo_cents >= 0),
  rendimento_print_cents bigint,
  periodo_rendimento     text        check (periodo_rendimento in ('mes','ano','12m','desde_inicio')),
  documento_id           uuid        references documentos(id),
  criado_em              timestamptz not null default now()
);

create index if not exists idx_patrimonio_data on patrimonio (data, conta);
