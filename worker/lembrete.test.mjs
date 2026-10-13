import { test } from "node:test";
import assert from "node:assert/strict";
import { montarLembrete, contasSemFotoDoMes, momentoDoLembrete, idsDaAllowlist, enviarLembrete } from "./lembrete.js";
import { estadoDoMes } from "./fechamento.js";
import { montarPatrimonio } from "./patrimonio.js";
import { responder } from "./telegram.js";
import { executarLembrete } from "./index.js";

// Valores e nomes inventados: o repositório é público.

// outubro, com o mês corrente em novembro (o mês anterior ao disparo do dia 5/11)
const outubro = (p = {}) => estadoDoMes({
  mes: "2026-10", mesCorrente: "2026-11",
  itauAte: "2026-10-31", c6Ate: "2026-10-31", faturaExiste: true, semCategoria: 0, salarioEstimado: false,
  ...p,
});
const C6_PAOLA = { conta: "C6", pessoa: "Paola" };

// ---- dia 5 ----

test("dia 5, mês faltando: lista cada fonte que falta, a contagem sem categoria e o print do patrimônio (o Exemplo do card)", () => {
  const texto = montarLembrete({
    dia: 5,
    mesAnterior: outubro({ itauAte: "2026-10-28", faturaExiste: false, semCategoria: 7 }),
    contasSemFoto: [C6_PAOLA],
    temDiagnostico: false,
  });
  assert.equal(texto, [
    "📅 Fechamento de outubro: falta",
    "• Itaú: extrato depois de 28/10",
    "• fatura de outubro",
    "• 7 transações sem categoria",
    "Patrimônio de novembro: falta o print do C6 (Paola).",
  ].join("\n"));
});

test("dia 5, mês faltando: C6 sem import algum e salário estimado também entram na lista", () => {
  const texto = montarLembrete({
    dia: 5,
    mesAnterior: outubro({ c6Ate: null, salarioEstimado: true }),
    contasSemFoto: [],
    temDiagnostico: false,
  });
  assert.match(texto, /Fechamento de outubro: falta/);
  assert.match(texto, /• C6: nenhum extrato importado/);
  assert.match(texto, /• salário estimado/);
  // sem nenhuma sem categoria, a linha não aparece (não é "0 transações")
  assert.doesNotMatch(texto, /sem categoria/);
  assert.doesNotMatch(texto, /Patrimônio/);
});

test("dia 5, mês parcial (C6 só até o meio do mês): diz até quando chegou", () => {
  const texto = montarLembrete({
    dia: 5, mesAnterior: outubro({ c6Ate: "2026-10-15" }), contasSemFoto: [], temDiagnostico: false,
  });
  assert.match(texto, /• C6: extrato depois de 15\/10/);
  assert.doesNotMatch(texto, /Itaú/);
});

test("dia 5, mês fechado sem diagnóstico: avisa que fechou e que o diagnóstico pode ser pedido", () => {
  const texto = montarLembrete({ dia: 5, mesAnterior: outubro(), contasSemFoto: [], temDiagnostico: false });
  assert.equal(texto, "📅 Outubro fechado — pode pedir o diagnóstico.");
});

test("dia 5, mês fechado com sem categoria e salário estimado: os dois aparecem como informação", () => {
  const texto = montarLembrete({
    dia: 5, mesAnterior: outubro({ semCategoria: 55, salarioEstimado: true }),
    contasSemFoto: [], temDiagnostico: false,
  });
  assert.equal(texto, "📅 Outubro fechado (55 sem categoria, salário estimado) — pode pedir o diagnóstico.");
});

test("dia 5, mês fechado sem diagnóstico e conta sem foto: as duas coisas na mesma mensagem", () => {
  const texto = montarLembrete({
    dia: 5, mesAnterior: outubro({ semCategoria: 3 }),
    contasSemFoto: [C6_PAOLA, { conta: "XP", pessoa: "Caio" }], temDiagnostico: false,
  });
  assert.equal(texto, [
    "📅 Outubro fechado (3 sem categoria) — pode pedir o diagnóstico.",
    "Patrimônio de novembro: falta o print do C6 (Paola) e do XP (Caio).",
  ].join("\n"));
});

