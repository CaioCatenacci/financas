import { test } from "node:test";
import assert from "node:assert/strict";
import {
  montarCasa, patrimonioCarregado, janelaRitmo, calcularRitmo, projetar, mesesEntre, somaMeses,
  validarParamCasa, paramVigente, AVISOS,
} from "./casa.js";
import { mesesAte } from "./salario.js";

// Números inventados (o repositório é público). Centavos inteiros em tudo.
const R = (reais) => reais * 100;

// uma linha de patrimonioPorDia: um agregado de caixa, com ou sem rendimento do print no mês
const linha = (mes, dia, conta, pessoa, saldo, rend = null) => ({
  mes, data: `${mes}-${dia}`, conta, pessoa, familia: "caixa", nivel: "agregado",
  saldo_cents: saldo, rend_mes_cents: rend, n_rend_mes: rend == null ? 0 : 1,
});

const fechados = (meses, exceto = {}) => meses.map((mes) => ({ mes, estado: exceto[mes] || "fechado" }));

test("Exemplo do card: disponível 60%, falta 400 mil, ritmo 8 mil → 50 meses; com 20 mil já gastos → 48 meses e ritmo necessário de R$ 10.555,56 em 36 meses", () => {
  // custo 1.000.000, reserva 300.000, patrimônio 900.000; saldo médio 2.000 e rendimento 6.000
  const meses = mesesAte("2026-09", 12);
  const linhas = ["2025-09", ...meses].map((m) => linha(m, "28", "nubank", "Paola", R(900000), R(6000)));
  const base = {
    linhasPatrimonio: linhas, estados: fechados(meses),
    saldos: meses.map((mes) => ({ mes, saldo_cents: R(2000) })),
  };
  const param = { custo_total_cents: R(1000000), reserva_cents: R(300000), data_alvo: null };
  const a = montarCasa(meses, "2026-10", { ...base, param, jaGastoCents: 0 });
  const set = a.meses[11];
  assert.equal(set.disponivel_cents, R(600000));
  assert.equal(set.pct_coberto, 60);
  assert.equal(set.falta_cents, R(400000));
  assert.equal(a.ritmo_cents, R(8000));
  assert.equal(a.saldo_medio_cents, R(2000));
  assert.equal(a.rendimento_medio_cents, R(6000));
  assert.equal(a.projecao_meses, 50);

  // R$ 20.000 lançados em Projeto Casa (o projeto do arquiteto): abatem da falta, não do ritmo
  const alvo = somaMeses("2026-09", 36) + "-15";
  const b = montarCasa(meses, "2026-10", { ...base, param: { ...param, data_alvo: alvo }, jaGastoCents: R(20000) });
  assert.equal(b.meses[11].falta_cents, R(380000));
  assert.equal(b.ritmo_cents, R(8000));
  assert.equal(b.projecao_meses, 48); // teto(47,5)
  assert.equal(b.meses_ate_alvo, 36);
  assert.equal(b.ritmo_necessario_cents, 1055556); // R$ 10.555,56 ≈ R$ 10.556, arredondado para cima
});

test("a) a janela do ritmo pula o mês corrente e os meses não fechados: são os 6 últimos FECHADOS", () => {
  const meses = mesesAte("2026-10", 12);
  // 2026-10 é o mês corrente: mesmo que viesse 'fechado', não acabou — não entra
  const estados = fechados(meses, { "2026-09": "faltando", "2026-06": "parcial" });
  assert.deepEqual(janelaRitmo(estados, "2026-10"), ["2026-02", "2026-03", "2026-04", "2026-05", "2026-07", "2026-08"]);

  // o mês fora da janela, por maior que seja o saldo, não mexe no ritmo
  const saldos = meses.map((mes) => ({ mes, saldo_cents: ["2026-09", "2026-10", "2026-06"].includes(mes) ? R(99999) : R(1000) }));
  const r = montarCasa(meses, "2026-10", { estados, saldos });
  assert.equal(r.n_meses_ritmo, 6);
  assert.equal(r.ritmo_cents, R(1000));
});

