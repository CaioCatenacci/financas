import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLancamentoTexto } from "./texto.js";

test("parse básico: descrição + valor + data (ordem livre)", () => {
  const r = parseLancamentoTexto("padaria 57,50 29/03/2026");
  assert.equal(r.ok, true);
  assert.equal(r.dados.valorCents, 5750);
  assert.equal(r.dados.dataISO, "2026-03-29");
  assert.equal(r.dados.descricao, "padaria");
  assert.equal(r.dados.natureza, "despesa");
  assert.equal(r.dados.categoria, null);
});

test("ordem trocada e descrição com várias palavras", () => {
  const r = parseLancamentoTexto("57,50 conta de luz 29/03/2026");
  assert.equal(r.dados.descricao, "conta de luz");
  assert.equal(r.dados.valorCents, 5750);
});

test("data dd/mm usa o ano atual", () => {
  const ano = new Date().getUTCFullYear();
  const r = parseLancamentoTexto("padaria 10,00 05/01");
  assert.equal(r.dados.dataISO, `${ano}-01-05`);
});

test("pares chave=valor, com nome de categoria com espaço", () => {
  const r = parseLancamentoTexto("consulta 200,00 02/02/2026 categoria=Plano de saúde pessoa=Caio subcategoria=Amil");
  assert.equal(r.dados.categoria, "Plano de saúde");
  assert.equal(r.dados.pessoa, "Caio");
  assert.equal(r.dados.subcategoria, "Amil");
  assert.equal(r.dados.descricao, "consulta");
});

test("natureza=receita", () => {
  const r = parseLancamentoTexto("salário 5000,00 05/03/2026 natureza=receita");
  assert.equal(r.dados.natureza, "receita");
});

test("valor com milhar e centavos", () => {
  const r = parseLancamentoTexto("aluguel 1.234,56 10/03/2026");
  assert.equal(r.dados.valorCents, 123456);
});

test("faltando valor → ok:false", () => {
  const r = parseLancamentoTexto("padaria 29/03/2026");
  assert.equal(r.ok, false);
  assert.match(r.erro, /valor|obrigat/i);
});

test("faltando data → ok:false", () => {
  assert.equal(parseLancamentoTexto("padaria 57,50").ok, false);
});

test("faltando descrição → ok:false", () => {
  assert.equal(parseLancamentoTexto("57,50 29/03/2026").ok, false);
});

test("texto vazio → ok:false", () => {
  assert.equal(parseLancamentoTexto("").ok, false);
});

test("data impossível: 31/02/2026 → ok:false", () => {
  // Fevereiro nunca tem 31 dias
  const r = parseLancamentoTexto("padaria 10,00 31/02/2026");
  assert.equal(r.ok, false);
  assert.match(r.erro, /obrigat/i);
});

test("data impossível: 30/02/2026 (não bissexto) → ok:false", () => {
  // 2026 não é bissexto; fevereiro tem 28 dias
  const r = parseLancamentoTexto("padaria 10,00 29/02/2026");
  assert.equal(r.ok, false);
  assert.match(r.erro, /obrigat/i);
});

test("data válida: 29/02/2024 (bissexto) → ok:true", () => {
  // 2024 é bissexto (divisível por 4, não por 100 ou sim por 400)
  const r = parseLancamentoTexto("padaria 10,00 29/02/2024");
  assert.equal(r.ok, true);
  assert.equal(r.dados.dataISO, "2024-02-29");
});

test("data inválida: 31/04/2026 (abril tem 30) → ok:false", () => {
  // Abril tem 30 dias
  const r = parseLancamentoTexto("padaria 10,00 31/04/2026");
  assert.equal(r.ok, false);
  assert.match(r.erro, /obrigat/i);
});