test("dia 5, diagnóstico já salvo: o aviso de mês fechado não volta; sobra só o print que falta", () => {
  const texto = montarLembrete({
    dia: 5, mesAnterior: outubro({ semCategoria: 3 }), contasSemFoto: [C6_PAOLA], temDiagnostico: true,
  });
  assert.equal(texto, "Patrimônio de novembro: falta o print do C6 (Paola).");
});

test("dia 5, diagnóstico já salvo e todas as contas com foto: nada a dizer, nenhuma mensagem", () => {
  const texto = montarLembrete({ dia: 5, mesAnterior: outubro({ semCategoria: 3 }), contasSemFoto: [], temDiagnostico: true });
  assert.equal(texto, null);
});

// ---- dia 15 ----

test("dia 15, tudo em dia: silêncio", () => {
  assert.equal(montarLembrete({ dia: 15, mesAnterior: outubro(), contasSemFoto: [], temDiagnostico: true }), null);
});

test("dia 15, mês fechado só com sem categoria e salário estimado, diagnóstico salvo: não é pendência, silêncio", () => {
  // se sem categoria contasse, o bot reclamaria todo dia 15 (decisão do Caio, 13/10)
  const texto = montarLembrete({
    dia: 15, mesAnterior: outubro({ semCategoria: 3, salarioEstimado: true }),
    contasSemFoto: [], temDiagnostico: true,
  });
  assert.equal(texto, null);
});

test("dia 15, mês ainda faltando: avisa de novo com o que falta", () => {
  const texto = montarLembrete({
    dia: 15, mesAnterior: outubro({ faturaExiste: false }), contasSemFoto: [], temDiagnostico: false,
  });
  assert.match(texto, /Fechamento de outubro: falta\n• fatura de outubro/);
});

test("dia 15, mês fechado sem diagnóstico: o aviso de mês fechado repete até o diagnóstico ser salvo", () => {
  const texto = montarLembrete({ dia: 15, mesAnterior: outubro({ semCategoria: 3 }), contasSemFoto: [], temDiagnostico: false });
  assert.equal(texto, "📅 Outubro fechado (3 sem categoria) — pode pedir o diagnóstico.");
});

test("dia 15, só uma conta sem foto no mês: é pendência", () => {
  const texto = montarLembrete({ dia: 15, mesAnterior: outubro(), contasSemFoto: [C6_PAOLA], temDiagnostico: true });
  assert.equal(texto, "Patrimônio de novembro: falta o print do C6 (Paola).");
});

// ---- contas sem foto ----

test("conta com print mas sem rendimento (Itaú calculado, extrato pendente) não conta como sem foto", () => {
  // o Itaú calculado tem origem 'sem' enquanto o extrato não cobre o mês, mesmo com a foto
  // carregada; o critério é total_cents == null, nunca origem
  const linha = (mes, data, conta, pessoa, saldo_cents) => ({
    mes, data, conta, pessoa, familia: "Conta", nivel: "titulo", saldo_cents, rend_mes_cents: null, n_rend_mes: 0,
  });
  const pat = montarPatrimonio(["2026-10", "2026-11"], {
    linhas: [
      linha("2026-10", "2026-10-31", "itau", "Caio", 100000),
      linha("2026-11", "2026-11-03", "itau", "Caio", 110000),
      linha("2026-10", "2026-10-31", "C6", "Paola", 50000),
    ],
    periodosItau: [],
  });
  const itauNov = pat.meses[1].porConta.find((c) => c.conta === "itau");
  assert.equal(itauNov.origem, "sem"); // a armadilha: sem rendimento, mas com foto
  assert.deepEqual(contasSemFotoDoMes(pat, "2026-11"), [{ conta: "C6", pessoa: "Paola" }]);
});

test("contasSemFotoDoMes: mês fora da série devolve lista vazia", () => {
  assert.deepEqual(contasSemFotoDoMes({ meses: [] }, "2026-11"), []);
});

// ---- relógio do cron e destinatários ----

test("momentoDoLembrete: dia, mês corrente e anterior saem do scheduledTime em UTC (virada de ano)", () => {
  assert.deepEqual(momentoDoLembrete(Date.UTC(2027, 0, 5, 12)), { dia: 5, mesCorrente: "2027-01", mesAnterior: "2026-12" });
  assert.deepEqual(momentoDoLembrete(Date.UTC(2026, 10, 15, 12)), { dia: 15, mesCorrente: "2026-11", mesAnterior: "2026-10" });
});

