import { test } from "node:test";
import assert from "node:assert/strict";
import { resolverCategoria, subsDaCategoria, catalogoParaLista, nomesDeCategoria } from "./categorias.js";

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
