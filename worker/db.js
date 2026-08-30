import { centsToNumeric } from "./money.js";

export function criarDb(sql) {
  return {
    async documentoPorHash(hash) {
      const rows = await sql`select * from documentos where hash = ${hash} limit 1`;
      return rows[0] ?? null;
    },

    async inserirDocumento(d) {
      const rows = await sql`
        insert into documentos (dropbox_path, nome_arquivo, tipo_arquivo, hash, telegram_file_id)
        values (${d.dropbox_path}, ${d.nome_arquivo}, ${d.tipo_arquivo}, ${d.hash}, ${d.telegram_file_id})
        returning id`;
      return { id: rows[0].id };
    },

    async inserirTransacao(t) {
      const rows = await sql`
        insert into transacoes
          (data, natureza, esfera, valor_total, valor_reembolso, macro, sub, descricao,
           pessoa, fonte, origem_categoria, extraido_por, confianca, documento_id)
        values
          (${t.dataISO}, ${t.natureza}, ${t.esfera}, ${centsToNumeric(t.valorCents)},
           ${centsToNumeric(t.reembolsoCents ?? 0)}, ${t.macro}, ${t.sub}, ${t.descricao},
           ${t.pessoa ?? null}, ${t.fonte}, ${t.origem_categoria}, ${t.extraido_por ?? null},
           ${t.confianca ?? null}, ${t.documento_id ?? null})
        returning id`;
      return { id: rows[0].id };
    },

    async listarCategorias() {
      return await sql`select macro, sub, natureza from categorias where ativa order by macro, sub`;
    },

    async listarTransacoes(f = {}) {
      // filtros opcionais; usa coalesce p/ ignorar quando nulos
      return await sql`
        select * from transacoes
        where (${f.de ?? null}::date is null or data >= ${f.de ?? null})
          and (${f.ate ?? null}::date is null or data <= ${f.ate ?? null})
          and (${f.macro ?? null}::text is null or macro = ${f.macro ?? null})
          and (${f.natureza ?? null}::text is null or natureza = ${f.natureza ?? null})
          and (${f.esfera ?? null}::text is null or esfera = ${f.esfera ?? null})
        order by data desc, criado_em desc
        limit 1000`;
    },

    async atualizarTransacao(id, c) {
      await sql`
        update transacoes set
          data = coalesce(${c.dataISO ?? null}, data),
          macro = coalesce(${c.macro ?? null}, macro),
          sub = ${c.sub === undefined ? sql`sub` : c.sub},
          valor_total = coalesce(${c.valorCents != null ? centsToNumeric(c.valorCents) : null}, valor_total),
          valor_reembolso = coalesce(${c.reembolsoCents != null ? centsToNumeric(c.reembolsoCents) : null}, valor_reembolso),
          pessoa = ${c.pessoa === undefined ? sql`pessoa` : c.pessoa},
          natureza = coalesce(${c.natureza ?? null}, natureza),
          esfera = coalesce(${c.esfera ?? null}, esfera),
          origem_categoria = 'manual'
        where id = ${id}`;
    },

    async apagarTransacao(id) {
      await sql`delete from transacoes where id = ${id}`;
    },

    async resumoPorCategoria(de, ate) {
      return await sql`
        select macro, sub, natureza, sum(valor_final) as total, count(*) as n
        from transacoes where data >= ${de} and data <= ${ate}
        group by macro, sub, natureza order by total desc`;
    },

    async resumoMensal() {
      return await sql`
        select to_char(data,'YYYY-MM') as mes, natureza, sum(valor_final) as total
        from transacoes group by 1, 2 order by 1`;
    },

    async resumoReembolsoAno() {
      return await sql`
        select extract(year from data)::int as ano, macro,
               sum(valor_total) as bruto, sum(valor_reembolso) as reembolsado, sum(valor_final) as liquido
        from transacoes where valor_reembolso > 0
        group by 1, 2 order by 1, 2`;
    },
  };
}