test("a) com menos de 6 fechados, a média é sobre os que houver e a resposta diz quantos; com nenhum, ritmo null", () => {
  const meses = mesesAte("2026-09", 12);
  const estados = meses.map((mes) => ({ mes, estado: mes >= "2026-07" ? "fechado" : "faltando" }));
  const saldos = [{ mes: "2026-07", saldo_cents: R(1000) }, { mes: "2026-08", saldo_cents: R(3000) }, { mes: "2026-09", saldo_cents: R(2000) }];
  const r = montarCasa(meses, "2026-10", { estados, saldos });
  assert.equal(r.n_meses_ritmo, 3);
  assert.equal(r.ritmo_cents, R(2000));

  const nada = montarCasa(meses, "2026-10", { estados: fechados(meses, Object.fromEntries(meses.map((m) => [m, "faltando"]))), saldos });
  assert.equal(nada.n_meses_ritmo, 0);
  assert.equal(nada.ritmo_cents, null);
  assert.ok(nada.avisos.includes(AVISOS.semFechado));
});

test("b) rendimento que existe em só parte dos meses: a média é só onde existe (null não vira zero) e diz N de 6", () => {
  const janela = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
  const rend = { "2026-03": R(300), "2026-05": R(600), "2026-08": R(900) };
  const rendimentos = janela.map((mes) => ({
    mes,
    porConta: [
      { conta: "c6", pessoa: "Caio", rendimento_cents: rend[mes] ?? null },
      { conta: "nubank", pessoa: "Paola", rendimento_cents: R(100) },
    ],
  }));
  const r = calcularRitmo(janela, { rendimentos });
  const c6 = r.rendimento_meses_por_conta.find((c) => c.conta === "c6");
  // se o null virasse zero, a média seria 300; o certo é 600
  assert.deepEqual(c6, { conta: "c6", pessoa: "Caio", n_meses: 3, de_meses: 6, media_cents: R(600) });
  const nu = r.rendimento_meses_por_conta.find((c) => c.conta === "nubank");
  assert.equal(nu.n_meses, 6);
  // o rendimento do ritmo é a soma das médias por conta
  assert.equal(r.rendimento_medio_cents, R(700));
  assert.equal(r.ritmo_cents, R(700)); // sem saldo informado
});

test("b) conta sem rendimento em nenhum mês da janela: média null e 0 de 6, sem puxar o ritmo para baixo", () => {
  const janela = ["2026-07", "2026-08"];
  const rendimentos = janela.map((mes) => ({ mes, porConta: [{ conta: "itau", pessoa: "Caio", rendimento_cents: null }] }));
  const r = calcularRitmo(janela, { saldos: janela.map((mes) => ({ mes, saldo_cents: R(500) })), rendimentos });
  assert.deepEqual(r.rendimento_meses_por_conta, [{ conta: "itau", pessoa: "Caio", n_meses: 0, de_meses: 2, media_cents: null }]);
  assert.equal(r.ritmo_cents, R(500));
});

test("c) conta sem print no mês usa a última foto anterior, com a data da foto antiga — inclusive de antes dos 12 meses", () => {
  const meses = mesesAte("2026-09", 12);
  const linhas = [
    linha("2025-06", "10", "c6", "Caio", R(1000)),      // antes da janela: carregada até o fim
    linha("2026-05", "20", "nubank", "Paola", R(5000)),
    linha("2026-07", "02", "nubank", "Paola", R(6000)),
  ];
  const serie = patrimonioCarregado(meses, linhas);
  assert.equal(serie[0].mes, "2025-10");
  assert.equal(serie[0].patrimonio_cents, R(1000));
  assert.deepEqual(serie[0].contas.map((c) => [c.conta, c.data_foto, c.carregada]), [["c6", "2025-06-10", true]]);
  const jun = serie.find((m) => m.mes === "2026-06");
  assert.equal(jun.patrimonio_cents, R(6000)); // c6 de 2025 + nubank de maio, carregada
  assert.deepEqual(jun.contas.map((c) => [c.conta, c.data_foto]), [["c6", "2025-06-10"], ["nubank", "2026-05-20"]]);
  const set = serie[11];
  assert.equal(set.patrimonio_cents, R(7000));
  assert.equal(set.data_foto_mais_antiga, "2025-06-10");
  assert.deepEqual(set.contas.find((c) => c.conta === "nubank"), { conta: "nubank", pessoa: "Paola", data_foto: "2026-07-02", mes_foto: "2026-07", total_cents: R(6000), carregada: true });
});

