import { test } from "node:test";
import assert from "node:assert/strict";
import { validarExtracao, ehUuid } from "./validar.js";

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
    contraparte_nome: null, contraparte_chave: null,
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

test("aceita data não-padronizada e zero-preenche", () => {
  const r = validarExtracao({ data: "5/1/2026", valor: "10", macro: "Casa" }, MACROS);
  assert.equal(r.ok, true);
  assert.equal(r.normalizado.dataISO, "2026-01-05");
});

test("normalizado repassa contraparte quando presente", () => {
  const r = validarExtracao(
    { data: "2026-08-28", valor: "916,00", macro: "Casa",
      contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "+5519995783408" },
    MACROS
  );
  assert.equal(r.ok, true);
  assert.equal(r.normalizado.contraparte_nome, "VIVIANE FERRER BORGATO");
  assert.equal(r.normalizado.contraparte_chave, "+5519995783408");
});

test("contraparte ausente vira null no normalizado", () => {
  const r = validarExtracao({ data: "2026-08-28", valor: "10", macro: "Casa" }, MACROS);
  assert.equal(r.normalizado.contraparte_nome, null);
  assert.equal(r.normalizado.contraparte_chave, null);
});

// F3: as rotas de grupo checam o formato antes de mandar o id pro `::uuid` do Postgres,
// que responderia com erro (500) em vez de uma mensagem.
test("ehUuid aceita uuid canônico, maiúsculo ou minúsculo", () => {
  assert.equal(ehUuid("00000000-0000-4000-8000-0000000000a1"), true);
  assert.equal(ehUuid("00000000-0000-4000-8000-0000000000A1"), true);
  assert.equal(ehUuid(crypto.randomUUID()), true);
});

test("ehUuid recusa o que o Postgres não converteria ou que nem é texto", () => {
  for (const v of ["", "abc", "G0", "undefined", "00000000-0000-4000-8000-0000000000a", "00000000-0000-4000-8000-0000000000a1x",
                   " 00000000-0000-4000-8000-0000000000a1", 42, null, undefined, {}, []]) {
    assert.equal(ehUuid(v), false, `devia recusar ${JSON.stringify(v)}`);
  }
});
