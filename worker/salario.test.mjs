// G1: alocação FIFO das conversões USD→BRL aos meses de salário. Números inventados.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alocarSalario, mesesAte } from "./salario.js";

const P8000 = [{ vigente_desde: "2026-01-01", usd_cents: 800000 }];
const conv = (data, usd, brl) => ({ data, usd_cents: usd * 100, brl_cents: brl * 100 });

test("Exemplo do card: ago fechado em 40.000, set 40.600 (conversão dividida), out 41.600 estimado", () => {
  // 04/08 8.000→40.000 paga agosto; 11/08 5.000→25.000 + 3.000 dos 5.000 de 14/08 (26.000) pagam
  // setembro; os 2.000 que sobram (10.400) vão pra outubro, que fica estimado em 6.000 × 5,20.
  const conversoes = [conv("2026-08-04", 8000, 40000), conv("2026-08-11", 5000, 25000), conv("2026-08-14", 5000, 26000)];
  const r = alocarSalario(conversoes, P8000, ["2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(r.map((m) => [m.mes, m.brl_cents, m.estimado]), [
    ["2026-08", 4000000, false],
    ["2026-09", 4060000, false],
    ["2026-10", 4160000, true],
  ]);
  assert.equal(r[0].usd_cents, 800000);
  assert.equal(r[0].taxa, 5);
  assert.equal(r[2].taxa, 5.2);
});

test("mês fechado exato: uma conversão do tamanho do salário paga o mês sem estimativa", () => {
  const r = alocarSalario([conv("2026-01-05", 8000, 41000)], P8000, ["2026-01"]);
  assert.deepEqual(r[0], { mes: "2026-01", brl_cents: 4100000, usd_cents: 800000, taxa: 5.125, estimado: false });
});

test("conversão dividida: os reais se repartem na proporção dos dólares e fecham com o total", () => {
  // 12.000 → 61.111 (não divide exato): jan leva 8.000 e fev os 4.000; a soma tem que bater 61.111.
  const r = alocarSalario([conv("2026-01-05", 12000, 61111), conv("2026-02-10", 4000, 20000)], P8000, ["2026-01", "2026-02"]);
  assert.equal(r[0].brl_cents + r[1].brl_cents, 6111100 + 2000000);
  assert.equal(r[0].brl_cents, Math.round(6111100 * 8000 / 12000));
  assert.equal(r[0].estimado, false);
  assert.equal(r[1].estimado, false);
});

test("mês parcial: o que falta vale a última taxa conhecida e o mês vem com estimado=true", () => {
  const r = alocarSalario([conv("2026-01-05", 3000, 15000)], P8000, ["2026-01"]);
  // 15.000 reais + 5.000 × 5,00 = 40.000
  assert.equal(r[0].brl_cents, 4000000);
  assert.equal(r[0].estimado, true);
});

test("mês sem conversão: tudo estimado pela última taxa conhecida (a da conversão mais recente)", () => {
  const r = alocarSalario([conv("2026-01-05", 8000, 40000), conv("2026-02-03", 8000, 44000)], P8000, ["2026-03"]);
  assert.equal(r[0].brl_cents, 800000 * 5.5);
  assert.equal(r[0].estimado, true);
});

test("sem nenhuma conversão não há taxa: salário em reais fica nulo, mas o mês é estimado", () => {
  const r = alocarSalario([], P8000, ["2026-03"]);
  assert.deepEqual(r[0], { mes: "2026-03", brl_cents: null, usd_cents: 800000, taxa: null, estimado: true });
});

test("mudança de parâmetro no meio: cada mês consome os dólares do parâmetro vigente nele", () => {
  const params = [{ vigente_desde: "2026-01-01", usd_cents: 500000 }, { vigente_desde: "2026-02-01", usd_cents: 800000 }];
  // 13.000 → 65.000 cobre jan (5.000) e fev (8.000) exatamente
  const r = alocarSalario([conv("2026-01-05", 13000, 65000)], params, ["2026-01", "2026-02"]);
  assert.deepEqual(r.map((m) => [m.usd_cents, m.brl_cents, m.estimado]), [[500000, 2500000, false], [800000, 4000000, false]]);
});

test("o FIFO começa no mês da primeira conversão: meses antes dela (desde o parâmetro) ficam estimados, não pagos", () => {
  // Nomad em 2025: parâmetro desde abril, primeira conversão só em julho → abr/mai/jun estimados
  // (sem conversão que os pague); julho é o primeiro mês pago. Sem isso, o Exemplo do card não fecha.
  const params = [{ vigente_desde: "2025-04-01", usd_cents: 800000 }];
  const r = alocarSalario([conv("2025-07-31", 8000, 44000)], params, ["2025-05", "2025-07"]);
  assert.equal(r[0].estimado, true);
  assert.equal(r[0].brl_cents, 4400000);
  assert.deepEqual([r[1].brl_cents, r[1].estimado], [4400000, false]);
});

test("mês anterior ao primeiro parâmetro: salário nulo, estimado=false, e não consome conversão", () => {
  const r = alocarSalario([conv("2026-01-05", 8000, 40000)], P8000, ["2025-12", "2026-01"]);
  assert.deepEqual(r[0], { mes: "2025-12", brl_cents: null, usd_cents: null, taxa: null, estimado: false });
  assert.equal(r[1].brl_cents, 4000000);
});

test("a ordem dos meses pedidos não muda a alocação (FIFO roda do primeiro parâmetro em diante)", () => {
  const conversoes = [conv("2026-01-05", 8000, 40000), conv("2026-02-05", 8000, 42000)];
  const a = alocarSalario(conversoes, P8000, ["2026-02"]);
  const b = alocarSalario(conversoes, P8000, ["2026-01", "2026-02"]);
  assert.equal(a[0].brl_cents, b[1].brl_cents);
});

test("conversões fora de ordem no input são consumidas pela data", () => {
  const conversoes = [conv("2026-02-05", 8000, 42000), conv("2026-01-05", 8000, 40000)];
  const r = alocarSalario(conversoes, P8000, ["2026-01", "2026-02"]);
  assert.deepEqual(r.map((m) => m.brl_cents), [4000000, 4200000]);
});

test("mesesAte: os 12 meses que terminam no mês pedido, em ordem", () => {
  const m = mesesAte("2026-09", 12);
  assert.equal(m.length, 12);
  assert.equal(m[0], "2025-10");
  assert.equal(m[11], "2026-09");
});
