// H6 — a legenda do comprovante (foto/PDF no Telegram) vira a categoria. Puro: sem banco, sem rede.
//
// A legenda é decisão do Caio, então o casamento é exato (sem modelo) e conservador, nesta ordem:
//   1. "Categoria › Sub" (ou "Categoria > Sub"), com as duas ativas e a sub daquela categoria;
//   2. nome de sub ativa que existe numa ÚNICA categoria — e que não é a genérica de mesmo nome
//      da categoria (Compras › Compras): o Caio vetou gravar a genérica por padrão, então
//      "Compras" vai ao passo 3, como "Casa";
//   3. nome de categoria ativa (inclusive "Outros", miscelânea deliberada).
// A categoria padrão (a fila de triagem) nunca é alvo: escrevê-la seria o mesmo que não escrever.
// Quem não casa aqui vai ao JEV, no fluxo do Telegram (worker/index.js).

const ativa = (x) => x.ativa !== false;

/** Sem acento, minúsculo, espaços colapsados: o teclado do celular não é confiável. */
export function normalizarLegenda(s) {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** A legenda que pode ser categoria, aparada; null se vazia ou se é comando ("/aprender",
 *  "/patrimonio" e qualquer outro "/..."), que nunca é categoria. */
export function legendaDeCategoria(caption) {
  if (typeof caption !== "string") return null;
  const t = caption.trim();
  if (!t || t.startsWith("/")) return null;
  return t;
}

/**
 * Casa a legenda com o catálogo. Devolve `{categoria_id, subcategoria_id}` (sub null quando casou
 * só a categoria, no passo 3) ou null.
 */
export function casarLegenda(legenda, catalogo) {
  const alvo = normalizarLegenda(legenda);
  if (!alvo) return null;
  const cats = (catalogo.categorias || []).filter((c) => ativa(c) && !c.padrao);
  const porId = new Map(cats.map((c) => [c.id, c]));
  // só subs ativas de categorias elegíveis (ativa e não padrão)
  const subs = (catalogo.subcategorias || []).filter((s) => ativa(s) && porId.has(s.categoria_id));

  // 1. "Categoria › Sub"
  const sep = alvo.search(/[›>]/);
  if (sep >= 0) {
    const nc = alvo.slice(0, sep).trim(), ns = alvo.slice(sep + 1).trim();
    const c = cats.find((x) => normalizarLegenda(x.nome) === nc);
    const s = c && subs.find((x) => x.categoria_id === c.id && normalizarLegenda(x.nome) === ns);
    if (s) return { categoria_id: c.id, subcategoria_id: s.id };
  }

  // 2. sub de nome único. A unicidade conta todas as categorias com essa sub (inclusive a de
  //    mesmo nome): se o nome é ambíguo, não é casamento de sub.
  const comNome = subs.filter((s) => normalizarLegenda(s.nome) === alvo);
  if (comNome.length && new Set(comNome.map((s) => s.categoria_id)).size === 1) {
    const s = comNome[0];
    if (normalizarLegenda(porId.get(s.categoria_id).nome) !== alvo) {
      return { categoria_id: s.categoria_id, subcategoria_id: s.id };
    }
  }

  // 3. nome de categoria
  const c = cats.find((x) => normalizarLegenda(x.nome) === alvo);
  return c ? { categoria_id: c.id, subcategoria_id: null } : null;
}
