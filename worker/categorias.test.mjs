import { test } from "node:test";
import assert from "node:assert/strict";
import { resolverCategoria, subsDaCategoria, catalogoParaLista, nomesDeCategoria, categoriaPadrao, naturezaAoReclassificar } from "./categorias.js";

// catálogo de teste: 2 categorias + 2 subs + fallback Outros
const catalogo = {
  categorias: [
    { id: "cE", nome: "Educação", natureza: "despesa" },
    { id: "cS", nome: "Saúde", natureza: "despesa" },
    { id: "cO", nome: "Outros", natureza: "despesa" },
  ],
  subcategorias: [
    { id: "sEsc", categoria_id: "cE", nome: "Escola" },
    { id: "sIdi", categoria_id: "cE", nome: "Idiomas" },
    { id: "sPla", categoria_id: "cS", nome: "Plano de saúde" },
  ],
};

test("resolverCategoria: nome de categoria+sub existentes → ids", () => {
  assert.deepEqual(resolverCategoria("Educação", "Escola", catalogo), { categoria_id: "cE", subcategoria_id: "sEsc" });
});

test("resolverCategoria: categoria existe, sub não casa → subcategoria_id null", () => {
  assert.deepEqual(resolverCategoria("Educação", "Inexistente", catalogo), { categoria_id: "cE", subcategoria_id: null });
});

test("resolverCategoria: categoria existe, sub vazia/null → subcategoria_id null", () => {
  assert.deepEqual(resolverCategoria("Saúde", null, catalogo), { categoria_id: "cS", subcategoria_id: null });
  assert.deepEqual(resolverCategoria("Saúde", "", catalogo), { categoria_id: "cS", subcategoria_id: null });
});

test("resolverCategoria: macro inexistente → cai em Outros (sub null)", () => {
  assert.deepEqual(resolverCategoria("Marte", "Foguete", catalogo), { categoria_id: "cO", subcategoria_id: null });
});

test("resolverCategoria: sub só casa dentro da categoria certa (não vaza entre categorias)", () => {
  // "Plano de saúde" pertence a Saúde; pedir sob Educação não deve casar
  assert.deepEqual(resolverCategoria("Educação", "Plano de saúde", catalogo), { categoria_id: "cE", subcategoria_id: null });
});

test("resolverCategoria: sem Outros no catálogo e macro inexistente → categoria_id null (defensivo)", () => {
  const semOutros = { categorias: [{ id: "cE", nome: "Educação" }], subcategorias: [] };
  assert.deepEqual(resolverCategoria("Marte", null, semOutros), { categoria_id: null, subcategoria_id: null });
});

test("subsDaCategoria: devolve só as subs da categoria, como {id,nome}", () => {
  assert.deepEqual(subsDaCategoria(catalogo, "cE"), [{ id: "sEsc", nome: "Escola" }, { id: "sIdi", nome: "Idiomas" }]);
  assert.deepEqual(subsDaCategoria(catalogo, "cS"), [{ id: "sPla", nome: "Plano de saúde" }]);
  assert.deepEqual(subsDaCategoria(catalogo, "cO"), []);
});

test("catalogoParaLista: uma linha por sub; categoria sem sub vira sub null", () => {
  const lista = catalogoParaLista(catalogo);
  assert.deepEqual(lista, [
    { macro: "Educação", sub: "Escola", natureza: "despesa" },
    { macro: "Educação", sub: "Idiomas", natureza: "despesa" },
    { macro: "Saúde", sub: "Plano de saúde", natureza: "despesa" },
    { macro: "Outros", sub: null, natureza: "despesa" },
  ]);
});

test("nomesDeCategoria: resolve ids -> nomes; ids ausentes -> null", () => {
  assert.deepEqual(nomesDeCategoria(catalogo, "cE", "sEsc"), { categoria: "Educação", subcategoria: "Escola" });
  assert.deepEqual(nomesDeCategoria(catalogo, "cS", null), { categoria: "Saúde", subcategoria: null });
  assert.deepEqual(nomesDeCategoria(catalogo, "xxx", "yyy"), { categoria: null, subcategoria: null });
});

// ---- categoria padrão por FLAG, não por nome ----
// Bug de 25/09/2026: "Outros" foi renomeada na aba Ajustes pra "Não Identificado" e o fallback
// por nome literal devolveu categoria_id null → not-null no insert → Telegram mudo (500).
// A partir daqui o padrão é a categoria com `padrao=true`; "Outros" volta a ser miscelânea
// deliberada (o Caio escolhe), e "Não Identificado" é o que precisa de triagem.
const comPadrao = {
  categorias: [
    { id: "cE", nome: "Educação", natureza: "despesa", padrao: false },
    { id: "cO", nome: "Outros", natureza: "despesa", padrao: false },
    { id: "cNI", nome: "Não Identificado", natureza: "despesa", padrao: true },
  ],
  subcategorias: [],
};

test("categoriaPadrao: devolve a categoria com flag padrao, mesmo existindo Outros", () => {
  assert.equal(categoriaPadrao(comPadrao).id, "cNI");
});

test("categoriaPadrao: sem flag no catálogo, cai no nome Outros (compatibilidade)", () => {
  assert.equal(categoriaPadrao(catalogo).id, "cO");
});

test("categoriaPadrao: sem flag nem Outros → null", () => {
  assert.equal(categoriaPadrao({ categorias: [{ id: "cE", nome: "Educação" }] }), null);
});

test("resolverCategoria: macro inexistente ou nula cai na padrão (flag), não em Outros", () => {
  assert.deepEqual(resolverCategoria("Marte", null, comPadrao), { categoria_id: "cNI", subcategoria_id: null });
  assert.deepEqual(resolverCategoria(null, null, comPadrao), { categoria_id: "cNI", subcategoria_id: null });
});

test("resolverCategoria: 'Outros' pedido explicitamente resolve pra Outros (miscelânea deliberada)", () => {
  assert.deepEqual(resolverCategoria("Outros", null, comPadrao), { categoria_id: "cO", subcategoria_id: null });
});

// ---- natureza ao reclassificar (bug 25/09/2026: salário movido p/ "Receita" seguiu como despesa) ----
// Regra aprovada: a natureza passa a seguir a categoria, EXCETO créditos/estornos de extrato/fatura
// (receita sob categoria de despesa), que são legítimos e ficam como estão.
test("naturezaAoReclassificar: categoria de receita → receita (o caso do salário)", () => {
  assert.equal(naturezaAoReclassificar("despesa", "manual", "receita"), "receita");
});

test("naturezaAoReclassificar: categoria de despesa → despesa p/ lançamento manual/imagem", () => {
  assert.equal(naturezaAoReclassificar("receita", "manual", "despesa"), "despesa");
  assert.equal(naturezaAoReclassificar("despesa", "imagem", "despesa"), "despesa");
});

test("naturezaAoReclassificar: crédito/estorno de extrato ou fatura fica receita sob categoria de despesa", () => {
  assert.equal(naturezaAoReclassificar("receita", "extrato", "despesa"), "receita");
  assert.equal(naturezaAoReclassificar("receita", "fatura", "despesa"), "receita");
});

test("naturezaAoReclassificar: sem natureza de categoria conhecida → mantém a atual", () => {
  assert.equal(naturezaAoReclassificar("despesa", "manual", null), "despesa");
  assert.equal(naturezaAoReclassificar("receita", "manual", undefined), "receita");
});
