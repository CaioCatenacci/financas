-- 0018 (A4): o FGTS ganha família própria em `patrimonio`. Aditiva e idempotente.
--
-- O FGTS só sai para a compra do imóvel: soma no total e no "quanto já temos" do Projeto Casa como
-- as outras famílias, mas aparece separado do que dá para usar. O check de `familia` é fechado,
-- então é trocado por um mais largo (mesmo padrão da 0002: drop if exists + add, sem perder dado —
-- todo valor que o antigo aceitava o novo aceita). A coluna `conta` não tem check: 'fgts' já entra.
alter table patrimonio drop constraint if exists patrimonio_familia_check;
alter table patrimonio add constraint patrimonio_familia_check
  check (familia in ('fundos','renda_fixa','caixa','outros','fgts'));

-- a linha do FGTS gravada à mão no smoke de 13/10 entrou como 'outros'; rodar de novo não muda nada
update patrimonio set familia = 'fgts' where conta = 'fgts' and familia <> 'fgts';
