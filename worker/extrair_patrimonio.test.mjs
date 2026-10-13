import { test } from "node:test";
import assert from "node:assert/strict";
import { extrair, validarPatrimonio, PROMPT_PATRIMONIO } from "./extrair.js";

// A2: respostas do modelo inventadas (nenhum valor real: o repositório é público)
const printOk = {
  data: "2026-10-09", conta: "Itaú", pessoa: "Caio",
  produtos: [
    { produto: "Fundos", familia: "fundos", nivel: "agregado", saldo: 500000, vencimento: null, taxa: null, rendimento: 50000, periodo: "ano" },
    { produto: "CDB Banco X", familia: "renda_fixa", nivel: "titulo", saldo: "150.000,00", vencimento: "2028-01-03", taxa: "102% CDI", rendimento: null, periodo: null },
    { produto: "Cofrinhos", familia: "caixa", nivel: "agregado", saldo: 20000.5, vencimento: null, taxa: null, rendimento: "-12,30", periodo: "mes" },
  ],
};

test("validarPatrimonio aceita a forma do prompt e normaliza conta, centavos e período", () => {
  const v = validarPatrimonio(printOk);
  assert.equal(v.ok, true);
  const n = v.normalizado;
  assert.equal(n.dataISO, "2026-10-09");
  assert.equal(n.conta, "itau");
  assert.equal(n.pessoa, "Caio");
  assert.equal(n.produtos.length, 3);
  assert.equal(n.produtos[0].saldo_cents, 50000000);
  assert.equal(n.produtos[0].rendimento_print_cents, 5000000);
  assert.equal(n.produtos[0].periodo_rendimento, "ano");
  assert.equal(n.produtos[1].saldo_cents, 15000000); // texto BR também serve
  assert.equal(n.produtos[1].vencimento, "2028-01-03");
  assert.equal(n.produtos[1].taxa, "102% CDI");
  assert.equal(n.produtos[2].saldo_cents, 2000050);
  assert.equal(n.produtos[2].rendimento_print_cents, -1230); // rendimento pode ser negativo
});

test("validarPatrimonio: sem data, conta ou pessoa não recusa (a legenda e a mensagem completam)", () => {
  const v = validarPatrimonio({ ...printOk, data: null, conta: "Banco Desconhecido", pessoa: null });
  assert.equal(v.ok, true);
  assert.equal(v.normalizado.dataISO, null);
  assert.equal(v.normalizado.conta, null);
  assert.equal(v.normalizado.pessoa, null);
});

test("validarPatrimonio recusa família, nível ou período fora do vocabulário", () => {
  const com = (mud) => ({ ...printOk, produtos: [{ ...printOk.produtos[0], ...mud }] });
  for (const mud of [{ familia: "acoes" }, { nivel: "subtotal" }, { periodo: "semana" }]) {
    const v = validarPatrimonio(com(mud));
    assert.equal(v.ok, false, JSON.stringify(mud));
    assert.ok(v.erros.length > 0);
  }
});

test("validarPatrimonio recusa print sem produto e saldo inválido", () => {
  assert.equal(validarPatrimonio({ ...printOk, produtos: [] }).ok, false);
  assert.equal(validarPatrimonio({ ...printOk, produtos: [{ ...printOk.produtos[0], saldo: "abc" }] }).ok, false);
  assert.equal(validarPatrimonio(null).ok, false);
});

test("extrair no modo patrimonio: chama o modelo com o modo e valida com o validador do patrimônio", async () => {
  const modos = [];
  const deps = {
    limiar: 0.6,
    callGemini: async (b, m, c, modo) => { modos.push(modo); return { campos: printOk, confianca: 0.9 }; },
    callClaude: async () => { throw new Error("não devia chamar"); },
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", null, deps, "patrimonio");
  assert.equal(r.ok, true);
  assert.equal(r.extraido_por, "gemini");
  assert.deepEqual(modos, ["patrimonio"]);
  assert.equal(r.normalizado.produtos.length, 3);
});

test("extrair no modo patrimonio cai pro Claude quando a leitura do Gemini é inválida", async () => {
  const deps = {
    limiar: 0.6,
    callGemini: async () => ({ campos: { ...printOk, produtos: [{ ...printOk.produtos[0], familia: "cripto" }] }, confianca: 0.9 }),
    callClaude: async (b, m, c, modo) => { assert.equal(modo, "patrimonio"); return { campos: printOk, confianca: 0.8 }; },
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", null, deps, "patrimonio");
  assert.equal(r.ok, true);
  assert.equal(r.extraido_por, "claude");
});

test("extrair no modo patrimonio falha quando os dois modelos devolvem lixo", async () => {
  const ruim = { produtos: [{ produto: "x", familia: "fundos", nivel: "agregado", saldo: 1, periodo: "trimestre", rendimento: 1 }] };
  const deps = { limiar: 0.6, callGemini: async () => ({ campos: ruim, confianca: 0.9 }), callClaude: async () => ({ campos: ruim, confianca: 0.9 }) };
  const r = await extrair(new Uint8Array(), "image/jpeg", null, deps, "patrimonio");
  assert.equal(r.ok, false);
});

test("PROMPT_PATRIMONIO pede a forma {data, conta, pessoa, produtos} com o vocabulário fechado", () => {
  const p = PROMPT_PATRIMONIO();
  for (const t of ["produtos", "fundos", "renda_fixa", "caixa", "outros", "titulo", "agregado", "desde_inicio"]) assert.match(p, new RegExp(t));
});