test("idsDaAllowlist: CSV com espaços e vazios, como o webhook lê", () => {
  assert.deepEqual(idsDaAllowlist(" 111, ,222 ,"), ["111", "222"]);
  assert.deepEqual(idsDaAllowlist(""), []);
  assert.deepEqual(idsDaAllowlist(undefined), []);
});

const fetchContador = () => {
  const chamadas = [];
  const f = async (url, init) => { chamadas.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  f.chamadas = chamadas;
  return f;
};

test("enviarLembrete: ALLOWLIST vazio não manda nada (falha fechada, como o webhook)", async () => {
  for (const vazio of ["", undefined, " , "]) {
    const f = fetchContador();
    await enviarLembrete("oi", vazio, "tok", f, responder);
    assert.equal(f.chamadas.length, 0);
  }
});

test("enviarLembrete: um envio por id; erro num id vai pro console.error e não impede o próximo", async () => {
  const chamadas = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    chamadas.push(body.chat_id);
    if (body.chat_id === "111") throw new Error("rede caiu");
    return { ok: true };
  };
  const erroOriginal = console.error;
  const erros = [];
  console.error = (...a) => erros.push(a.join(" "));
  try {
    await enviarLembrete("oi", "111,222", "tok", f, responder);
  } finally {
    console.error = erroOriginal;
  }
  assert.deepEqual(chamadas, ["111", "222"]);
  assert.equal(erros.length, 1);
});

// ---- o handler do cron (index.js) ----

function dbFakeLembrete({ diagnostico = null } = {}) {
  const lidos = [];
  return {
    lidos,
    coberturaImportacoes: async () => [
      { conta: "itau", tipo: "extrato", ate: "2026-10-31" },
      { conta: "c6", tipo: "extrato", ate: "2026-10-31" },
    ],
    faturasImportadas: async () => ["2026-10"],
    semCategoriaPorMes: async () => [{ mes: "2026-10", n: 3 }],
    salarioParams: async () => [],
    conversoes: async () => [],
    patrimonioPorDia: async () => [
      { mes: "2026-10", data: "2026-10-31", conta: "C6", pessoa: "Paola", familia: "Conta", nivel: "titulo", saldo_cents: 50000, rend_mes_cents: null, n_rend_mes: 0 },
    ],
    aportesInvestimentoPorMes: async () => [],
    periodosImportacao: async () => [],
    diagnosticoDoMes: async (mes) => { lidos.push(mes); return diagnostico; },
  };
}

test("executarLembrete: ALLOWLIST vazio não lê o banco nem chama fetch", async () => {
  const f = fetchContador();
  const db = { diagnosticoDoMes: async () => { throw new Error("não devia ler"); } };
  await executarLembrete({ ALLOWLIST: "", TELEGRAM_TOKEN: "tok" }, { agora: Date.UTC(2026, 10, 5, 12), db, fetchImpl: f });
  assert.equal(f.chamadas.length, 0);
});

test("executarLembrete: lê o mês anterior do scheduledTime e manda o texto montado", async () => {
  const f = fetchContador();
  const db = dbFakeLembrete();
  await executarLembrete({ ALLOWLIST: "111", TELEGRAM_TOKEN: "tok" }, { agora: Date.UTC(2026, 10, 15, 12), db, fetchImpl: f });
  assert.deepEqual(db.lidos, ["2026-10"]);
  assert.equal(f.chamadas.length, 1);
  assert.equal(f.chamadas[0].body.chat_id, "111");
  assert.equal(f.chamadas[0].body.text, [
    "📅 Outubro fechado (3 sem categoria) — pode pedir o diagnóstico.",
    "Patrimônio de novembro: falta o print do C6 (Paola).",
  ].join("\n"));
});

test("executarLembrete: erro do banco vai pro console.error e o cron não lança", async () => {
  const f = fetchContador();
  const db = dbFakeLembrete();
  db.coberturaImportacoes = async () => { throw new Error("banco fora"); };
  const erroOriginal = console.error;
  const erros = [];
  console.error = (...a) => erros.push(a.join(" "));
  try {
    await executarLembrete({ ALLOWLIST: "111", TELEGRAM_TOKEN: "tok" }, { agora: Date.UTC(2026, 10, 5, 12), db, fetchImpl: f });
  } finally {
    console.error = erroOriginal;
  }
  assert.equal(f.chamadas.length, 0);
  assert.equal(erros.length, 1);
});
