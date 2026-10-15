import { test } from "node:test";
import assert from "node:assert/strict";
import { inicioComparacao, periodoAnoVsAnterior } from "./ano_vs_anterior.js";

// Meses de fatura são inventados; só a forma 'AAAA-MM' (mês do vencimento, de `importacoes.de`) importa.

test("inicioComparacao: com fatura vencendo em janeiro do ano anterior, o ano anterior está coberto desde o começo → janeiro", () => {
  assert.equal(inicioComparacao(2026, ["2025-01", "2025-02", "2025-03"]), "01");
});

test("inicioComparacao: primeira fatura do ano anterior em maio → junho (a primeira só traz parte das compras do mês dela)", () => {
  assert.equal(inicioComparacao(2026, ["2025-05", "2025-06", "2026-01"]), "06");
});

test("inicioComparacao: a lista não precisa vir ordenada; vale a primeira do ano anterior", () => {
  assert.equal(inicioComparacao(2026, ["2025-09", "2025-04", "2025-11"]), "05");
});

test("inicioComparacao: sem fatura no ano anterior → null (não há base de comparação)", () => {
  assert.equal(inicioComparacao(2026, []), null);
  // fatura só do ano corrente ou de dois anos atrás não cobre o ano anterior
  assert.equal(inicioComparacao(2026, ["2024-03", "2026-01"]), null);
});

test("inicioComparacao: primeira fatura do ano anterior em dezembro → null (o mês seguinte cairia no outro ano)", () => {
  assert.equal(inicioComparacao(2026, ["2025-12"]), null);
});

test("periodoAnoVsAnterior: Exemplo do D5 — setembro/2026, primeira fatura de 2025 em maio → jun–set nos dois anos", () => {
  const p = periodoAnoVsAnterior("2026-09", ["2025-05", "2025-06", "2026-08", "2026-09"]);
  assert.deepEqual(p, {
    de: "2026-06-01", ate: "2026-09-30", de_anterior: "2025-06-01", ate_anterior: "2025-09-30",
    ateExcl: "2026-10-01", ateExclAnterior: "2025-10-01", antesDoInicio: false,
  });
});

test("periodoAnoVsAnterior: o fim do ano anterior é o último dia do mesmo mês (fevereiro bissexto não vira 29/02 inexistente)", () => {
  const p = periodoAnoVsAnterior("2028-02", ["2027-01", "2028-02"]);
  assert.equal(p.ate, "2028-02-29");
  assert.equal(p.ate_anterior, "2027-02-28");
  assert.equal(p.ateExclAnterior, "2027-03-01");
});

test("periodoAnoVsAnterior: dezembro vira o ano no fim exclusivo", () => {
  const p = periodoAnoVsAnterior("2026-12", ["2025-01", "2026-12"]);
  assert.equal(p.ate, "2026-12-31");
  assert.equal(p.ateExcl, "2027-01-01");
  assert.equal(p.ateExclAnterior, "2026-01-01");
});

test("periodoAnoVsAnterior: mês antes do início → objeto com o início em `de` e antesDoInicio (o card diz 'sem comparação')", () => {
  const p = periodoAnoVsAnterior("2026-03", ["2025-05", "2026-03"]);
  assert.equal(p.de, "2026-06-01");
  assert.equal(p.antesDoInicio, true);
});

test("periodoAnoVsAnterior: sem fatura no ano anterior → null", () => {
  assert.equal(periodoAnoVsAnterior("2026-09", ["2026-01"]), null);
});

// Fim (decisão do Caio, 15/10/2026): o período para no último mês com fatura importada no ano
// corrente — o mês corrente ainda sem fatura mostraria uma queda falsa em tudo que vem do cartão.
test("periodoAnoVsAnterior: mês selecionado sem fatura → o fim recua para o último mês com fatura", () => {
  const p = periodoAnoVsAnterior("2026-10", ["2025-05", "2025-10", "2026-08", "2026-09"]);
  assert.equal(p.ate, "2026-09-30");
  assert.equal(p.ate_anterior, "2025-09-30");
  assert.equal(p.ateExcl, "2026-10-01");
  assert.equal(p.ateExclAnterior, "2025-10-01");
  assert.equal(p.antesDoInicio, false);
});

test("periodoAnoVsAnterior: fatura de mês depois do selecionado não estica o fim", () => {
  const p = periodoAnoVsAnterior("2026-07", ["2025-05", "2026-06", "2026-09"]);
  assert.equal(p.ate, "2026-06-30");
});

test("periodoAnoVsAnterior: nenhuma fatura no ano corrente desde o início → antesDoInicio (sem comparação)", () => {
  const p = periodoAnoVsAnterior("2026-08", ["2025-05", "2026-04"]);
  assert.equal(p.antesDoInicio, true);
});
