import { test } from "node:test";
import assert from "node:assert/strict";
import {
  totalContaData, fotoDoMes, cobreMes, rendimentoDoMes, montarPatrimonio, rotuloRendimento,
  parsePatrimonio, normalizarConta, caminhoPatrimonio, dataDaMensagem, textoConfirmacao,
} from "./patrimonio.js";

// Todos os valores são inventados (o repositório é público). R$ 1.000,00 = 100000 centavos.
const R = (reais) => reais * 100;

test("totalContaData: quatro títulos de renda fixa substituem o agregado do mesmo print (não conta duas vezes)", () => {
  // o print mostra o agregado "CDB, Renda Fixa e Estruturados" e, abaixo, os quatro títulos que o
  // compõem — somar tudo dobraria a renda fixa
  const print = [
    { familia: "renda_fixa", nivel: "agregado", saldo_cents: R(100000) },
    { familia: "renda_fixa", nivel: "titulo", saldo_cents: R(40000) },
    { familia: "renda_fixa", nivel: "titulo", saldo_cents: R(30000) },
    { familia: "renda_fixa", nivel: "titulo", saldo_cents: R(20000) },
    { familia: "renda_fixa", nivel: "titulo", saldo_cents: R(10000) },
    { familia: "fundos", nivel: "agregado", saldo_cents: R(5000) },
  ];
  const r = totalContaData(print);
  assert.equal(r.total_cents, R(105000));
  assert.deepEqual(r.porFamilia, { renda_fixa: R(100000), fundos: R(5000) });
});

test("totalContaData: sem título da família, o agregado conta", () => {
  // Exemplo do card: Itaú do Caio = 500k + 250k + 20k
  const r = totalContaData([
    { familia: "fundos", nivel: "agregado", saldo_cents: R(500000) },
    { familia: "renda_fixa", nivel: "agregado", saldo_cents: R(250000) },
    { familia: "caixa", nivel: "agregado", saldo_cents: R(20000) },
  ]);
  assert.equal(r.total_cents, R(770000));
});

test("fotoDoMes (a): detalhe de títulos no dia 05 e agregado no dia 20 não contam a renda fixa duas vezes", () => {
  const linhas = [
    { data: "2026-10-05", familia: "renda_fixa", nivel: "titulo", saldo_cents: R(150000) },
    { data: "2026-10-05", familia: "renda_fixa", nivel: "titulo", saldo_cents: R(100000) },
    { data: "2026-10-20", familia: "renda_fixa", nivel: "agregado", saldo_cents: R(252000) },
  ];
  const f = fotoDoMes(linhas);
  // vale a última data em que a família apareceu: o agregado do dia 20
  assert.equal(f.total_cents, R(252000));
  assert.equal(f.data, "2026-10-20");
});

test("fotoDoMes (b): um print só de Fundos não apaga as outras famílias (seguem pela última data em que apareceram)", () => {
  const linhas = [
    { data: "2026-10-09", familia: "fundos", nivel: "agregado", saldo_cents: R(500000) },
    { data: "2026-10-09", familia: "renda_fixa", nivel: "agregado", saldo_cents: R(250000) },
    { data: "2026-10-09", familia: "caixa", nivel: "agregado", saldo_cents: R(20000) },
    { data: "2026-10-25", familia: "fundos", nivel: "agregado", saldo_cents: R(510000) },
  ];
  const f = fotoDoMes(linhas);
  assert.equal(f.total_cents, R(510000 + 250000 + 20000));
  assert.deepEqual(f.porFamilia, { fundos: R(510000), renda_fixa: R(250000), caixa: R(20000) });
});

test("fotoDoMes: rendimento do print só soma o de período 'mes'; sem nenhum, null (não zero)", () => {
  const comMes = fotoDoMes([{ data: "2026-10-09", familia: "caixa", nivel: "agregado", saldo_cents: R(1000), rend_mes_cents: R(10), n_rend_mes: 1 }]);
  assert.equal(comMes.rendimento_print_cents, R(10));
  const semMes = fotoDoMes([{ data: "2026-10-09", familia: "caixa", nivel: "agregado", saldo_cents: R(1000), rend_mes_cents: null, n_rend_mes: 0 }]);
  assert.equal(semMes.rendimento_print_cents, null);
  assert.equal(fotoDoMes([]), null);
});

test("cobreMes: o extrato tem que ir do dia 01 ao último dia do mês; registros que se encostam somam", () => {
  const p = [{ de: "2025-07-01", ate: "2026-09-02" }];
  assert.equal(cobreMes(p, "2026-08"), true);
  assert.equal(cobreMes(p, "2026-09"), false); // vai só até o dia 02
  assert.equal(cobreMes(p, "2025-06"), false);
  assert.equal(cobreMes([{ de: "2026-08-01", ate: "2026-08-15" }, { de: "2026-08-16", ate: "2026-09-01" }], "2026-08"), true);
  assert.equal(cobreMes([{ de: "2026-08-01", ate: "2026-08-14" }, { de: "2026-08-16", ate: "2026-09-01" }], "2026-08"), false);
  assert.equal(cobreMes([{ de: null, ate: "2026-09-30" }], "2026-08"), false); // sem `de`, não prova o começo
});

