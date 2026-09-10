-- Schema canônico do Incremento 1 (captura de comprovantes).
-- Referência legível; o que se aplica é migrations/0001_init.sql (conteúdo idêntico).
-- Convenções: dinheiro em numeric(12,2); agregação sempre em SQL; vocabulário fixo em checks.

create extension if not exists pgcrypto;  -- gen_random_uuid

-- Inc 2.5 Fase B: modelo normalizado por id (migração 0004; strings antigas removidas na 0005).
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

create table documentos (
  id               uuid primary key default gen_random_uuid(),
  dropbox_path     text not null,
  nome_arquivo     text not null,
  tipo_arquivo     text,
  hash             text unique,      -- dedup: reenviar o mesmo print não duplica
  telegram_file_id text,
  recebido_em      timestamptz not null default now()
);

-- Inc 2.5: pessoas gerenciáveis (dropdown fixo, editável na tela)
create table pessoas (
  id    uuid primary key default gen_random_uuid(),
  nome  text not null unique,
  ativa boolean not null default true
);

create table transacoes (
  id               uuid primary key default gen_random_uuid(),
  data             date not null,
  natureza         text not null check (natureza in ('despesa','receita')),
  esfera           text not null default 'pessoal' check (esfera in ('pessoal','empresa')),
  valor_total      numeric(12,2) not null check (valor_total >= 0),
  valor_reembolso  numeric(12,2) not null default 0 check (valor_reembolso >= 0),
  valor_final      numeric(12,2) generated always as (valor_total - valor_reembolso) stored,
  descricao        text,
  fonte            text not null check (fonte in ('imagem','manual','extrato','fatura','importacao')),
  origem_categoria text not null default 'modelo' check (origem_categoria in ('modelo','manual','regra')),
  extraido_por     text check (extraido_por in ('gemini','claude')),
  confianca        numeric(4,3),
  documento_id     uuid references documentos(id),
  contraparte_nome  text,                     -- destinatário/pagador lido do comprovante (Inc 2)
  contraparte_chave text,                     -- chave Pix / CPF normalizável (Inc 2)
  pessoa_id        uuid references pessoas(id), -- quem (Lucca/Manuela/...) — Inc 2.5
  categoria_id     uuid not null references categorias(id),  -- Inc 2.5 Fase B
  subcategoria_id  uuid references subcategorias(id),         -- Inc 2.5 Fase B
  computa_resumo   boolean not null default true,            -- Inc 3 b2: false = não entra no Resumo
  linha_hash       text,                                      -- Inc 3 b2: chave estável da linha de extrato/fatura
  criado_em        timestamptz not null default now()
);

create index idx_transacoes_data on transacoes (data);
create index idx_transacoes_macro on transacoes (macro);
create index idx_transacoes_fonte on transacoes (fonte);
create unique index idx_transacoes_linha_hash on transacoes (linha_hash) where linha_hash is not null;

-- Inc 2: conhecimento aprendido (contraparte → categoria), alimentado pelas correções
create table associacoes (
  chave         text not null,
  tipo_chave    text not null check (tipo_chave in ('pix_cpf','nome')),
  n             integer not null default 1,
  atualizado_em timestamptz not null default now(),
  categoria_id    uuid references categorias(id),    -- Inc 2.5 Fase B (convive c/ macro/sub até 0005)
  subcategoria_id uuid references subcategorias(id), -- Inc 2.5 Fase B
  primary key (chave, tipo_chave)
);

-- Inc 4: planejamento orçamentário. Alvo por categoria (despesa), mês a mês.
-- baseline: "a partir de vigente_desde, o alvo desta categoria é V" (propaga pra frente
-- até um baseline mais novo). Alterar toda a sequência futura = inserir baseline no mês atual.
create table metas (
  categoria_id  uuid not null references categorias(id),
  vigente_desde date not null,                        -- sempre dia 01 do mês
  valor_alvo    numeric(12,2) not null check (valor_alvo >= 0),
  criado_em     timestamptz not null default now(),
  primary key (categoria_id, vigente_desde)
);

-- exceção: "só neste mês o alvo é V" (NÃO propaga). Alterar um mês pontual.
create table metas_excecao (
  categoria_id uuid not null references categorias(id),
  mes          date not null,                         -- sempre dia 01 do mês
  valor_alvo   numeric(12,2) not null check (valor_alvo >= 0),
  criado_em    timestamptz not null default now(),
  primary key (categoria_id, mes)
);