test("d) despesa da Projeto Casa é somada de volta ao saldo (não reduz o ritmo) e abatida da falta", () => {
  const meses = mesesAte("2026-09", 12);
  // em agosto saíram 1.200 para a obra: o saldo do G1 caiu de 2.000 para 800
  const saldos = meses.map((mes) => ({ mes, saldo_cents: mes === "2026-08" ? R(800) : R(2000) }));
  const despesaCasa = [{ mes: "2026-08", despesa_cents: R(1200) }];
  const linhas = [linha("2026-09", "01", "c6", "Caio", R(500000))];
  const param = { custo_total_cents: R(600000), reserva_cents: R(100000), data_alvo: null };
  const r = montarCasa(meses, "2026-10", { param, linhasPatrimonio: linhas, estados: fechados(meses), saldos, despesaCasa, jaGastoCents: R(1200) });
  assert.equal(r.ritmo_cents, R(2000));
  // falta = 600.000 − 400.000 − 1.200
  assert.equal(r.meses[11].falta_cents, R(198800));
  assert.equal(r.ja_gasto_cents, R(1200));
});

test("sem foto: zero linhas de patrimônio → patrimônio, disponível, % e falta null (nunca 0) e sem projeção", () => {
  const meses = mesesAte("2026-10", 12);
  const param = { custo_total_cents: R(1000000), reserva_cents: R(300000), data_alvo: "2029-01-01" };
  const r = montarCasa(meses, "2026-10", { param, estados: fechados(meses), saldos: meses.map((mes) => ({ mes, saldo_cents: R(2000) })) });
  for (const m of r.meses) {
    assert.equal(m.patrimonio_cents, null);
    assert.equal(m.disponivel_cents, null);
    assert.equal(m.pct_coberto, null);
    assert.equal(m.falta_cents, null);
  }
  assert.equal(r.projecao_meses, null);
  assert.equal(r.ritmo_necessario_cents, null);
  assert.ok(r.avisos.includes(AVISOS.semFoto));
});

test("sem foto: nos meses anteriores à primeira foto os campos vêm null; a partir dela, os números", () => {
  const meses = mesesAte("2026-09", 12);
  const param = { custo_total_cents: R(1000000), reserva_cents: R(300000), data_alvo: null };
  const r = montarCasa(meses, "2026-10", { param, linhasPatrimonio: [linha("2026-07", "15", "c6", "Caio", R(400000))] });
  const antes = r.meses.filter((m) => m.mes < "2026-07");
  assert.equal(antes.length, 9);
  for (const m of antes) assert.deepEqual([m.patrimonio_cents, m.disponivel_cents, m.pct_coberto, m.falta_cents], [null, null, null, null]);
  assert.equal(r.meses[9].disponivel_cents, R(100000));
  assert.equal(r.meses[11].falta_cents, R(900000)); // agosto e setembro carregam a foto de julho
});

test("sem parâmetros: patrimônio aparece, mas disponível/%/falta ficam null e avisa", () => {
  const meses = mesesAte("2026-09", 12);
  const r = montarCasa(meses, "2026-10", { linhasPatrimonio: [linha("2026-09", "01", "c6", "Caio", R(100))] });
  assert.equal(r.meses[11].patrimonio_cents, R(100));
  assert.equal(r.meses[11].disponivel_cents, null);
  assert.ok(r.avisos.includes(AVISOS.semParam));
});

test("falta ≤ 0 (o disponível já cobre): projeção 0 e ritmo necessário 0, sem divisão", () => {
  const p = projetar({ ate: "2026-09", falta_cents: -R(10), ritmo_cents: R(100), data_alvo: "2027-09-01" });
  assert.equal(p.projecao_meses, 0);
  assert.equal(p.projecao_mes, "2026-09");
  assert.equal(p.ritmo_necessario_cents, 0);
});

