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