const foto = (total_cents, rendimento_print_cents = null) => ({ total_cents, rendimento_print_cents });

test("rendimentoDoMes calculado (Exemplo): 785k − (770k + 10k aporte − 0) = 5k", () => {
  const r = rendimentoDoMes({ calculada: true, coberto: true, foto: foto(R(785000)), fotoAnterior: foto(R(770000)), aportes_cents: R(10000), resgates_cents: 0 });
  assert.deepEqual(r, { rendimento_cents: R(5000), origem: "calculado", motivo: null });
});

test("rendimentoDoMes calculado: resgate soma de volta (saiu da conta, não é perda)", () => {
  const r = rendimentoDoMes({ calculada: true, coberto: true, foto: foto(R(760000)), fotoAnterior: foto(R(770000)), aportes_cents: 0, resgates_cents: R(12000) });
  assert.equal(r.rendimento_cents, R(2000));
});

test("rendimentoDoMes calculado sem o extrato cobrindo o mês → sem rendimento (extrato pendente)", () => {
  const r = rendimentoDoMes({ calculada: true, coberto: false, foto: foto(R(785000)), fotoAnterior: foto(R(770000)) });
  assert.equal(r.rendimento_cents, null);
  assert.equal(r.origem, "sem");
  assert.equal(rotuloRendimento(r), "sem rendimento (extrato pendente)");
});

test("rendimentoDoMes: mês sem print anterior fica sem rendimento — null, não zero", () => {
  const calc = rendimentoDoMes({ calculada: true, coberto: true, foto: foto(R(785000)), fotoAnterior: null });
  assert.equal(calc.rendimento_cents, null);
  assert.equal(calc.origem, "sem");
  const prt = rendimentoDoMes({ calculada: false, foto: foto(R(200000), R(1500)), fotoAnterior: null });
  assert.equal(prt.rendimento_cents, null);
});

test("rendimentoDoMes nas outras contas: vale o do print com período 'mes'; outro período fica sem", () => {
  const comMes = rendimentoDoMes({ calculada: false, foto: foto(R(200000), R(1500)), fotoAnterior: foto(R(198000)) });
  assert.deepEqual(comMes, { rendimento_cents: R(1500), origem: "print", motivo: null });
  const outro = rendimentoDoMes({ calculada: false, foto: foto(R(200000), null), fotoAnterior: foto(R(198000)) });
  assert.equal(outro.rendimento_cents, null);
  assert.equal(outro.origem, "sem");
});

// linhas como o SQL devolve (somadas por mes, data, conta, pessoa, família, nível)
const L = (mes, data, conta, pessoa, familia, nivel, reais, rendMes = null) =>
  ({ mes, data, conta, pessoa, familia, nivel, saldo_cents: R(reais), rend_mes_cents: rendMes == null ? null : R(rendMes), n_rend_mes: rendMes == null ? 0 : 1 });

test("montarPatrimonio (Exemplo do card): total 970k, Caio 770k, Paola 200k; o detalhe da renda fixa não muda o total", () => {
  const linhas = [
    L("2026-10", "2026-10-09", "itau", "Caio", "fundos", "agregado", 500000),
    L("2026-10", "2026-10-09", "itau", "Caio", "renda_fixa", "agregado", 250000),
    L("2026-10", "2026-10-09", "itau", "Caio", "caixa", "agregado", 20000),
    L("2026-10", "2026-10-09", "c6", "Paola", "renda_fixa", "agregado", 200000),
    // segundo print do Itaú no mesmo dia: CDB 150k + Tesouro 100k
    L("2026-10", "2026-10-09", "itau", "Caio", "renda_fixa", "titulo", 250000),
  ];
  const r = montarPatrimonio(["2026-09", "2026-10"], { linhas, periodosItau: [{ de: "2025-07-01", ate: "2026-09-02" }] });
  const out = r.meses[1];
  assert.equal(out.total_cents, R(970000));
  assert.deepEqual(out.porPessoa.sort((a, b) => a.pessoa.localeCompare(b.pessoa)), [
    { pessoa: "Caio", total_cents: R(770000) }, { pessoa: "Paola", total_cents: R(200000) },
  ]);
  const itau = out.porConta.find((c) => c.conta === "itau");
  assert.equal(itau.total_cents, R(770000));
  // setembro: nenhum print → total null, não zero
  assert.equal(r.meses[0].total_cents, null);
  // hoje o extrato do Itaú vai até 02/09: outubro é "extrato pendente"
  assert.equal(itau.origem, "sem");
  assert.equal(itau.motivo, "extrato pendente");
  assert.equal(r.meses[0].porConta.find((c) => c.conta === "itau").motivo, "extrato pendente");
});

