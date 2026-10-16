import { test } from "node:test";
import assert from "node:assert/strict";
import { casarLegenda, legendaDeCategoria, normalizarLegenda } from "./legenda.js";

// Catálogo inventado (nada do catálogo real): cobre os três passos e as armadilhas que o PM achou —
// "Outros" repetida em várias categorias, a genérica com o nome da própria categoria (Compras ›
// Compras), sub de nome repetido, sub e categoria inativas e a categoria padrão.
const catalogo = {
  categorias: [
    { id: "cCasa", nome: "Casa", natureza: "despesa" },
    { id: "cAli", nome: "Alimentação", natureza: "despesa" },
    { id: "cCompras", nome: "Compras", natureza: "despesa" },
    { id: "cOut", nome: "Outros", natureza: "despesa" },
    { id: "cEdu", nome: "Educação", natureza: "despesa" },
    { id: "cVelha", nome: "Velharia", natureza: "despesa", ativa: false },
    { id: "cNI", nome: "Não Identificado", natureza: "despesa", padrao: true },
  ],
  subcategorias: [
    { id: "sAlug", categoria_id: "cCasa", nome: "Aluguel" },
    { id: "sLuz", categoria_id: "cCasa", nome: "Luz" },
    { id: "sCasaOut", categoria_id: "cCasa", nome: "Outros" },
    { id: "sMerc", categoria_id: "cAli", nome: "Mercado" },
    { id: "sAliOut", categoria_id: "cAli", nome: "Outros" },
    { id: "sCompras", categoria_id: "cCompras", nome: "Compras" },
    { id: "sRoupa", categoria_id: "cCompras", nome: "Roupa" },
    { id: "sCursoE", categoria_id: "cEdu", nome: "Curso" },
    { id: "sCursoC", categoria_id: "cCompras", nome: "Curso" },
    { id: "sAntiga", categoria_id: "cCasa", nome: "Gás", ativa: false },
    { id: "sVelha", categoria_id: "cVelha", nome: "Sucata" },
  ],
};

test("normaliza acento, maiúscula e espaços: o teclado do celular não é confiável", () => {
  assert.equal(normalizarLegenda("  ALIMENTAÇÃO   e  Cia "), "alimentacao e cia");
});

test("passo 1: 'Categoria › Sub' casa o par exato", () => {
  assert.deepEqual(casarLegenda("Casa › Aluguel", catalogo), { categoria_id: "cCasa", subcategoria_id: "sAlug" });
});

test("passo 1: '>' vale como separador (é o que dá para digitar)", () => {
  assert.deepEqual(casarLegenda("casa>aluguel", catalogo), { categoria_id: "cCasa", subcategoria_id: "sAlug" });
});

test("passo 1: sub de outra categoria não é casamento do par e o resto não casa", () => {
  // Casa › Mercado não existe; a string inteira não é sub nem categoria → null (vai ao JEV)
  assert.equal(casarLegenda("Casa › Mercado", catalogo), null);
});

test("passo 1: sub inativa não casa", () => {
  assert.equal(casarLegenda("Casa › Gás", catalogo), null);
});

test("passo 2: sub de nome único casa categoria e sub", () => {
  assert.deepEqual(casarLegenda("aluguel", catalogo), { categoria_id: "cCasa", subcategoria_id: "sAlug" });
});

test("acento e maiúscula: 'MERCADO' e 'alimentacao › mercado' casam", () => {
  assert.deepEqual(casarLegenda("MERCADO", catalogo), { categoria_id: "cAli", subcategoria_id: "sMerc" });
  assert.deepEqual(casarLegenda("alimentacao › mercado", catalogo), { categoria_id: "cAli", subcategoria_id: "sMerc" });
});

test("passo 2: sub de nome repetido em duas categorias não casa (vai ao JEV)", () => {
  assert.equal(casarLegenda("Curso", catalogo), null);
});

test("passo 3: nome de categoria casa só a categoria (a sub fica para o fluxo)", () => {
  assert.deepEqual(casarLegenda("Alimentação", catalogo), { categoria_id: "cAli", subcategoria_id: null });
});

test("'Outros' sozinho é a categoria Outros: é sub repetida, então cai no passo 3", () => {
  assert.deepEqual(casarLegenda("outros", catalogo), { categoria_id: "cOut", subcategoria_id: null });
});

test("'Compras' não casa a genérica Compras › Compras no passo 2: vai à categoria pelo passo 3", () => {
  // o Caio vetou gravar a genérica por padrão; a sub é escolhida depois, como em "Casa"
  assert.deepEqual(casarLegenda("Compras", catalogo), { categoria_id: "cCompras", subcategoria_id: null });
});

test("a categoria padrão nunca é alvo, nem escrita pelo nome", () => {
  assert.equal(casarLegenda("Não Identificado", catalogo), null);
  assert.equal(casarLegenda("nao identificado", catalogo), null);
});

test("categoria inativa e sub de categoria inativa não casam", () => {
  assert.equal(casarLegenda("Velharia", catalogo), null);
  assert.equal(casarLegenda("Sucata", catalogo), null);
});

test("legenda vazia ou sem casamento devolve null", () => {
  assert.equal(casarLegenda("", catalogo), null);
  assert.equal(casarLegenda("xpto", catalogo), null);
});

test("legendaDeCategoria: vazia, só espaços ou comando ('/...') não é legenda de categoria", () => {
  assert.equal(legendaDeCategoria(undefined), null);
  assert.equal(legendaDeCategoria(null), null);
  assert.equal(legendaDeCategoria("   "), null);
  assert.equal(legendaDeCategoria("/qualquer coisa"), null);
  assert.equal(legendaDeCategoria("  /aprender Casa"), null);
  assert.equal(legendaDeCategoria("  Aluguel "), "Aluguel");
});
