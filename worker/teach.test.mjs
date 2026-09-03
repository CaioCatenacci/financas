import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAprender } from "./teach.js";

test("parseAprender lê '/aprender Categoria > Sub'", () => {
  assert.deepEqual(parseAprender("/aprender Educação > Inglês Particular"),
    { macro: "Educação", sub: "Inglês Particular" });
});

test("aceita o separador '›' (o que o app mostra), não só '>'", () => {
  assert.deepEqual(parseAprender("/aprender Educação › Inglês Particular"),
    { macro: "Educação", sub: "Inglês Particular" });
});

test("aceita sem subcategoria", () => {
  assert.deepEqual(parseAprender("/aprender Casa"), { macro: "Casa", sub: null });
});

test("ignora legenda que não é comando", () => {
  assert.equal(parseAprender("comprovante de pix"), null);
  assert.equal(parseAprender(""), null);
  assert.equal(parseAprender(undefined), null);
});
