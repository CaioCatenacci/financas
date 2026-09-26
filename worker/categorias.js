// Inc 2.5 Fase B: resolução nome→id e montagem de selects. Puro (sem banco/rede).
// O modelo devolve NOMES (macro/sub); ao gravar, resolvemos para ids do catálogo.
// catalogo = { categorias:[{id,nome}], subcategorias:[{id,categoria_id,nome}] }

// categoria padrão = onde cai o que ninguém classificou (modelo devolveu nome fora do catálogo,
// texto sem categoria, import sem regra). É marcada pela FLAG `padrao` (migração 0008), não pelo
// nome: em 25/09/2026 "Outros" foi renomeada na aba Ajustes e o fallback por nome literal passou a
// devolver null → not-null no insert → Telegram mudo. O nome "Outros" fica só como compatibilidade
// (catálogo sem flag, ex. fixtures antigas) — e hoje é miscelânea deliberada, não o padrão.
export function categoriaPadrao(catalogo) {
  const cats = catalogo.categorias || [];
  return cats.find(c => c.padrao) || cats.find(c => c.nome === "Outros") || null;
}

// nome de categoria + sub → { categoria_id, subcategoria_id }.
// macro inexistente/nula cai na categoria padrão; sub que não casa dentro da categoria → null.
export function resolverCategoria(nomeMacro, nomeSub, catalogo) {
  const cats = catalogo.categorias || [];
  let cat = cats.find(c => c.nome === nomeMacro);
  if (!cat) cat = categoriaPadrao(catalogo);
  const categoria_id = cat ? cat.id : null;            // defensivo: sem padrão → null (o chamador avisa)

  let subcategoria_id = null;
  if (categoria_id && nomeSub) {
    const sub = (catalogo.subcategorias || []).find(s => s.categoria_id === categoria_id && s.nome === nomeSub);
    if (sub) subcategoria_id = sub.id;
  }
  return { categoria_id, subcategoria_id };
}

// subs de uma categoria (para preencher o select de subcategoria), como {id,nome}.
export function subsDaCategoria(catalogo, categoria_id) {
  return (catalogo.subcategorias || [])
    .filter(s => s.categoria_id === categoria_id)
    .map(s => ({ id: s.id, nome: s.nome }));
}

// achata o catálogo p/ a lista {macro,sub,natureza} que o extrator (extrair.js) consome:
// uma linha por sub; categoria sem sub vira uma linha com sub null.
export function catalogoParaLista(catalogo) {
  const lista = [];
  for (const c of (catalogo.categorias || [])) {
    const subs = subsDaCategoria(catalogo, c.id);
    if (subs.length) for (const s of subs) lista.push({ macro: c.nome, sub: s.nome, natureza: c.natureza });
    else lista.push({ macro: c.nome, sub: null, natureza: c.natureza });
  }
  return lista;
}

// Natureza da transação ao reclassificar (regra aprovada em 25/09/2026, depois do salário movido
// pra "Receita" seguir como despesa): a natureza passa a SEGUIR a categoria — exceto créditos e
// estornos vindos de extrato/fatura (receita sob categoria de despesa), que são legítimos (o
// estorno de uma compra fica na categoria da loja) e ficam como estão. Sem natureza de categoria
// conhecida (id inválido), mantém a atual. Puro: entra tudo por parâmetro.
export function naturezaAoReclassificar(naturezaAtual, fonte, naturezaCategoria) {
  if (naturezaCategoria !== "receita" && naturezaCategoria !== "despesa") return naturezaAtual;
  if (naturezaCategoria === "receita") return "receita";
  const creditoBancario = naturezaAtual === "receita" && (fonte === "extrato" || fonte === "fatura");
  return creditoBancario ? "receita" : "despesa";
}

// nomes (categoria/subcategoria) a partir dos ids — p/ exibir na confirmação do Telegram.
export function nomesDeCategoria(catalogo, categoria_id, subcategoria_id) {
  const c = (catalogo.categorias || []).find(x => x.id === categoria_id);
  const s = (catalogo.subcategorias || []).find(x => x.id === subcategoria_id);
  return { categoria: c ? c.nome : null, subcategoria: s ? s.nome : null };
}
