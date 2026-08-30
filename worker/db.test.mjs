import { test } from "node:test";
import assert from "node:assert/strict";
import { criarDb } from "./db.js";

// fake da tagged template: guarda strings + valores e devolve resultado programável
function fakeSql(resultado = []) {
  const chamadas = [];
  const fn = (strings, ...values) => {
    chamadas.push({ text: strings.join("?"), values });
    return Promise.resolve(resultado);
  };
  fn.chamadas = chamadas;
  return fn;
}

test("documentoPorHash consulta por hash e retorna null se vazio", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const r = await db.documentoPorHash("abc");
  assert.equal(r, null);
  assert.match(sql.chamadas[0].text, /from documentos/i);
  assert.deepEqual(sql.chamadas[0].values, ["abc"]);
});

test("inserirTransacao converte centavos p/ numeric string", async () => {
  const sql = fakeSql([{ id: "t1" }]);
  const db = criarDb(sql);
  const r = await db.inserirTransacao({
    dataISO: "2026-08-29", natureza: "despesa", esfera: "pessoal",
    valorCents: 1550, reembolsoCents: 0, macro: "Casa", sub: "Limpeza",
    descricao: "x", pessoa: null, fonte: "imagem", origem_categoria: "modelo",
    extraido_por: "gemini", confianca: 0.9, documento_id: "d1",
  });
  assert.equal(r.id, "t1");
  assert.ok(sql.chamadas[0].values.includes("15.50"));
  assert.ok(sql.chamadas[0].values.includes("0.00"));
});

test("atualizarTransacao lê a linha, mescla e grava sem fragmentos aninhados", async () => {
  const existente = { id: "t1", data: "2026-01-01", macro: "Casa", sub: "Luz",
    valor_total: "100.00", valor_reembolso: "0.00", pessoa: null,
    natureza: "despesa", esfera: "pessoal" };
  const sql = fakeSql([existente]);
  const db = criarDb(sql);
  await db.atualizarTransacao("t1", { macro: "Saúde", sub: "Pediatra" });
  assert.equal(sql.chamadas.length, 2);            // SELECT + UPDATE
  const upd = sql.chamadas[1];
  assert.match(upd.text, /update transacoes/i);
  assert.ok(upd.values.includes("Saúde"));         // campo alterado
  assert.ok(upd.values.includes("Pediatra"));
  assert.ok(upd.values.includes("100.00"));        // valor preservado da linha lida
});

test("resumoPorCategoria filtra por intervalo", async () => {
  const sql = fakeSql([{ macro: "Casa", total: "100.00" }]);
  const db = criarDb(sql);
  const r = await db.resumoPorCategoria("2026-01-01", "2026-12-31");
  assert.equal(r[0].macro, "Casa");
  assert.deepEqual(sql.chamadas[0].values, ["2026-01-01", "2026-12-31"]);
});

test("resumoMensal passa o intervalo do período", async () => {
  const sql = fakeSql([{ mes: "2026-01", natureza: "despesa", total: "10.00" }]);
  const db = criarDb(sql);
  await db.resumoMensal("2026-01-01", "2026-12-31");
  assert.match(sql.chamadas[0].text, /to_char\(data,'YYYY-MM'\)/i);
  assert.deepEqual(sql.chamadas[0].values, ["2026-01-01", "2026-12-31"]);
});

test("resumoKPIs retorna a linha única com receita/despesa/reembolso do período", async () => {
  const sql = fakeSql([{ receita: "264000.00", despesa: "189400.00", reembolso: "12180.00" }]);
  const db = criarDb(sql);
  const r = await db.resumoKPIs("2026-01-01", "2026-12-31");
  assert.equal(r.receita, "264000.00");
  assert.equal(r.despesa, "189400.00");
  assert.deepEqual(sql.chamadas[0].values, ["2026-01-01", "2026-12-31"]);
});

test("resumoMesVsAnterior consulta despesa por macro nos dois últimos meses", async () => {
  const sql = fakeSql([{ macro: "Casa", atual: "16800.00", ant: "14200.00" }]);
  const db = criarDb(sql);
  const r = await db.resumoMesVsAnterior();
  assert.equal(r[0].macro, "Casa");
  assert.match(sql.chamadas[0].text, /date_trunc\('month', data\)/i);
  assert.match(sql.chamadas[0].text, /natureza = 'despesa'/i);
});
