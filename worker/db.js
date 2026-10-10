import { centsToNumeric } from "./money.js";
import { derivarChave, normalizarNome } from "./contraparte.js";
import { naturezaAoReclassificar } from "./categorias.js";

export function criarDb(sql) {
  // Builder da query de insert de transação. Reusado no insert único (captura) e no lote
  // transacional da importação — retorna a query SEM await (o await/transaction executa).
  const qInserirTransacao = (t) => sql`
    insert into transacoes
      (data, natureza, esfera, valor_total, valor_reembolso, categoria_id, subcategoria_id,
       descricao, pessoa_id, fonte, origem_categoria, extraido_por, confianca, documento_id,
       contraparte_nome, contraparte_chave, computa_resumo, linha_hash, grupo_id, representante)
    values
      (${t.dataISO}, ${t.natureza}, ${t.esfera}, ${centsToNumeric(t.valorCents)},
       ${centsToNumeric(t.reembolsoCents ?? 0)}, ${t.categoria_id ?? null}, ${t.subcategoria_id ?? null},
       ${t.descricao}, ${t.pessoa_id ?? null}, ${t.fonte}, ${t.origem_categoria},
       ${t.extraido_por ?? null}, ${t.confianca ?? null}, ${t.documento_id ?? null},
       ${t.contraparte_nome ?? null}, ${t.contraparte_chave ?? null},
       ${t.computa_resumo ?? true}, ${t.linha_hash ?? null}, ${t.grupo_id ?? null}, ${t.representante ?? false})
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
      const categorias = await sql`select id, nome, natureza, ativa, padrao from categorias where ativa order by nome`;
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
      // a natureza da categoria NOVA vem no mesmo SELECT (subselect com o id pedido; null se não
      // houver troca) — evita uma 2ª ida ao banco e alimenta naturezaAoReclassificar.
      const novaCat = c.categoria_id || null;
      const rows = await sql`
        select t.*, (select natureza from categorias where id = ${novaCat}::uuid) as nova_cat_natureza
        from transacoes t where t.id = ${id}`;
      const t = rows[0];
      if (!t) return;
      const data = c.dataISO ?? t.data;
      const categoria_id = c.categoria_id === undefined ? t.categoria_id : (c.categoria_id || null);
      const subcategoria_id = c.subcategoria_id === undefined ? t.subcategoria_id : (c.subcategoria_id || null);
      const pessoa_id = c.pessoa_id === undefined ? t.pessoa_id : (c.pessoa_id || null);
      const descricao = c.descricao === undefined ? t.descricao : (c.descricao || null);
      // natureza: explícita > segue a categoria nova (regra em categorias.js) > mantém
      const natureza = c.natureza ?? (novaCat ? naturezaAoReclassificar(t.natureza, t.fonte, t.nova_cat_natureza) : t.natureza);
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
          origem_categoria = case when ${setCat}::boolean     then 'manual'          else origem_categoria end,
          -- natureza segue a categoria nova (mesma regra de naturezaAoReclassificar, em SQL porque é
          -- um UPDATE só): receita → receita; despesa → despesa, salvo crédito/estorno de extrato/fatura
          natureza = case when ${setCat}::boolean then
            (case when (select natureza from categorias where id = ${catId}::uuid) = 'receita' then 'receita'
                  when natureza = 'receita' and fonte in ('extrato','fatura') then 'receita'
                  when (select natureza from categorias where id = ${catId}::uuid) = 'despesa' then 'despesa'
                  else natureza end)
            else natureza end
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

    // ---- B2: painel de regras aprendidas (aba Ajustes) ----
    // macro/sub saíram da tabela: os nomes vêm do join por id. A chave vai inteira (é a PK,
    // o painel precisa dela p/ editar/remover); quem mascara a pix_cpf é a tela.
    async listarAssociacoes() {
      return await sql`
        select a.chave, a.tipo_chave, a.categoria_id, c.nome as categoria,
               a.subcategoria_id, s.nome as subcategoria, a.n, a.atualizado_em
        from associacoes a
        left join categorias c    on c.id = a.categoria_id
        left join subcategorias s on s.id = a.subcategoria_id
        order by a.atualizado_em desc, a.chave`;
    },
    // Editar no painel NÃO passa por upsertAssociacao: aquele incrementa n (é "mais uma
    // confirmação"); corrigir a regra à mão mantém o contador (decisão de 27/09/2026).
    async editarAssociacao({ chave, tipo_chave, categoria_id, subcategoria_id }) {
      const rows = await sql`
        update associacoes
        set categoria_id = ${categoria_id}, subcategoria_id = ${subcategoria_id ?? null}, atualizado_em = now()
        where chave = ${chave} and tipo_chave = ${tipo_chave}
        returning chave`;
      return { alterados: rows.length };
    },
    async apagarAssociacao(chave, tipo_chave) {
      const rows = await sql`
        delete from associacoes
        where chave = ${chave} and tipo_chave = ${tipo_chave}
        returning chave`;
      return { apagados: rows.length };
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
      // a padrão nunca sai do catálogo: sem ela o fallback de resolverCategoria volta a dar null
      await sql`update categorias set ativa = false where id = ${id} and not padrao`;
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

    // ---- resumos ---- (join p/ nomes; apelidam c.nome as macro p/ manter a forma que os gráficos usam)
    // Inc 4.6: filtram por conta_no_resumo (coluna gerada: computa_resumo AND (sem grupo OU
    // representante)) — um membro de grupo nunca conta, mesmo com computa_resumo=true.
    async resumoPorCategoria(de, ate) {
      return await sql`
        select c.nome as macro, s.nome as sub, t.natureza, sum(t.valor_final) as total, count(*) as n
        from transacoes t
        left join categorias c    on c.id = t.categoria_id
        left join subcategorias s on s.id = t.subcategoria_id
        where t.data >= ${de} and t.data <= ${ate} and t.conta_no_resumo
        group by c.nome, s.nome, t.natureza order by total desc`;
    },

    async resumoKPIs(de, ate) {
      const rows = await sql`
        select
          coalesce(sum(valor_final) filter (where natureza = 'receita'), 0) as receita,
          coalesce(sum(valor_final) filter (where natureza = 'despesa'), 0) as despesa,
          coalesce(sum(valor_reembolso), 0) as reembolso
        from transacoes where data >= ${de} and data <= ${ate} and conta_no_resumo`;
      return rows[0];
    },

    async resumoDiario(de, ateExcl) {
      const rows = await sql`
        select to_char(data,'YYYY-MM-DD') as dia,
               (round(sum(valor_final)*100))::bigint as total_cents
        from transacoes
        where natureza = 'despesa' and conta_no_resumo
          and data >= ${de} and data < ${ateExcl}
        group by 1 order by 1`;
      // driver do Neon devolve ::bigint como string — converte na borda para operações numéricas.
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
        where t.natureza = 'despesa' and t.conta_no_resumo
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
        where t.valor_reembolso > 0 and t.conta_no_resumo
        group by 1, 2 order by 1, 2`;
    },

    async resumoPorPessoa(de, ate) {
      return await sql`
        select coalesce(p.nome, '—') as pessoa, t.natureza, sum(t.valor_final) as total
        from transacoes t
        left join pessoas p on p.id = t.pessoa_id
        where t.data >= ${de} and t.data <= ${ate} and t.conta_no_resumo
        group by 1, 2
        order by 3 desc`;
    },

    // D6: sunburst pessoa → categoria. Só despesa que conta (mesmo filtro de resumoKPIs) e
    // left join nos dois lados: assim o conjunto de linhas é o mesmo da despesa dos KPIs e o
    // anel interno fecha com ela. Despesa sem pessoa_id vira a fatia "sem pessoa" (visível de
    // propósito, Decisão 2026-09-28). Centavos arredondados em SQL; ::bigint chega string do
    // driver e vira number na borda.
    async resumoPorPessoaCategoria(de, ate) {
      const rows = await sql`
        select coalesce(p.nome, 'sem pessoa') as pessoa, c.nome as categoria,
               (round(sum(t.valor_final)*100))::bigint as total_cents
        from transacoes t
        left join pessoas p    on p.id = t.pessoa_id
        left join categorias c on c.id = t.categoria_id
        where t.natureza = 'despesa' and t.conta_no_resumo
          and t.data >= ${de} and t.data <= ${ate}
        group by 1, 2
        order by 3 desc`;
      return rows.map(r => ({ ...r, total_cents: Number(r.total_cents) }));
    },


    // ---- G1: salário por competência ----
    // baseline com vigência (mesmo modelo de metas): ::bigint chega string do driver → Number na borda.
    async salarioParams() {
      const rows = await sql`
        select to_char(vigente_desde,'YYYY-MM-01') as vigente_desde, usd_cents
        from salario_param
        order by vigente_desde`;
      return rows.map(r => ({ vigente_desde: r.vigente_desde, usd_cents: Number(r.usd_cents) }));
    },

    async setSalarioParam(mesDia01, usdCents) {
      await sql`
        insert into salario_param (vigente_desde, usd_cents)
        values (${mesDia01}, ${usdCents})
        on conflict (vigente_desde) do update set usd_cents = excluded.usd_cents`;
    },

    // todas as conversões (Wise + carga Nomad): a alocação FIFO roda em worker/salario.js, que
    // precisa da sequência inteira — não dá pra recortar por mês sem mudar o resultado.
    async conversoes() {
      const rows = await sql`
        select id, to_char(data,'YYYY-MM-DD') as data, usd_cents, brl_cents, origem
        from conversoes
        order by data, criado_em`;
      return rows.map(r => ({ ...r, usd_cents: Number(r.usd_cents), brl_cents: Number(r.brl_cents) }));
    },

    // dedup do CSV da Wise: por igualdade de linha_hash (sha256 do TransferWise ID)
    async conversoesHashes(chaves) {
      if (!chaves || !chaves.length) return [];
      const rows = await sql`
        select linha_hash from conversoes where linha_hash = any(${chaves})`;
      return rows.map(r => r.linha_hash);
    },

    // lote numa transação; on conflict do nothing = aplicar o mesmo CSV duas vezes não duplica
    async inserirConversoes(lista) {
      if (!lista || !lista.length) return { gravados: 0 };
      const queries = lista.map(c => sql`
        insert into conversoes (data, usd_cents, brl_cents, origem, linha_hash)
        values (${c.data}, ${c.usd_cents}, ${c.brl_cents}, ${c.origem || 'wise'}, ${c.linhaHash})
        on conflict (linha_hash) do nothing`);
      await sql.transaction(queries);
      return { gravados: lista.length };
    },

    // receita (sem o salário, que vem de alocarSalario) e despesa que contam, por mês, na janela
    // meio-aberta [de, ateExcl). Soma em SQL, centavos inteiros, filtro por conta_no_resumo.
    async saldoPorMes(de, ateExcl) {
      const rows = await sql`
        select to_char(data,'YYYY-MM') as mes,
               (round(coalesce(sum(valor_final) filter (where natureza = 'receita'), 0)*100))::bigint as receita_cents,
               (round(coalesce(sum(valor_final) filter (where natureza = 'despesa'), 0)*100))::bigint as despesa_cents
        from transacoes
        where conta_no_resumo and data >= ${de} and data < ${ateExcl}
        group by to_char(data,'YYYY-MM')
        order by 1`;
      return rows.map(r => ({ mes: r.mes, receita_cents: Number(r.receita_cents), despesa_cents: Number(r.despesa_cents) }));
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
        where t.natureza = 'despesa' and t.conta_no_resumo
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

    // ---- Inc 4.6: grupos (duplicatas explícitas com representante) ----
    // As três leituras devolvem a forma mínima que worker/grupos.js consome. Quem decide é o
    // módulo puro; aqui só se lê e se grava.
    async transacoesPorIds(ids) {
      if (!ids || !ids.length) return [];
      return await sql`
        select id, fonte, criado_em, grupo_id, representante, valor_final
        from transacoes where id = any(${ids}::uuid[])`;
    },

    async membrosDoGrupo(grupo_id) {
      return await sql`
        select id, fonte, criado_em, grupo_id, representante, valor_final
        from transacoes where grupo_id = ${grupo_id} order by criado_em`;
    },

    // F2: membros de vários grupos numa query só (a conferência da prévia do import).
    async membrosDosGrupos(grupoIds) {
      if (!grupoIds || !grupoIds.length) return [];
      return await sql`
        select id, fonte, criado_em, grupo_id, representante, valor_final
        from transacoes where grupo_id = any(${grupoIds}::uuid[])`;
    },

    // membros do grupo da transação (ela inclusa); [] quando ela não tem grupo.
    async grupoDaTransacao(id) {
      return await sql`
        select id, fonte, criado_em, grupo_id, representante, valor_final
        from transacoes
        where grupo_id = (select grupo_id from transacoes where id = ${id}) and grupo_id is not null
        order by criado_em`;
    },

    // Grava a lista de mudanças de grupos.js NA ORDEM (o índice único de representante exige
    // tirar antes de pôr) e, se pedido, apaga uma transação — tudo numa única sql.transaction
    // (1 subrequest, atômica: ou o grupo fica consistente ou nada muda).
    async gravarGrupo({ mudancas = [], apagarId = null } = {}) {
      const queries = mudancas.map((m) => sql`
        update transacoes set grupo_id = ${m.grupo_id}, representante = ${m.representante} where id = ${m.id}`);
      if (apagarId) queries.push(sql`delete from transacoes where id = ${apagarId}`);
      if (queries.length) await sql.transaction(queries);
      return { alterados: mudancas.length, apagados: apagarId ? 1 : 0 };
    },

    // ---- apoio à importação: consultas de reconciliação ----
    // Candidatas ao casamento do import (Inc 4.6): lançamentos do Caio (não extrato/fatura), sem
    // hash antigo carimbado (= já conciliado no modelo velho) e que não estejam num grupo que já
    // tem uma linha de extrato (um lançamento casa com o banco UMA vez). Devolve grupo_id pra o
    // app decidir "entra no grupo existente" vs "grupo novo".
    async transacoesNaJanela(de, ate) {
      const rows = await sql`
        select id, to_char(data,'YYYY-MM-DD') as data,
          (round(valor_final*100))::bigint as valor_cents, grupo_id, descricao, representante
        from transacoes t
        where data between ${de} and ${ate}
          and fonte not in ('extrato','fatura')
          and linha_hash is null
          and not exists (select 1 from transacoes x where x.grupo_id = t.grupo_id and x.fonte = 'extrato')`;
      // descricao (C2): o ambíguo lista os candidatos na aba Importar, e o Caio precisa distingui-los.
      // representante (F1): o candidato-grupo leva a descrição de quem conta, se ele estiver na janela.
      return rows.map(r => ({ id: String(r.id), data: r.data, descricao: r.descricao ?? null, valorCents: Number(r.valor_cents), grupo_id: r.grupo_id ?? null, representante: !!r.representante }));
    },

    // C8: dedup da fatura por IGUALDADE de linha_hash (chaves nova e antiga calculadas antes). Não
    // usa janela de data: a linha corrigida pela 0010 fica um ano antes da data da chave antiga.
    async hashesExistentes(chaves) {
      if (!chaves || !chaves.length) return [];
      const rows = await sql`
        select linha_hash
        from transacoes
        where linha_hash = any(${chaves})`;
      return rows.map(r => r.linha_hash);
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
    // Inc 4.6: um "casado" não carimba mais o hash no lançamento do Caio — INSERE a linha do
    // extrato (com o hash, dentro do grupo, sem ser representante) e, se o grupo é novo, põe o
    // lançamento casado como representante. Se ele já estava num grupo, só a linha entra nele.
    async aplicarImportacao({ novos = [], naoGasto = [], casados = [] }) {
      const queries = [];
      for (const t of [...novos, ...naoGasto]) queries.push(qInserirTransacao(t));
      for (const c of casados) {
        queries.push(qInserirTransacao(c.linha));
        if (!c.grupoExistente) {
          queries.push(sql`update transacoes set grupo_id = ${c.linha.grupo_id}, representante = true where id = ${c.matchId} and grupo_id is null`);
        }
      }
      if (queries.length) await sql.transaction(queries);
      return { gravados: novos.length + naoGasto.length, agrupados: casados.length, naoGasto: naoGasto.length };
    },

    // Marca o pagamento da fatura no extrato como fora do resumo (computa_resumo=false): procura
    // UMA despesa de extrato que ainda CONTA no resumo (conta_no_resumo) cujo valor bata com o
    // total da fatura, dentro de [de,ate]. Espelha tools/importar_fatura.py: 1 candidato → marca;
    // 0 ou >1 → não mexe (devolve a contagem p/ quem chama avisar). Sem isso, os itens da fatura +
    // o pagamento no extrato contariam o gasto do cartão duas vezes no Resumo.
    // Fase B (Inc 4.6): filtra por conta_no_resumo, não computa_resumo=true — uma linha de extrato
    // que já está DENTRO de um grupo tem computa_resumo=true mas conta_no_resumo=false (quem conta
    // é o representante). Marcar computa_resumo nela não evita dupla contagem nenhuma; o candidato
    // certo é sempre a linha que hoje soma no card.
    // C3 (idempotência): o select traz também as despesas de extrato de mesmo total, na mesma
    // janela, que já estão FORA do resumo (computa_resumo=false). Se existe uma, o pagamento já
    // foi marcado — por uma aplicação anterior desta fatura ou pelo import do extrato (naoGasto) —
    // e não se mexe em nada: sem isso, a reaplicação via o pagamento sumir do select e tirava do
    // resumo outra despesa de mesmo total que caísse na janela. Sem vínculo fatura→pagamento no
    // schema, esse é o único sinal; uma linha de mesmo total tirada do resumo à mão também bloqueia
    // (conservador: não marca, e o app avisa pra ajustar à mão).
    async marcarPagamentoFaturaNaoGasto(totalCents, de, ate) {
      const rows = await sql`
        select id, computa_resumo, conta_no_resumo from transacoes
        where fonte = 'extrato' and natureza = 'despesa'
          and (conta_no_resumo = true or computa_resumo = false)
          and (round(valor_final*100))::bigint = ${totalCents}
          and data between ${de} and ${ate}`;
      const jaMarcados = rows.filter((r) => r.computa_resumo === false);
      const candidatos = rows.filter((r) => r.computa_resumo !== false);
      if (jaMarcados.length) return { marcados: 0, candidatos: candidatos.length, jaMarcado: true };
      if (candidatos.length === 1) {
        await sql`update transacoes set computa_resumo = false where id = ${candidatos[0].id}`;
        return { marcados: 1, candidatos: 1 };
      }
      return { marcados: 0, candidatos: candidatos.length };
    },

    // C1 — as duas pontas do repasse entre contas próprias. A saída Pix do C6 para conta própria
    // já entra fora do resumo (computa_resumo=false, decidido no preview pela lista do secret
    // CONTAS_PROPRIAS); a chegada dela no Itaú também tem que sair, senão o repasse vira receita.
    // Roda depois de aplicar QUALQUER extrato (C6 ou Itaú), sobre a janela importada, então serve
    // às duas ordens: o C6 depois do Itaú acha a entrada já gravada; o Itaú depois do C6 acha o
    // repasse já gravado.
    // O banco é reconhecido pelo formato da descrição, sem coluna nova: "Pix enviado para …" é o
    // C6; "PIX TRANSF …" é o Itaú. Do lado do Itaú não se compara nome nenhum (lá ele vem cortado,
    // e a chegada da Wise e o repasse têm a mesma cara) — só valor exato e ±3 dias. Por isso uma
    // entrada da Wise no próprio C6 ("Pix recebido de …") nunca é candidata.
    // Mesma disciplina de marcarPagamentoFaturaNaoGasto: 1 candidato marca; 0 ou >1 não mexe e
    // volta como aviso; uma entrada do Itaú de mesmo valor na janela que já está fora do resumo
    // conta como já marcada (reimportar não tira outra linha do resumo).
    async marcarRepassesEntreContas(de, ate) {
      const desloca = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
      const repasses = await sql`
        select id, to_char(data,'YYYY-MM-DD') as data, (round(valor_final*100))::bigint as valor_cents
        from transacoes
        where fonte = 'extrato' and natureza = 'despesa' and computa_resumo = false
          and descricao ilike 'Pix enviado para %'
          and data between ${de} and ${ate}
        order by data, id`;
      let marcados = 0, jaMarcados = 0;
      const avisos = [];
      const usados = new Set(); // um repasse marca uma entrada; a mesma entrada não serve a dois
      for (const r of repasses) {
        const valorCents = Number(r.valor_cents);
        const rows = await sql`
          select id, computa_resumo from transacoes
          where fonte = 'extrato' and natureza = 'receita'
            and descricao ilike 'PIX TRANSF %'
            and (conta_no_resumo = true or computa_resumo = false)
            and (round(valor_final*100))::bigint = ${valorCents}
            and data between ${desloca(r.data, -3)} and ${desloca(r.data, 3)}`;
        const ja = rows.filter((x) => x.computa_resumo === false && !usados.has(String(x.id)));
        const cand = rows.filter((x) => x.computa_resumo !== false);
        if (ja.length) { usados.add(String(ja[0].id)); jaMarcados++; continue; }
        if (cand.length === 1) {
          await sql`update transacoes set computa_resumo = false where id = ${cand[0].id}`;
          usados.add(String(cand[0].id));
          marcados++;
          continue;
        }
        avisos.push({ data: r.data, valorCents, candidatos: cand.length });
      }
      return { marcados, jaMarcados, avisos };
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