test("ritmo ≤ 0: sem projeção, com o aviso", () => {
  for (const ritmo of [0, -R(500)]) {
    const p = projetar({ ate: "2026-09", falta_cents: R(1000), ritmo_cents: ritmo });
    assert.equal(p.projecao_meses, null);
    assert.ok(p.avisos.includes(AVISOS.ritmoNaoPositivo));
  }
});

test("data alvo no mês de `ate` ou antes: ritmo necessário null, com aviso de data vencida", () => {
  for (const alvo of ["2026-09-30", "2026-01-01"]) {
    const p = projetar({ ate: "2026-09", falta_cents: R(1000), ritmo_cents: R(100), data_alvo: alvo });
    assert.equal(p.ritmo_necessario_cents, null);
    assert.ok(p.avisos.includes(AVISOS.alvoVencido));
  }
  // um mês à frente já dá conta
  assert.equal(projetar({ ate: "2026-09", falta_cents: R(1000), ritmo_cents: R(100), data_alvo: "2026-10-01" }).ritmo_necessario_cents, R(1000));
});

test("projeção vem também como mês (ate + N meses) para a tela mostrar a data", () => {
  assert.equal(projetar({ ate: "2026-09", falta_cents: R(250), ritmo_cents: R(100) }).projecao_mes, "2026-12");
  assert.equal(somaMeses("2026-11", 14), "2028-01");
  assert.equal(mesesEntre("2026-09", "2029-09-15"), 36);
});

test("validarParamCasa: aceita YYYY-MM ou YYYY-MM-DD (vira dia 01) e recusa com mensagem o que for inválido", () => {
  assert.deepEqual(validarParamCasa({ vigente_desde: "2026-10", custo_total_cents: 100, reserva_cents: 0, data_alvo: null }),
    { vigente_desde: "2026-10-01", custo_total_cents: 100, reserva_cents: 0, data_alvo: null });
  assert.equal(validarParamCasa({ vigente_desde: "2026-10-17", custo_total_cents: 100, reserva_cents: 5, data_alvo: "2029-06-30" }).vigente_desde, "2026-10-01");
  for (const b of [
    { vigente_desde: "2026-13", custo_total_cents: 100, reserva_cents: 0 },
    { vigente_desde: "2026-02-30", custo_total_cents: 100, reserva_cents: 0 },
    { vigente_desde: "2026-10", custo_total_cents: 0, reserva_cents: 0 },
    { vigente_desde: "2026-10", custo_total_cents: 10.5, reserva_cents: 0 },
    { vigente_desde: "2026-10", custo_total_cents: 100, reserva_cents: -1 },
    { vigente_desde: "2026-10", custo_total_cents: 100, reserva_cents: "5" },
    { vigente_desde: "2026-10", custo_total_cents: 100, reserva_cents: 0, data_alvo: "2029-06" },
    null,
  ]) assert.match(validarParamCasa(b).erro || "", /inválid/, JSON.stringify(b));
});

test("paramVigente: o mais recente com vigente_desde até o mês; nenhum antes → null", () => {
  const ps = [{ vigente_desde: "2026-01-01", custo_total_cents: 1 }, { vigente_desde: "2026-08-01", custo_total_cents: 2 }];
  assert.equal(paramVigente(ps, "2026-09").custo_total_cents, 2);
  assert.equal(paramVigente(ps, "2026-07").custo_total_cents, 1);
  assert.equal(paramVigente(ps, "2025-12"), null);
  assert.equal(paramVigente([], "2026-09"), null);
});

test("A4: a família fgts entra no \"quanto já temos\" (o FGTS pode ir para a compra do imóvel)", () => {
  const linhas = [
    { ...linha("2026-10", "13", "fgts", "Caio", R(3000)), familia: "fgts" },
    linha("2026-10", "09", "itau", "Caio", R(1000)),
  ];
  const serie = patrimonioCarregado(["2026-10"], linhas);
  assert.equal(serie[0].patrimonio_cents, R(4000));
  assert.equal(serie[0].contas.find((c) => c.conta === "fgts").total_cents, R(3000));
});
