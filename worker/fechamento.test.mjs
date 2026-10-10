import { test } from "node:test";
import assert from "node:assert/strict";
import { ultimoDiaDoMes, coberturaFonte, estadoDoMes, montarFechamento } from "./fechamento.js";

// Datas inventadas (o repositório é público). O "mês corrente" entra por parâmetro: a regra não
// tem relógio, então o teste fixa o "hoje" e é reproduzível em qualquer dia.
const HOJE = "2026-10";

test("ultimoDiaDoMes acerta mês de 30, de 31 e fevereiro (bissexto ou não)", () => {
  assert.equal(ultimoDiaDoMes("2026-09"), "2026-09-30");
  assert.equal(ultimoDiaDoMes("2026-08"), "2026-08-31");
  assert.equal(ultimoDiaDoMes("2026-02"), "2026-02-28");
  assert.equal(ultimoDiaDoMes("2028-02"), "2028-02-29");
});

test("coberturaFonte: até o último dia (ou depois) é cheia; dentro do mês é parcial; antes do dia 01 ou sem import é faltando", () => {
  assert.equal(coberturaFonte("2026-08-31", "2026-08"), "cheia");
  assert.equal(coberturaFonte("2026-09-02", "2026-08"), "cheia"); // max(ate) depois do mês cobre o mês inteiro
  assert.equal(coberturaFonte("2026-08-01", "2026-08"), "parcial");
  assert.equal(coberturaFonte("2026-08-30", "2026-08"), "parcial");
  assert.equal(coberturaFonte("2026-07-31", "2026-08"), "faltando");
  assert.equal(coberturaFonte(null, "2026-08"), "faltando");
});

const cheio = (mes) => ({ mes, mesCorrente: HOJE, itauAte: ultimoDiaDoMes(mes), c6Ate: ultimoDiaDoMes(mes), faturaExiste: true });

test("fechado: Itaú e C6 cobrem até o último dia do mês e a fatura do mês existe", () => {
  assert.equal(estadoDoMes(cheio("2026-07")).estado, "fechado");
});

test("parcial: uma fonte cobre só parte do mês, as demais cheias", () => {
  assert.equal(estadoDoMes({ ...cheio("2026-07"), itauAte: "2026-07-20" }).estado, "parcial");
  assert.equal(estadoDoMes({ ...cheio("2026-07"), c6Ate: "2026-07-01" }).estado, "parcial");
});

test("faltando: uma fonte termina antes do dia 01 do mês, ou a fatura do mês não existe", () => {
  assert.equal(estadoDoMes({ ...cheio("2026-07"), itauAte: "2026-06-30" }).estado, "faltando");
  assert.equal(estadoDoMes({ ...cheio("2026-07"), c6Ate: null }).estado, "faltando");
  assert.equal(estadoDoMes({ ...cheio("2026-07"), faturaExiste: false }).estado, "faltando");
});

test("faltando prevalece sobre parcial: o que não chegou é mais urgente do que o que chegou pela metade", () => {
  const r = estadoDoMes({ ...cheio("2026-07"), itauAte: "2026-07-15", faturaExiste: false });
  assert.equal(r.estado, "faltando");
  assert.equal(r.fontes.itau.cobertura, "parcial");
  assert.equal(r.fontes.fatura.cobertura, "faltando");
});

test("o mês corrente nunca é fechado antes de acabar, mesmo com tudo coberto", () => {
  const r = estadoDoMes({ ...cheio(HOJE) });
  assert.notEqual(r.estado, "fechado");
  assert.equal(r.estado, "parcial");
  // e um mês futuro também não (não acabou)
  assert.notEqual(estadoDoMes({ ...cheio("2026-11"), mesCorrente: HOJE }).estado, "fechado");
});

test("N sem categoria não altera o estado e volta como pendência", () => {
  const r = estadoDoMes({ ...cheio("2026-07"), semCategoria: 4 });
  assert.equal(r.estado, "fechado");
  assert.equal(r.sem_categoria, 4);
});

test("salário estimado não altera o estado e volta como informação", () => {
  const r = estadoDoMes({ ...cheio("2026-07"), salarioEstimado: true, salarioAte: "2026-06-20" });
  assert.equal(r.estado, "fechado");
  assert.deepEqual(r.fontes.salario, { ate: "2026-06-20", estimado: true });
});

// ---- o Exemplo do card (números inventados) ----
test("Exemplo, setembro: Itaú até 30/09, C6 até 28/09, fatura de setembro, salário estimado, 3 sem categoria → parcial", () => {
  const r = estadoDoMes({
    mes: "2026-09", mesCorrente: HOJE, itauAte: "2026-09-30", c6Ate: "2026-09-28", faturaExiste: true,
    semCategoria: 3, salarioEstimado: true,
  });
  assert.equal(r.estado, "parcial");
  assert.equal(r.fontes.c6.cobertura, "parcial");
  assert.equal(r.sem_categoria, 3);
  assert.equal(r.fontes.salario.estimado, true);
});

test("Exemplo, outubro: nenhum import cobre o mês → faltando", () => {
  const r = estadoDoMes({ mes: "2026-10", mesCorrente: HOJE, itauAte: "2026-09-30", c6Ate: "2026-09-28", faturaExiste: false });
  assert.equal(r.estado, "faltando");
});

test("Exemplo, agosto: os dois PDFs até 31/08 e a fatura de agosto → fechado, mesmo com 6 sem categoria", () => {
  const r = estadoDoMes({ mes: "2026-08", mesCorrente: HOJE, itauAte: "2026-08-31", c6Ate: "2026-08-31", faturaExiste: true, semCategoria: 6 });
  assert.equal(r.estado, "fechado");
  assert.equal(r.sem_categoria, 6);
});

test("montarFechamento junta as leituras do banco: Itaú = extrato/itau, C6 = extrato/c6, fatura por mês, salário pela última conversão", () => {
  const meses = ["2026-08", "2026-09", "2026-10"];
  const r = montarFechamento(meses, HOJE, {
    coberturas: [
      { conta: "itau", tipo: "extrato", ate: "2026-09-30" },
      { conta: "c6", tipo: "extrato", ate: "2026-09-28" },
      { conta: "wise", tipo: "wise", ate: "2026-09-18" }, // gravada, mas o salário lê as conversões
      { conta: "outra", tipo: "extrato", ate: "2026-12-31" }, // conta que não é itau nem c6 não conta
    ],
    faturas: ["2026-08", "2026-09"],
    semCategoria: [{ mes: "2026-09", n: 3 }, { mes: "2026-08", n: 6 }],
    salarios: [{ mes: "2026-08", estimado: false }, { mes: "2026-09", estimado: true }, { mes: "2026-10", estimado: true }],
    ultimaConversao: "2026-09-20",
  });
  assert.deepEqual(r.map((m) => [m.mes, m.estado]), [["2026-08", "fechado"], ["2026-09", "parcial"], ["2026-10", "faltando"]]);
  assert.deepEqual(r[1].fontes.itau, { ate: "2026-09-30", cobertura: "cheia" });
  assert.deepEqual(r[1].fontes.fatura, { existe: true, cobertura: "cheia" });
  assert.deepEqual(r[2].fontes.fatura, { existe: false, cobertura: "faltando" });
  assert.deepEqual(r[1].fontes.salario, { ate: "2026-09-20", estimado: true });
  assert.equal(r[0].sem_categoria, 6);
  assert.equal(r[2].sem_categoria, 0);
});
