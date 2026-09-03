import { centsToNumeric } from "./money.js";
import { derivarChave } from "./contraparte.js";

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
           pessoa, fonte, origem_categoria, extraido_por, confianca, documento_id,
           contraparte_nome, contraparte_chave)
        values
          (${t.dataISO}, ${t.natureza}, ${t.esfera}, ${centsToNumeric(t.valorCents)},
           ${centsToNumeric(t.reembolsoCents ?? 0)}, ${t.macro}, ${t.sub}, ${t.descricao},
           ${t.pessoa ?? null}, ${t.fonte}, ${t.origem_categoria}, ${t.extraido_por ?? null},
           ${t.confianca ?? null}, ${t.documento_id ?? null},
           ${t.contraparte_nome ?? null}, ${t.contraparte_chave ?? null})
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
      // read-modify-write: o driver HTTP do Neon não compõe fragmentos `sql`
      // aninhados (só postgres.js faz isso) — então em vez de tentar manter
      // uma coluna "como está" via referência ao próprio nome dentro do
      // template, lemos a linha e mesclamos os campos em JS antes de gravar.
      const rows = await sql`select * from transacoes where id = ${id}`;
      const t = rows[0];
      if (!t) return;
      // undefined = manter o valor atual; para sub/pessoa, string vazia vira null (limpar)
      const data = c.dataISO ?? t.data;
      const macro = c.macro ?? t.macro;
      const sub = c.sub === undefined ? t.sub : (c.sub || null);
      const pessoa = c.pessoa === undefined ? t.pessoa : (c.pessoa || null);
      const descricao = c.descricao === undefined ? t.descricao : (c.descricao || null);
      const natureza = c.natureza ?? t.natureza;
      const esfera = c.esfera ?? t.esfera;
      const valor_total = c.valorCents != null ? centsToNumeric(c.valorCents) : t.valor_total;
      const valor_reembolso = c.reembolsoCents != null ? centsToNumeric(c.reembolsoCents) : t.valor_reembolso;
      // edição manual reclassifica: o Inc 2 aprende dessas correções
      await sql`
        update transacoes set
          data = ${data}, macro = ${macro}, sub = ${sub}, pessoa = ${pessoa},
          descricao = ${descricao}, natureza = ${natureza}, esfera = ${esfera},
          valor_total = ${valor_total}, valor_reembolso = ${valor_reembolso},
          origem_categoria = 'manual'
        where id = ${id}`;
      // aprende: correção de categoria vira regra pra aquela contraparte
      if (c.macro !== undefined || c.sub !== undefined) {
        const d = derivarChave({ contraparte_nome: t.contraparte_nome, contraparte_chave: t.contraparte_chave });
        if (d) await this.upsertAssociacao({ chave: d.chave, tipo: d.tipo, macro, sub });
      }
    },

    async apagarTransacao(id) {
      await sql`delete from transacoes where id = ${id}`;
    },

    async buscarAssociacao(chave, tipo) {
      const rows = await sql`select * from associacoes where chave = ${chave} and tipo_chave = ${tipo} limit 1`;
      return rows[0] ?? null;
    },

    async upsertAssociacao({ chave, tipo, macro, sub }) {
      await sql`
        insert into associacoes (chave, tipo_chave, macro, sub, n, atualizado_em)
        values (${chave}, ${tipo}, ${macro}, ${sub ?? null}, 1, now())
        on conflict (chave, tipo_chave) do update
          set macro = excluded.macro, sub = excluded.sub,
              n = associacoes.n + 1, atualizado_em = now()`;
    },

    async resumoPorCategoria(de, ate) {
      return await sql`
        select macro, sub, natureza, sum(valor_final) as total, count(*) as n
        from transacoes where data >= ${de} and data <= ${ate}
        group by macro, sub, natureza order by total desc`;
    },

    async resumoMensal(de, ate) {
      return await sql`
        select to_char(data,'YYYY-MM') as mes, natureza, sum(valor_final) as total
        from transacoes where data >= ${de} and data <= ${ate}
        group by 1, 2 order by 1`;
    },

    async resumoKPIs(de, ate) {
      const rows = await sql`
        select
          coalesce(sum(valor_final) filter (where natureza = 'receita'), 0) as receita,
          coalesce(sum(valor_final) filter (where natureza = 'despesa'), 0) as despesa,
          coalesce(sum(valor_reembolso), 0) as reembolso
        from transacoes where data >= ${de} and data <= ${ate}`;
      return rows[0];
    },

    // dumbbell: despesa por macro no último mês com dados vs o mês anterior.
    // Ancorado em max(data) (e não em "hoje") p/ ser útil mesmo sem lançamentos no mês corrente.
    async resumoMesVsAnterior() {
      return await sql`
        with m as (select date_trunc('month', max(data)) as cur from transacoes)
        select macro,
          coalesce(sum(valor_final) filter (where date_trunc('month', data) = (select cur from m)), 0) as atual,
          coalesce(sum(valor_final) filter (where date_trunc('month', data) = (select cur from m) - interval '1 month'), 0) as ant
        from transacoes
        where natureza = 'despesa'
          and date_trunc('month', data) in ((select cur from m), (select cur from m) - interval '1 month')
        group by macro
        order by atual desc`;
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
