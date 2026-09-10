import { test } from "node:test";
import assert from "node:assert/strict";
import { primeiroDiaDoMes, mesAnterior, alvoEfetivo, mediaSugestao, statusMeta } from "./metas.js";

test("primeiroDiaDoMes normaliza p/ dia-01", () => {
  assert.equal(primeiroDiaDoMes("2026-09"), "2026-09-01");
  assert.equal(primeiroDiaDoMes("2026-09-17"), "2026-09-01");
});

test("mesAnterior anda pra trás e (n negativo) pra frente, virando o ano", () => {
  assert.equal(mesAnterior("2026-03", 1), "2026-02");
  assert.equal(mesAnterior("2026-01", 1), "2025-12");
  assert.equal(mesAnterior("2026-01", 3), "2025-10");
  assert.equal(mesAnterior("2026-11", -2), "2027-01"); // 2 à frente
});

// baselines: cada um "vale a partir de vigente_desde", propaga pra frente até um mais novo
const baselines = [
  { categoria_id: "c1", vigente_desde: "2026-01-01", valor_cents: 100000 },
  { categoria_id: "c1", vigente_desde: "2026-06-01", valor_cents: 150000 },
];
const excecoes = [
  { categoria_id: "c1", mes: "2026-08-01", valor_cents: 200000 },
];

test("alvoEfetivo: exceção vence tudo naquele mês", () => {
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "c1", "2026-08-01"),
    { valorCents: 200000, origem: "excecao" });
});

test("alvoEfetivo: baseline mais recente <= mês", () => {
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "c1", "2026-05-01"),
    { valorCents: 100000, origem: "baseline" });
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "c1", "2026-07-01"),
    { valorCents: 150000, origem: "baseline" });
});

test("alvoEfetivo: exceção NÃO propaga (mês seguinte volta ao baseline)", () => {
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "c1", "2026-09-01"),
    { valorCents: 150000, origem: "baseline" });
});

test("alvoEfetivo: mês antes de qualquer baseline → sem-alvo", () => {
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "c1", "2025-12-01"),
    { valorCents: null, origem: "sem-alvo" });
});

test("alvoEfetivo: categoria sem nenhuma meta → sem-alvo", () => {
  assert.deepEqual(alvoEfetivo(baselines, excecoes, "cX", "2026-07-01"),
    { valorCents: null, origem: "sem-alvo" });
});

test("mediaSugestao: média dos 3 meses anteriores presentes, arredondada em centavos", () => {
  const real = { "2026-06": 100000, "2026-07": 110000, "2026-08": 90100 };
  // (100000+110000+90100)/3 = 100033.33 → 100033
  assert.equal(mediaSugestao(real, "2026-09", 3), 100033);
});

test("mediaSugestao: janela com meses faltando usa só os presentes", () => {
  const real = { "2026-08": 90000 }; // só 1 dos 3 anteriores
  assert.equal(mediaSugestao(real, "2026-09", 3), 90000);
});

test("mediaSugestao: nenhum mês anterior com dado → null", () => {
  assert.equal(mediaSugestao({ "2026-09": 50000 }, "2026-09", 3), null);
});

test("statusMeta: faixas normal/aviso/estouro e sem-alvo", () => {
  assert.equal(statusMeta(50000, null), "sem-alvo");
  assert.equal(statusMeta(50000, 100000), "normal");   // 50%
  assert.equal(statusMeta(80000, 100000), "aviso");     // 80%
  assert.equal(statusMeta(100001, 100000), "estouro");  // >100%
  assert.equal(statusMeta(1, 0), "estouro");            // alvo 0 e gastou
  assert.equal(statusMeta(0, 0), "normal");             // alvo 0 e nada gasto
});
