import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizarDescritor, reconhecerNaoGasto, classificar } from "./classificar.js";
import { normalizarNome } from "./contraparte.js";

test("normalizarDescritor colapsa o mesmo estabelecimento entre meses", () => {
  assert.equal(normalizarDescritor("PIX QRS AMAZON.COM.30/12"), normalizarDescritor("PIX QRS AMAZON.COM.28/11"));
});

test("reconhece não-gasto", () => {
  assert.equal(reconhecerNaoGasto("PIX TRANSF CAIO CA10/12"), "Transferências");
  assert.equal(reconhecerNaoGasto("APLICACAO PERSONDIF INT"), "Investimentos");
  assert.equal(reconhecerNaoGasto("PIX QRS MAGALUPAY10/12"), null);
});

test("classificar não-gasto marca flag+categoria org", () => {
  const r = classificar("PIX TRANSF CAIO CA10/12", {});
  assert.equal(r.computaResumo, false);
  assert.equal(r.categoriaOrg, "Transferências");
});

test("classificar gasto usa associação por normalizarNome(descritor)", () => {
  const chave = normalizarNome(normalizarDescritor("PIX QRS MAGALUPAY10/12"));
  const r = classificar("PIX QRS MAGALUPAY10/12", { [chave]: { categoriaNome: "Casa", subNome: "Mercado" } });
  assert.equal(r.categoriaNome, "Casa");
  assert.equal(r.subNome, "Mercado");
  assert.equal(r.computaResumo, true);
});

test("gasto sem associação → categoria null", () => {
  assert.equal(classificar("PIX QRS DESCONHECIDO01/01", {}).categoriaNome, null);
});
