import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agruparMensal, centavosBR, kf, deltaPct, periodoRange, construirWaterfall, subsDaCat,
  agruparPorPessoa, filtrarTransacoes,
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
  assert.deepEqual(periodoRange("mespassado", h), { de: "2026-07-01", ate: "2026-07-31" });
});

test("periodoRange mespassado vira o ano em janeiro (jan → dez do ano anterior)", () => {
  const jan = new Date(Date.UTC(2026, 0, 10)); // 2026-01-10
  assert.deepEqual(periodoRange("mespassado", jan), { de: "2025-12-01", ate: "2025-12-31" });
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

test("agruparPorPessoa dobra receita/despesa da mesma pessoa numa linha, ordenado por despesa desc", () => {
  const rows = [
    { pessoa: "Caio", natureza: "despesa", total: "100.00" },
    { pessoa: "Caio", natureza: "receita", total: "300.00" },
    { pessoa: "Ana", natureza: "despesa", total: "500.00" },
    { pessoa: "—", natureza: "despesa", total: "20.00" }, // sem pessoa vinculada: rótulo vem pronto do backend
  ];
  assert.deepEqual(agruparPorPessoa(rows), [
    { pessoa: "Ana", receita: 0, despesa: 500, saldo: -500 },
    { pessoa: "Caio", receita: 300, despesa: 100, saldo: 200 },
    { pessoa: "—", receita: 0, despesa: 20, saldo: -20 },
  ]);
});

test("subsDaCat filtra subcategorias do catálogo por categoria_id, devolvendo só {id,nome}", () => {
  const catalogo = {
    categorias: [{ id: "c1", nome: "Casa" }, { id: "c2", nome: "Saúde" }],
    subcategorias: [
      { id: "s1", categoria_id: "c1", nome: "Luz" },
      { id: "s2", categoria_id: "c1", nome: "Água" },
      { id: "s3", categoria_id: "c2", nome: "Plano" },
    ],
  };
  assert.deepEqual(subsDaCat(catalogo, "c1"), [{ id: "s1", nome: "Luz" }, { id: "s2", nome: "Água" }]);
  assert.deepEqual(subsDaCat(catalogo, "c2"), [{ id: "s3", nome: "Plano" }]);
  // categoria sem subs (ou id inexistente) devolve lista vazia, nunca undefined
  assert.deepEqual(subsDaCat(catalogo, "c9"), []);
});

// ---------- filtrarTransacoes (Task A8: toolbar de filtro em Lançamentos) ----------

// fixture com as 4 dimensões variando, pra cada teste isolar uma delas.
// categoria = t.categoria (nome via join, Fase B — não é mais t.macro).
const T = [
  { id: 1, categoria: "Casa", pessoa: "Caio", pessoa_id: 1, origem_categoria: "modelo", descricao: "Supermercado", contraparte_nome: "Mercado Extra Ltda" },
  { id: 2, categoria: "Lazer", pessoa: "Ana", pessoa_id: 2, origem_categoria: "manual", descricao: "Cinema", contraparte_nome: null },
  { id: 3, categoria: "Casa", pessoa: null, pessoa_id: null, origem_categoria: "regra", descricao: "Conta de luz", contraparte_nome: "Cia Energia" },
  { id: 4, categoria: "Saúde", pessoa: "Caio", pessoa_id: 1, origem_categoria: "modelo", descricao: "Remédio", contraparte_nome: "Drogaria São Paulo" },
];

test("filtrarTransacoes sem filtro (objeto vazio ou omitido) devolve tudo", () => {
  assert.deepEqual(filtrarTransacoes(T, {}), T);
  assert.deepEqual(filtrarTransacoes(T), T);
});

test("filtrarTransacoes por categoria casa t.categoria exatamente; vazio ignora a dimensão", () => {
  assert.deepEqual(filtrarTransacoes(T, { categoria: "Casa" }).map(t => t.id), [1, 3]);
  assert.deepEqual(filtrarTransacoes(T, { categoria: "" }), T);
});

test("filtrarTransacoes por pessoa casa o nome; vazio ignora a dimensão", () => {
  assert.deepEqual(filtrarTransacoes(T, { pessoa: "Caio" }).map(t => t.id), [1, 4]);
  assert.deepEqual(filtrarTransacoes(T, { pessoa: "" }), T);
});

test("filtrarTransacoes pessoa '__sem__' pega só linhas sem pessoa_id", () => {
  assert.deepEqual(filtrarTransacoes(T, { pessoa: "__sem__" }).map(t => t.id), [3]);
});

test("filtrarTransacoes por origem casa origem_categoria; vazio ignora a dimensão", () => {
  assert.deepEqual(filtrarTransacoes(T, { origem: "regra" }).map(t => t.id), [3]);
  assert.deepEqual(filtrarTransacoes(T, { origem: "" }), T);
});

test("filtrarTransacoes por texto casa substring case-insensitive em descricao ou contraparte_nome", () => {
  // bate na descrição
  assert.deepEqual(filtrarTransacoes(T, { texto: "remédio" }).map(t => t.id), [4]);
  // bate na contraparte, com case diferente
  assert.deepEqual(filtrarTransacoes(T, { texto: "EXTRA" }).map(t => t.id), [1]);
  // contraparte_nome null não deve quebrar (trata como "")
  assert.deepEqual(filtrarTransacoes(T, { texto: "cinema" }).map(t => t.id), [2]);
});

test("filtrarTransacoes texto vazio ou só espaços ignora a dimensão", () => {
  assert.deepEqual(filtrarTransacoes(T, { texto: "" }), T);
  assert.deepEqual(filtrarTransacoes(T, { texto: "   " }), T);
});

test("filtrarTransacoes texto é acento-insensível", () => {
  // "sao paulo" sem acento deve casar com "Drogaria São Paulo"
  assert.deepEqual(filtrarTransacoes(T, { texto: "sao paulo" }).map(t => t.id), [4]);
});

test("filtrarTransacoes combina dimensões por E (categoria + pessoa)", () => {
  assert.deepEqual(filtrarTransacoes(T, { categoria: "Casa", pessoa: "Caio" }).map(t => t.id), [1]);
  assert.deepEqual(filtrarTransacoes(T, { categoria: "Casa", pessoa: "__sem__" }).map(t => t.id), [3]);
});

test("filtrarTransacoes por computa: só gasto / só não-gasto / tudo", () => {
  const rows = [
    { id: 1, computa_resumo: true, descricao: "mercado" },
    { id: 2, computa_resumo: false, descricao: "transf" },
  ];
  assert.deepEqual(filtrarTransacoes(rows, { computa: "gasto" }).map(t => t.id), [1]);
  assert.deepEqual(filtrarTransacoes(rows, { computa: "naogasto" }).map(t => t.id), [2]);
  assert.deepEqual(filtrarTransacoes(rows, { computa: "" }).map(t => t.id), [1, 2]);
});
