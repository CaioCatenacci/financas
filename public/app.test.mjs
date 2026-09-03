import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agruparMensal, centavosBR, kf, deltaPct, periodoRange, construirWaterfall, subsPorCategoria,
} from "./app.js";

test("agruparMensal soma receita/despesa e saldo por mês", () => {
  const rows = [
    { mes: "2026-01", natureza: "despesa", total: "100.00" },
    { mes: "2026-01", natureza: "receita", total: "300.00" },
    { mes: "2026-02", natureza: "despesa", total: "50.00" },
  ];
  assert.deepEqual(agruparMensal(rows), [
    { mes: "2026-01", receita: 300, despesa: 100, saldo: 200 },
    { mes: "2026-02", receita: 0, despesa: 50, saldo: -50 },
  ]);
});

test("centavosBR formata numeric string", () => {
  assert.equal(centavosBR("1505.50"), "1.505,50");
  assert.equal(centavosBR("9.00"), "9,00");
});

test("kf abrevia milhares", () => {
  assert.equal(kf(16800), "16,8k");
  assert.equal(kf(1000), "1k");
  assert.equal(kf(980), "980");
});

test("deltaPct calcula variação e trata base zero", () => {
  assert.equal(deltaPct(100, 150), 50);
  assert.equal(deltaPct(200, 150), -25);
  assert.equal(deltaPct(0, 50), 100);
  assert.equal(deltaPct(0, 0), 0);
});

test("periodoRange devolve intervalos ISO por preset", () => {
  const h = new Date(Date.UTC(2026, 7, 15)); // 2026-08-15
  assert.deepEqual(periodoRange("ano", h), { de: "2026-01-01", ate: "2026-12-31" });
  assert.deepEqual(periodoRange("mes", h), { de: "2026-08-01", ate: "2026-08-31" });
  assert.deepEqual(periodoRange("12m", h), { de: "2025-09-01", ate: "2026-08-31" });
  assert.deepEqual(periodoRange("tudo", h), { de: "1900-01-01", ate: "2999-12-31" });
});

test("construirWaterfall monta receita → despesas → saldo com lo/hi cumulativos", () => {
  const steps = construirWaterfall(1000, [{ nm: "A", v: 600 }, { nm: "B", v: 300 }]);
  assert.deepEqual(steps, [
    { nm: "Receita", tipo: "receita", lo: 0, hi: 1000 },
    { nm: "A", tipo: "despesa", lo: 400, hi: 1000 },
    { nm: "B", tipo: "despesa", lo: 100, hi: 400 },
    { nm: "Saldo", tipo: "saldo", lo: 0, hi: 100 },
  ]);
});

test("subsPorCategoria agrupa subs por categoria, ignorando nulos e duplicados", () => {
  const cats = [
    { macro: "Casa", sub: "Luz" }, { macro: "Casa", sub: "Água" }, { macro: "Casa", sub: null },
    { macro: "Casa", sub: "Luz" }, { macro: "Saúde", sub: "Plano" },
  ];
  const g = subsPorCategoria(cats);
  assert.deepEqual(g["Casa"], ["Luz", "Água"]);
  assert.deepEqual(g["Saúde"], ["Plano"]);
});
