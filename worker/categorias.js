// Inc 2.5 Fase B: resolução nome→id e montagem de selects. Puro (sem banco/rede).
// O modelo devolve NOMES (macro/sub); ao gravar, resolvemos para ids do catálogo.
// catalogo = { categorias:[{id,nome}], subcategorias:[{id,categoria_id,nome}] }

// nome de categoria + sub → { categoria_id, subcategoria_id }.
// macro inexistente cai em 'Outros' (fallback); sub que não casa dentro da categoria → null.
export function resolverCategoria(nomeMacro, nomeSub, catalogo) {
  const cats = catalogo.categorias || [];
  let cat = cats.find(c => c.nome === nomeMacro);
  if (!cat) cat = cats.find(c => c.nome === "Outros"); // fallback
  const categoria_id = cat ? cat.id : null;            // defensivo: sem Outros → null

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

// nomes (categoria/subcategoria) a partir dos ids — p/ exibir na confirmação do Telegram.
export function nomesDeCategoria(catalogo, categoria_id, subcategoria_id) {
  const c = (catalogo.categorias || []).find(x => x.id === categoria_id);
  const s = (catalogo.subcategorias || []).find(x => x.id === subcategoria_id);
  return { categoria: c ? c.nome : null, subcategoria: s ? s.nome : null };
}
