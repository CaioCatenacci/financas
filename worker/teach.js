// Reconhece a legenda de ensino: "/aprender <Categoria> > <Subcategoria>".
// Por quê: ensinar a associação sem criar transação (dry-run), varrendo o backlog.
export function parseAprender(caption) {
  if (!caption || typeof caption !== "string") return null;
  const m = caption.trim().match(/^\/aprender\s+(.+)$/i);
  if (!m) return null;
  const [macro, sub] = m[1].split(">").map((s) => s.trim());
  if (!macro) return null;
  return { macro, sub: sub || null };
}
