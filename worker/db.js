import { centsToNumeric } from "./money.js";
import { derivarChave, normalizarNome } from "./contraparte.js";

export function criarDb(sql) {
  // Builder da query de insert de transação. Reusado no insert único (captura) e no lote
  // transacional da importação — retorna a query SEM await (o await/transaction executa).
  const qInserirTransacao = (t) => sql`
    insert into transacoes
      (data, natureza, esfera, valor_total, valor_reembolso, categoria_id, subcategoria_id,
       descricao, pessoa_id, fonte, origem_categoria, extraido_por, confianca, documento_id,
       contraparte_nome, contraparte_chave, computa_resumo, linha_hash)
    values
      (${t.dataISO}, ${t.natureza}, ${t.esfera}, ${centsToNumeric(t.valorCents)},
       ${centsToNumeric(t.reembolsoCents ?? 0)}, ${t.categoria_id ?? null}, ${t.subcategoria_id ?? null},
       ${t.descricao}, ${t.pessoa_id ?? null}, ${t.fonte}, ${t.origem_categoria},
       ${t.extraido_por ?? null}, ${t.confianca ?? null}, ${t.documento_id ?? null},
       ${t.contraparte_nome ?? null}, ${t.contraparte_chave ?? null},
       ${t.computa_resumo ?? true}, ${t.linha_hash ?? null})
    returning id`;
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

    // Fase B: grava por categoria_id/subcategoria_id. As colunas string macro/sub
    // saíram (0004 soltou o NOT NULL de macro); ficam null e são removidas na 0005.
    async inserirTransacao(t) {
      const rows = await qInserirTransacao(t);
      return { id: rows[0].id };
    },

    // catálogo do modelo por id (categorias + subcategorias ativas). Alimenta selects e resolução.
    async catalogo() {
      const categorias = await sql`select id, nome, natureza, ativa from categorias where ativa order by nome`;
      const subcategorias = await sql`select id, categoria_id, nome, ativa from subcategorias where ativa order by nome`;
      return { categorias, subcategorias };
    },

    async listarPessoas() {
      return await sql`select id, nome from pessoas where ativa order by nome`;
    },

    async pessoaPorNome(nome) {
      const rows = await sql`select id, nome from pessoas where ativa and lower(nome) = lower(${nome}) limit 1`;
      return rows[0] ?? null;
    },

    // join p/ devolver os NOMES (categoria/subcategoria/pessoa) além dos ids; o app usa os nomes.
    async listarTransacoes(f = {}) {
      return await sql`
        select t.*, c.nome as categoria, s.nome as subcategoria, p.nome as pessoa
        from transacoes t
        left join categorias c    on c.id = t.categoria_id
        left join subcategorias s on s.id = t.subcategoria_id
        left join pessoas p       on p.id = t.pessoa_id
        where (${f.de ?? null}::date is null or t.data >= ${f.de ?? null})
          and (${f.ate ?? null}::date is null or t.data <= ${f.ate ?? null})
          and (${f.categoria_id ?? null}::uuid is null or t.categoria_id = ${f.categoria_id ?? null})
          and (${f.natureza ?? null}::text is null or t.natureza = ${f.natureza ?? null})
          and (${f.esfera ?? null}::text is null or t.esfera = ${f.esfera ?? null})
        order by t.data desc, t.criado_em desc
        limit 1000`;
    },

    async atualizarTransacao(id, c) {
      // read-modify-write: o driver HTTP do Neon não compõe fragmentos aninhados,
      // então lemos a linha e mesclamos em JS. undefined = manter; '' = limpar (null).
      const rows = await sql`select * from transacoes where id = ${id}`;
      const t = rows[0];
      if (!t) return;
      const data = c.dataISO ?? t.data;
      const categoria_id = c.categoria_id === undefined ? t.categoria_id : (c.categoria_id || null);
      const subcategoria_id = c.subcategoria_id === undefined ? t.subcategoria_id : (c.subcategoria_id || null);
      const pessoa_id = c.pessoa_id === undefined ? t.pessoa_id : (c.pessoa_id || null);
      const descricao = c.descricao === undefined ? t.descricao : (c.descricao || null);
      const natureza = c.natureza ?? t.natureza;
      const esfera = c.esfera ?? t.esfera;
      const valor_total = c.valorCents != null ? centsToNumeric(c.valorCents) : t.valor_total;
      const valor_reembolso = c.reembolsoCents != null ? centsToNumeric(c.reembolsoCents) : t.valor_reembolso;
      const computa_resumo = c.computa_resumo === undefined ? t.computa_resumo : !!c.computa_resumo;
      // edição manual reclassifica: o Inc 2 aprende dessas correções
      await sql`
        update transacoes set
          data = ${data}, categoria_id = ${categoria_id}, subcategoria_id = ${subcategoria_id},
          pessoa_id = ${pessoa_id}, descricao = ${descricao}, natureza = ${natureza}, esfera = ${esfera},
          valor_total = ${valor_total}, valor_reembolso = ${valor_reembolso},
          computa_resumo = ${computa_resumo},
          origem_categoria = 'manual'
        where id = ${id}`;
      // aprende: correção de categoria vira regra pra aquela contraparte (por id)
      if (c.categoria_id !== undefined || c.subcategoria_id !== undefined) {
        const d = derivarChave({ contraparte_nome: t.contraparte_nome, contraparte_chave: t.contraparte_chave });
        if (d) await this.upsertAssociacao({ chave: d.chave, tipo: d.tipo, categoria_id, subcategoria_id });
      }
    },

    async apagarTransacao(id) {
      await sql`delete from transacoes where id = ${id}`;
    },

    // Edição em massa: aplica `mudancas` a todos os `ids` num ÚNICO update (guard por campo:
    // só mexe no que veio em `mudancas`; `id = any(ids)` → 1 subrequest, não estoura o limite).
    // Se a categoria mudou e `aprender`, aprende contraparte→categoria de cada linha em LOTE
    // (1 leitura + 1 sql.transaction de upserts) — mesma regra da edição por linha.
    // `mudancas`: { categoria_id?, subcategoria_id?, pessoa_id?, computa_resumo? } — chave ausente
    // = não mexe naquele campo; categoria_id presente também seta subcategoria_id (null se sem sub).
    async atualizarTransacoesLote(ids, mudancas = {}, { aprender = true } = {}) {
      if (!ids || !ids.length) return { atualizados: 0, regras: 0 };
      const setCat = mudancas.categoria_id !== undefined;
      const setPessoa = mudancas.pessoa_id !== undefined;
      const setComputa = mudancas.computa_resumo !== undefined;
      const catId = mudancas.categoria_id || null;
      const subId = mudancas.subcategoria_id || null;
      const pessoaId = mudancas.pessoa_id || null;
      const computa = !!mudancas.computa_resumo;

      await sql`
        update transacoes set
          categoria_id     = case when ${setCat}::boolean     then ${catId}::uuid    else categoria_id end,
          subcategoria_id  = case when ${setCat}::boolean     then ${subId}::uuid    else subcategoria_id end,
          pessoa_id        = case when ${setPessoa}::boolean  then ${pessoaId}::uuid else pessoa_id end,
          computa_resumo   = case when ${setComputa}::boolean then ${computa}::boolean else computa_resumo end,
          origem_categoria = case when ${setCat}::boolean     then 'manual'          else origem_categoria end
        where id = any(${ids}::uuid[])`;

      let regras = 0;
      // aprende só quando a categoria mudou (correção de categoria vira regra) — em lote.
      if (aprender && setCat) {
        const rows = await sql`select contraparte_nome, contraparte_chave from transacoes where id = any(${ids}::uuid[])`;
        const porChave = new Map();
        for (const r of rows) {
          const d = derivarChave({ contraparte_nome: r.contraparte_nome, contraparte_chave: r.contraparte_chave });
          if (d) porChave.set(`${d.tipo}|${d.chave}`, d); // dedupe: uma regra por contraparte
        }
        const upserts = [...porChave.values()].map(d => sql`
          insert into associacoes (chave, tipo_chave, categoria_id, subcategoria_id, n, atualizado_em)
          values (${d.chave}, ${d.tipo}, ${catId}, ${subId}, 1, now())
          on conflict (chave, tipo_chave) do update
            set categoria_id = excluded.categoria_id, subcategoria_id = excluded.subcategoria_id,
                n = associacoes.n + 1, atualizado_em = now()`);
        if (upserts.length) await sql.transaction(upserts);
        regras = upserts.length;
      }
      return { atualizados: ids.length, regras };
    },

    async buscarAssociacao(chave, tipo) {
      const rows = await sql`select * from associacoes where chave = ${chave} and tipo_chave = ${tipo} limit 1`;
      return rows[0] ?? null;
    },

    async upsertAssociacao({ chave, tipo, categoria_id, subcategoria_id }) {
      await sql`
        insert into associacoes (chave, tipo_chave, categoria_id, subcategoria_id, n, atualizado_em)
        values (${chave}, ${tipo}, ${categoria_id ?? null}, ${subcategoria_id ?? null}, 1, now())
        on conflict (chave, tipo_chave) do update
          set categoria_id = excluded.categoria_id, subcategoria_id = excluded.subcategoria_id,
              n = associacoes.n + 1, atualizado_em = now()`;
    },

    // ---- CRUD de categorias/subcategorias/pessoas (tela de gestão) ----
    async criarCategoria(nome, natureza = "despesa") {
      const rows = await sql`insert into categorias (nome, natureza) values (${nome}, ${natureza})
        on conflict (nome) do update set ativa = true returning id`;
      return { id: rows[0].id };
    },
    async renomearCategoria(id, nome) {
      await sql`update categorias set nome = ${nome} where id = ${id}`;
    },
    async desativarCategoria(id) {
      await sql`update categorias set ativa = false where id = ${id}`;
    },
    async criarSub(categoria_id, nome) {
      const rows = await sql`insert into subcategorias (categoria_id, nome) values (${categoria_id}, ${nome})
        on conflict (categoria_id, nome) do update set ativa = true returning id`;
      return { id: rows[0].id };
    },
    async renomearSub(id, nome) {
      await sql`update subcategorias set nome = ${nome} where id = ${id}`;
    },
    async moverSub(id, categoria_id) {
      await sql`update subcategorias set categoria_id = ${categoria_id} where id = ${id}`;
    },
    async desativarSub(id) {
      await sql`update subcategorias set ativa = false where id = ${id}`;
    },
    // merge: as transacoes/associacoes da sub origem passam a apontar p/ a destino; origem sai.
    async mergeSub(origem_id, destino_id) {
      await sql`update transacoes  set subcategoria_id = ${destino_id} where subcategoria_id = ${origem_id}`;
      await sql`update associacoes  set subcategoria_id = ${destino_id} where subcategoria_id = ${origem_id}`;
      await sql`update subcategorias set ativa = false where id = ${origem_id}`;
    },
    async criarPessoa(nome) {
      const rows = await sql`insert into pessoas (nome) values (${nome})
        on conflict (nome) do update set ativa = true returning id`;
      return { id: rows[0].id };
    },
    async renomearPessoa(id, nome) {
      await sql`update pessoas set nome = ${nome} where id = ${id}`;
    },
    async desativarPessoa(id) {
      await sql`update pessoas set ativa = false where id = ${id}`;
    },

    // ---- resumos (join p/ nomes; apelidam c.nome as macro p/ manter a forma que os gráficos usam) ----
    async resumoPorCategoria(de, ate) {
      return await sql`
        select c.nome as macro, s.nome as sub, t.natureza, sum(t.valor_final) as total, count(*) as n
        from transacoes t
        left join categorias c    on c.id = t.categoria_id
        left join subcategorias s on s.id = t.subcategoria_id
        where t.data >= ${de} and t.data <= ${ate} and t.computa_resumo
        group by c.nome, s.nome, t.natureza order by total desc`;
    },

    async resumoKPIs(de, ate) {
      const rows = await sql`
        select
          coalesce(sum(valor_final) filter (where natureza = 'receita'), 0) as receita,
          coalesce(sum(valor_final) filter (where natureza = 'despesa'), 0) as despesa,
          coalesce(sum(valor_reembolso), 0) as reembolso
        from transacoes where data >= ${de} and data <= ${ate} and computa_resumo`;
      return rows[0];
    },

    async resumoDiario(de, ateExcl) {
      const rows = await sql`
        select to_char(data,'YYYY-MM-DD') as dia,
               (round(sum(valor_final)*100))::bigint as total_cents
        from transacoes
        where natureza = 'despesa' and computa_resumo
          and data >= ${de} and data < ${ateExcl}
        group by 1 order by 1`;
      return rows.map(r => ({ ...r, total_cents: Number(r.total_cents) }));
    },

    // dumbbell: despesa por categoria no mês de referência vs o anterior. Ancorado no mês passado.
    async resumoMesVsAnterior(mesRef) {
      const cur = `${mesRef}-01`;
      return await sql`
        with m as (select date_trunc('month', ${cur}::date) as cur)
        select c.nome as macro,
          coalesce(sum(t.valor_final) filter (where date_trunc('month', t.data) = (select cur from m)), 0) as atual,
          coalesce(sum(t.valor_final) filter (where date_trunc('month', t.data) = (select cur from m) - interval '1 month'), 0) as ant
        from transacoes t
        left join categorias c on c.id = t.categoria_id
        where t.natureza = 'despesa' and t.computa_resumo
          and t.data >= (select cur from m) - interval '1 month'
          and t.data <  (select cur from m) + interval '1 month'
        group by c.nome
        order by atual desc`;
    },

    async resumoReembolsoAno() {
      return await sql`
        select extract(year from t.data)::int as ano, c.nome as macro,
               sum(t.valor_total) as bruto, sum(t.valor_reembolso) as reembolsado, sum(t.valor_final) as liquido
        from transacoes t
        left join categorias c on c.id = t.categoria_id
        where t.valor_reembolso > 0 and t.computa_resumo
        group by 1, 2 order by 1, 2`;
    },

    async resumoPorPessoa(de, ate) {
      return await sql`
        select coalesce(p.nome, '—') as pessoa, t.natureza, sum(t.valor_final) as total
        from transacoes t
        left join pessoas p on p.id = t.pessoa_id
        where t.data >= ${de} and t.data <= ${ate} and t.computa_resumo
        group by 1, 2
        order by 3 desc`;
    },

    // ---- Inc 4: planejamento (metas) ----
    async metasBaselines() {
      const rows = await sql`
        select categoria_id, to_char(vigente_desde,'YYYY-MM-01') as vigente_desde,
               (round(valor_alvo*100))::bigint as valor_cents
        from metas`;
      // driver do Neon devolve ::bigint como string — converte na borda (mesmo padrão de
      // transacoesNaJanela), senão os acumuladores += de index.js concatenam texto.
      return rows.map(r => ({ ...r, valor_cents: Number(r.valor_cents) }));
    },

    async metasExcecoes() {
      const rows = await sql`
        select categoria_id, to_char(mes,'YYYY-MM-01') as mes,
               (round(valor_alvo*100))::bigint as valor_cents
        from metas_excecao`;
      return rows.map(r => ({ ...r, valor_cents: Number(r.valor_cents) }));
    },

    // realizado (despesa, no resumo) por categoria e mês na janela meio-aberta [de, ateExcl).
    async realizadoPorCategoriaMes(de, ateExcl) {
      const rows = await sql`
        select t.categoria_id, to_char(t.data,'YYYY-MM') as mes,
               (round(sum(t.valor_final)*100))::bigint as realizado_cents
        from transacoes t
        where t.natureza = 'despesa' and t.computa_resumo
          and t.data >= ${de} and t.data < ${ateExcl}
        group by t.categoria_id, to_char(t.data,'YYYY-MM')`;
      return rows.map(r => ({ ...r, realizado_cents: Number(r.realizado_cents) }));
    },

    async setBaseline(categoria_id, mesDia01, valorCents) {
      await sql`
        insert into metas (categoria_id, vigente_desde, valor_alvo)
        values (${categoria_id}, ${mesDia01}, ${centsToNumeric(valorCents)})
        on conflict (categoria_id, vigente_desde)
        do update set valor_alvo = excluded.valor_alvo, criado_em = now()`;
    },

    async setExcecao(categoria_id, mesDia01, valorCents) {
      await sql`
        insert into metas_excecao (categoria_id, mes, valor_alvo)
        values (${categoria_id}, ${mesDia01}, ${centsToNumeric(valorCents)})
        on conflict (categoria_id, mes)
        do update set valor_alvo = excluded.valor_alvo, criado_em = now()`;
    },

    async apagarBaseline(categoria_id, mesDia01) {
      await sql`delete from metas where categoria_id = ${categoria_id} and vigente_desde = ${mesDia01}`;
    },

    async apagarExcecao(categoria_id, mesDia01) {
      await sql`delete from metas_excecao where categoria_id = ${categoria_id} and mes = ${mesDia01}`;
    },

    // ---- apoio à importação: consultas de reconciliação ----
    async transacoesNaJanela(de, ate) {
      const rows = await sql`
        select id, to_char(data,'YYYY-MM-DD') as data,
          (round(valor_final*100))::bigint as valor_cents
        from transacoes
        where data between ${de} and ${ate} and linha_hash is null`;
      return rows.map(r => ({ id: String(r.id), data: r.data, valorCents: Number(r.valor_cents) }));
    },

    async hashesNaJanela(de, ate) {
      const rows = await sql`
        select linha_hash
        from transacoes
        where data between ${de} and ${ate} and linha_hash is not null`;
      return rows.map(r => r.linha_hash);
    },

    // Aplica a importação inteira numa ÚNICA transação HTTP (1 subrequest, atômica). O driver do
    // Neon faz 1 subrequest por query, então o loop antigo (1 await por linha) estourava o limite
    // de subrequests do Worker num extrato grande (~236 linhas). sql.transaction manda todas as
    // queries num POST só — e, sendo atômica, ou grava tudo ou nada (nunca import pela metade).
    async aplicarImportacao({ novos = [], naoGasto = [], casados = [] }) {
      const queries = [];
      for (const t of [...novos, ...naoGasto]) queries.push(qInserirTransacao(t));
      for (const c of casados) {
        queries.push(sql`update transacoes set linha_hash = ${c.linhaHash} where id = ${c.matchId} and linha_hash is null`);
      }
      if (queries.length) await sql.transaction(queries);
      return { gravados: novos.length + naoGasto.length, conciliados: casados.length, naoGasto: naoGasto.length };
    },

    // Marca o pagamento da fatura no extrato como fora do resumo (computa_resumo=false): procura
    // UMA despesa de extrato ainda no resumo cujo valor bata com o total da fatura, dentro de
    // [de,ate]. Espelha tools/importar_fatura.py: 1 candidato → marca; 0 ou >1 → não mexe (devolve
    // a contagem p/ quem chama avisar). Sem isso, os itens da fatura + o pagamento no extrato
    // contariam o gasto do cartão duas vezes no Resumo.
    async marcarPagamentoFaturaNaoGasto(totalCents, de, ate) {
      const rows = await sql`
        select id from transacoes
        where fonte = 'extrato' and natureza = 'despesa' and computa_resumo = true
          and (round(valor_final*100))::bigint = ${totalCents}
          and data between ${de} and ${ate}`;
      if (rows.length === 1) {
        await sql`update transacoes set computa_resumo = false where id = ${rows[0].id}`;
        return { marcados: 1, candidatos: 1 };
      }
      return { marcados: 0, candidatos: rows.length };
    },

    // carimba a linha_hash na transação já existente que casou (reconciliação) — só se ainda
    // não tiver sido carimbada, senão mascararia um bug de duplo-match (espelha
    // tools/importar_extrato.py::_gravar).
    async carimbarLinhaHash(id, hash) {
      await sql`update transacoes set linha_hash = ${hash} where id = ${id} and linha_hash is null`;
    },

    // associações aprendidas por nome, no formato que classificar() espera: dict chaveado por
    // normalizarNome(chave) -> { categoriaNome, subNome } (camelCase — espelha
    // tools/importar_extrato.py::carregar_associacoes, mas com chaves de valor em camelCase).
    async associacoesPorNome() {
      const rows = await sql`
        select a.chave, c.nome as categoria_nome, s.nome as sub_nome
        from associacoes a
        left join categorias c    on c.id = a.categoria_id
        left join subcategorias s on s.id = a.subcategoria_id
        where a.tipo_chave = 'nome'`;
      const dict = {};
      for (const r of rows) dict[normalizarNome(r.chave)] = { categoriaNome: r.categoria_nome, subNome: r.sub_nome };
      return dict;
    },
  };
}
