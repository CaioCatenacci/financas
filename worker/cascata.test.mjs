import { test } from "node:test";
import assert from "node:assert/strict";
import { montarCascata } from "./cascata.js";

// Exemplo do A3 (valores inventados): salário 40.000, empresa 3.000, outras receitas 1.000,
// pessoais 25.000 → disponível 37.000, saldo 13.000 — o mesmo do card "Saldo do mês".
const somas = { despesa_empresa_cents: 300000, despesa_pessoal_cents: 2500000, outras_receitas_cents: 100000 };

test("montarCascata: disponível = salário − empresa; saldo = disponível + outras receitas − pessoais", () => {
  const c = montarCascata({ brl_cents: 4000000, estimado: false }, somas, []);
  assert.equal(c.salario_cents, 4000000);
  assert.equal(c.disponivel_cents, 3700000);
  assert.equal(c.saldo_cents, 1300000);
  assert.equal(c.estimado, false);
});

test("montarCascata: o selo estimado vem do salário do mês", () => {
  assert.equal(montarCascata({ brl_cents: 4000000, estimado: true }, somas, []).estimado, true);
});

test("montarCascata: mês antes do primeiro parâmetro (brl_cents null) vira salário 0, nunca null nem NaN", () => {
  const c = montarCascata({ brl_cents: null, estimado: false }, somas, []);
  assert.equal(c.salario_cents, 0);
  assert.equal(c.disponivel_cents, -300000);
  assert.equal(c.saldo_cents, -2700000);
  assert.equal(c.estimado, false);
});

test("montarCascata: os grupos pessoais passam adiante, em centavos, para o waterfall", () => {
  const pessoais = [{ macro: "Casa", total_cents: 2000000 }, { macro: "Lazer", total_cents: 500000 }];
  assert.deepEqual(montarCascata({ brl_cents: 0, estimado: false }, somas, pessoais).pessoais, pessoais);
});
