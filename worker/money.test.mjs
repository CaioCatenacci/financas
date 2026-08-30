import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBRtoCents, centsToBR, centsToNumeric } from "./money.js";

test("parseBRtoCents aceita formatos do teclado BR", () => {
  assert.equal(parseBRtoCents("R$ 1.234,56"), 123456);
  assert.equal(parseBRtoCents("1234,56"), 123456);
  assert.equal(parseBRtoCents("15,50"), 1550);
  assert.equal(parseBRtoCents("1.234"), 123400); // sem centavos
  assert.equal(parseBRtoCents("100"), 10000);
});

test("parseBRtoCents rejeita lixo e negativo", () => {
  assert.equal(parseBRtoCents("abc"), null);
  assert.equal(parseBRtoCents(""), null);
  assert.equal(parseBRtoCents("-5,00"), null);
});

test("centsToBR formata com ponto de milhar e vírgula decimal", () => {
  assert.equal(centsToBR(150550), "1.505,50");
  assert.equal(centsToBR(1550), "15,50");
  assert.equal(centsToBR(0), "0,00");
});

test("centsToNumeric produz string pronta p/ SQL", () => {
  assert.equal(centsToNumeric(150550), "1505.50");
  assert.equal(centsToNumeric(5), "0.05");
});
