-- Schema canônico do Incremento 1 (captura de comprovantes).
-- Referência legível; o que se aplica é migrations/0001_init.sql (conteúdo idêntico).
-- Convenções: dinheiro em numeric(12,2); agregação sempre em SQL; vocabulário fixo em checks.

create extension if not exists pgcrypto;  -- gen_random_uuid

create table categorias (
  id       uuid primary key default gen_random_uuid(),
  macro    text not null,
  sub      text,
  natureza text not null default 'despesa',
  ativa    boolean not null default true,
  unique (macro, sub)
);

create table documentos (
  id               uuid primary key default gen_random_uuid(),
  dropbox_path     text not null,
  nome_arquivo     text not null,
  tipo_arquivo     text,
  hash             text unique,      -- dedup: reenviar o mesmo print não duplica
  telegram_file_id text,
  recebido_em      timestamptz not null default now()
);

create table transacoes (
  id               uuid primary key default gen_random_uuid(),
  data             date not null,
  natureza         text not null check (natureza in ('despesa','receita')),
  esfera           text not null default 'pessoal' check (esfera in ('pessoal','empresa')),
  valor_total      numeric(12,2) not null check (valor_total >= 0),
  valor_reembolso  numeric(12,2) not null default 0 check (valor_reembolso >= 0),
  valor_final      numeric(12,2) generated always as (valor_total - valor_reembolso) stored,
  macro            text not null,
  sub              text,
  descricao        text,
  pessoa           text,
  fonte            text not null check (fonte in ('imagem','manual','extrato','fatura','importacao')),
  origem_categoria text not null default 'modelo' check (origem_categoria in ('modelo','manual')),
  extraido_por     text check (extraido_por in ('gemini','claude')),
  confianca        numeric(4,3),
  documento_id     uuid references documentos(id),
  criado_em        timestamptz not null default now()
);

create index idx_transacoes_data on transacoes (data);
create index idx_transacoes_macro on transacoes (macro);
create index idx_transacoes_fonte on transacoes (fonte);
