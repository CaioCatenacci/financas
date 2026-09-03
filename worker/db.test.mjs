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
    descricao: "x", pessoa_id: null, fonte: "imagem", origem_categoria: "modelo",
    extraido_por: "gemini", confianca: 0.9, documento_id: "d1",
  });
  assert.equal(r.id, "t1");
  assert.ok(sql.chamadas[0].values.includes("15.50"));
  assert.ok(sql.chamadas[0].values.includes("0.00"));
});

test("atualizarTransacao lê a linha, mescla e grava sem fragmentos aninhados", async () => {
  const existente = { id: "t1", data: "2026-01-01", macro: "Casa", sub: "Luz",
    valor_total: "100.00", valor_reembolso: "0.00", pessoa_id: null,
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

test("inserirTransacao grava contraparte", async () => {
  const sql = fakeSql([{ id: "t1" }]);
  const db = criarDb(sql);
  await db.inserirTransacao({
    dataISO: "2026-08-28", natureza: "despesa", esfera: "pessoal", valorCents: 91600,
    reembolsoCents: 0, macro: "Educação", sub: "Inglês Particular", descricao: "Pix",
    pessoa_id: null, fonte: "imagem", origem_categoria: "regra", extraido_por: "claude",
    confianca: 0.85, documento_id: "d1",
    contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "5519995783408",
  });
  assert.ok(sql.chamadas[0].values.includes("VIVIANE FERRER BORGATO"));
  assert.ok(sql.chamadas[0].values.includes("5519995783408"));
});

test("buscarAssociacao consulta por chave e tipo", async () => {
  const sql = fakeSql([{ chave: "5519995783408", tipo_chave: "pix_cpf", macro: "Educação", sub: "Inglês Particular" }]);
  const db = criarDb(sql);
  const r = await db.buscarAssociacao("5519995783408", "pix_cpf");
  assert.equal(r.macro, "Educação");
  assert.deepEqual(sql.chamadas[0].values, ["5519995783408", "pix_cpf"]);
});

test("upsertAssociacao insere e incrementa n", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.upsertAssociacao({ chave: "5519995783408", tipo: "pix_cpf", macro: "Educação", sub: "Inglês Particular" });
  assert.match(sql.chamadas[0].text, /insert into associacoes/i);
  assert.match(sql.chamadas[0].text, /on conflict/i);
});

test("atualizarTransacao aceita descricao e aprende associação quando muda categoria", async () => {
  const existente = { id: "t1", data: "2026-08-28", macro: "Pessoal", sub: "Fatura",
    valor_total: "916.00", valor_reembolso: "0.00", pessoa_id: null, descricao: "Pix",
    natureza: "despesa", esfera: "pessoal",
    contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "5519995783408" };
  const sql = fakeSql([existente]);
  const db = criarDb(sql);
  await db.atualizarTransacao("t1", { macro: "Educação", sub: "Inglês Particular", descricao: "Aula de inglês" });
  // 3 chamadas: SELECT, UPDATE, UPSERT associacao
  assert.equal(sql.chamadas.length, 3);
  assert.match(sql.chamadas[1].text, /update transacoes/i);
  assert.ok(sql.chamadas[1].values.includes("Aula de inglês")); // descricao editada
  assert.match(sql.chamadas[2].text, /insert into associacoes/i);
  assert.ok(sql.chamadas[2].values.includes("5519995783408")); // chave pix/cpf
  assert.ok(sql.chamadas[2].values.includes("Educação"));
});

// Testes para pessoa (Incremento 2.5)

test("listarPessoas retorna ativas ordenadas por nome", async () => {
  const sql = fakeSql([
    { id: "p1", nome: "Alice" },
    { id: "p2", nome: "Bob" }
  ]);
  const db = criarDb(sql);
  const r = await db.listarPessoas();
  assert.equal(r.length, 2);
  assert.equal(r[0].nome, "Alice");
  assert.match(sql.chamadas[0].text, /from pessoas where ativa/i);
  assert.match(sql.chamadas[0].text, /order by nome/i);
});

test("listarTransacoes faz LEFT JOIN com pessoas e retorna pessoa", async () => {
  const sql = fakeSql([
    { id: "t1", valor_final: "100.00", pessoa: "Alice" }
  ]);
  const db = criarDb(sql);
  const r = await db.listarTransacoes();
  assert.equal(r[0].pessoa, "Alice");
  assert.match(sql.chamadas[0].text, /left join pessoas/i);
});

test("atualizarTransacao atualiza pessoa_id e mantém associacao", async () => {
  const existente = {
    id: "t1", data: "2026-01-01", macro: "Casa", sub: "Luz",
    valor_total: "100.00", valor_reembolso: "0.00", pessoa_id: null,
    natureza: "despesa", esfera: "pessoal"
  };
  const sql = fakeSql([existente]);
  const db = criarDb(sql);
  await db.atualizarTransacao("t1", { pessoa_id: "p1" });
  assert.equal(sql.chamadas.length, 2);            // SELECT + UPDATE
  const upd = sql.chamadas[1];
  assert.match(upd.text, /update transacoes/i);
  assert.ok(upd.values.includes("p1"));            // pessoa_id atualizado
});

test("resumoPorPessoa agrupa por pessoa e natureza no intervalo", async () => {
  const sql = fakeSql([
    { pessoa: "Alice", natureza: "despesa", total: "500.00" },
    { pessoa: "Bob", natureza: "despesa", total: "300.00" }
  ]);
  const db = criarDb(sql);
  const r = await db.resumoPorPessoa("2026-01-01", "2026-12-31");
  assert.equal(r.length, 2);
  assert.equal(r[0].pessoa, "Alice");
  assert.deepEqual(sql.chamadas[0].values, ["2026-01-01", "2026-12-31"]);
  assert.match(sql.chamadas[0].text, /left join pessoas/i);
  assert.match(sql.chamadas[0].text, /group by 1, 2/i);
  assert.match(sql.chamadas[0].text, /coalesce\(p\.nome,\s*'—'\)/i);
});
