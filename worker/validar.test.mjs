import { test } from "node:test";
import assert from "node:assert/strict";
import { validarExtracao } from "./validar.js";

const MACROS = ["Casa", "Saúde", "Outros"];

test("aceita extração completa e normaliza data BR + valor", () => {
  const r = validarExtracao(
    { data: "29/08/2026", valor: "15,50", descricao: "Padaria", natureza: "despesa", macro: "Casa", sub: "Limpeza" },
    MACROS
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.normalizado, {
    dataISO: "2026-08-29", valorCents: 1550, natureza: "despesa",
    macro: "Casa", sub: "Limpeza", descricao: "Padaria",
  });
});

test("aceita data já em ISO e natureza ausente vira despesa", () => {
  const r = validarExtracao({ data: "2026-08-29", valor: 20, macro: "Casa" }, MACROS);
  assert.equal(r.ok, true);
  assert.equal(r.normalizado.natureza, "despesa");
  assert.equal(r.normalizado.valorCents, 2000);
});

test("rejeita valor inválido", () => {
  const r = validarExtracao({ data: "29/08/2026", valor: "xx", macro: "Casa" }, MACROS);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("valor")));
});

test("rejeita data inválida", () => {
  const r = validarExtracao({ data: "32/13/2026", valor: "10", macro: "Casa" }, MACROS);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("data")));
});

test("rejeita macro fora da lista", () => {
  const r = validarExtracao({ data: "2026-08-29", valor: "10", macro: "Marte" }, MACROS);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("macro")));
});