test("montarPatrimonio: novembro com aporte e extrato cobrindo → rendimento calculado no Itaú do Caio; C6 usa o print", () => {
  const linhas = [
    L("2026-10", "2026-10-09", "itau", "Caio", "fundos", "agregado", 770000),
    L("2026-11", "2026-11-10", "itau", "Caio", "fundos", "agregado", 785000),
    L("2026-10", "2026-10-09", "c6", "Paola", "renda_fixa", "agregado", 200000),
    L("2026-11", "2026-11-10", "c6", "Paola", "renda_fixa", "agregado", 201500, 1500),
  ];
  const r = montarPatrimonio(["2026-10", "2026-11"], {
    linhas,
    aportes: [{ mes: "2026-11", aportes_cents: R(10000), resgates_cents: 0 }],
    periodosItau: [{ de: "2025-07-01", ate: "2026-12-01" }],
  });
  const nov = r.meses[1];
  const itau = nov.porConta.find((c) => c.conta === "itau");
  assert.equal(itau.rendimento_cents, R(5000));
  assert.equal(itau.origem, "calculado");
  const c6 = nov.porConta.find((c) => c.conta === "c6");
  assert.equal(c6.rendimento_cents, R(1500));
  assert.equal(c6.origem, "print");
  // outubro: o mês anterior (setembro) veio sem print → sem rendimento, nos dois
  assert.equal(r.meses[0].porConta.find((c) => c.conta === "itau").rendimento_cents, null);
  assert.equal(r.meses[0].porConta.find((c) => c.conta === "c6").motivo, "sem print anterior");
});

test("montarPatrimonio: o C6 do Caio não é a conta calculada (só o Itaú do Caio)", () => {
  const linhas = [
    L("2026-10", "2026-10-09", "c6", "Caio", "renda_fixa", "agregado", 1000),
    L("2026-11", "2026-11-09", "c6", "Caio", "renda_fixa", "agregado", 1100),
  ];
  const r = montarPatrimonio(["2026-11"], { linhas, aportes: [{ mes: "2026-11", aportes_cents: R(50), resgates_cents: 0 }], periodosItau: [{ de: "2026-01-01", ate: "2026-12-31" }] });
  assert.equal(r.meses[0].porConta[0].origem, "sem"); // sem rendimento do print com período mês
});

test("parsePatrimonio: legenda /patrimonio com pessoa e conta em qualquer ordem; outra legenda → null", () => {
  assert.deepEqual(parsePatrimonio("/patrimonio paola c6"), { conta: "c6", pessoa: "paola" });
  assert.deepEqual(parsePatrimonio("/patrimonio Itaú Caio"), { conta: "itau", pessoa: "Caio" });
  assert.deepEqual(parsePatrimonio("/patrimonio mercado pago paola"), { conta: "mercadopago", pessoa: "paola" });
  assert.deepEqual(parsePatrimonio("/patrimonio"), { conta: null, pessoa: null });
  assert.equal(parsePatrimonio("/aprender Casa"), null);
  assert.equal(parsePatrimonio(null), null);
});

test("normalizarConta: nomes do app viram o vocabulário; desconhecida → null", () => {
  assert.equal(normalizarConta("Itaú"), "itau");
  assert.equal(normalizarConta("C6 Bank"), "c6");
  assert.equal(normalizarConta("Nubank"), "nubank");
  assert.equal(normalizarConta("Mercado Pago"), "mercadopago");
  assert.equal(normalizarConta("Banco X"), null);
});

test("caminhoPatrimonio: /Finanças/Patrimônio/AAAA/AAAA-MM-DD_<conta>_<pessoa>.<ext>", () => {
  assert.equal(caminhoPatrimonio({ dataISO: "2026-10-09", conta: "c6", pessoa: "Paola", ext: "jpg" }), "/Finanças/Patrimônio/2026/2026-10-09_c6_paola.jpg");
});

test("dataDaMensagem: horário de Brasília (22h do dia 09 não vira dia 10)", () => {
  // 2026-10-10T01:00:00Z = 09/10 às 22h em Brasília
  assert.equal(dataDaMensagem(Date.UTC(2026, 9, 10, 1, 0, 0) / 1000), "2026-10-09");
});

test("textoConfirmacao: traz o total (sem contar duas vezes) e o número de produtos", () => {
  const t = textoConfirmacao({ conta: "itau", pessoa: "Caio", dataISO: "2026-10-09", produtos: [
    { familia: "renda_fixa", nivel: "agregado", saldo_cents: R(250000) },
    { familia: "renda_fixa", nivel: "titulo", saldo_cents: R(150000) },
    { familia: "renda_fixa", nivel: "titulo", saldo_cents: R(100000) },
  ] });
  assert.match(t, /250\.000,00/);
  assert.match(t, /3 produtos/);
  assert.match(t, /09\/10\/2026/);
});
