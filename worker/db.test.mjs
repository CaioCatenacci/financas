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

test("inserirTransacao grava por categoria_id/subcategoria_id e converte centavos", async () => {
  const sql = fakeSql([{ id: "t1" }]);
  const db = criarDb(sql);
  const r = await db.inserirTransacao({
    dataISO: "2026-08-29", natureza: "despesa", esfera: "pessoal",
    valorCents: 1550, reembolsoCents: 0, categoria_id: "cCasa", subcategoria_id: "sLimp",
    descricao: "x", pessoa_id: null, fonte: "imagem", origem_categoria: "modelo",
    extraido_por: "gemini", confianca: 0.9, documento_id: "d1",
  });
  assert.equal(r.id, "t1");
  assert.match(sql.chamadas[0].text, /categoria_id, subcategoria_id/i);
  assert.ok(sql.chamadas[0].values.includes("cCasa"));
  assert.ok(sql.chamadas[0].values.includes("sLimp"));
  assert.ok(sql.chamadas[0].values.includes("15.50"));
  assert.ok(sql.chamadas[0].values.includes("0.00"));
});

test("inserirTransacao grava contraparte", async () => {
  const sql = fakeSql([{ id: "t1" }]);
  const db = criarDb(sql);
  await db.inserirTransacao({
    dataISO: "2026-08-28", natureza: "despesa", esfera: "pessoal", valorCents: 91600,
    reembolsoCents: 0, categoria_id: "cEdu", subcategoria_id: "sIdi", descricao: "Pix",
    pessoa_id: null, fonte: "imagem", origem_categoria: "regra", extraido_por: "claude",
    confianca: 0.85, documento_id: "d1",
    contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "5519995783408",
  });
  assert.ok(sql.chamadas[0].values.includes("VIVIANE FERRER BORGATO"));
  assert.ok(sql.chamadas[0].values.includes("5519995783408"));
});

test("catalogo consulta categorias e subcategorias ativas", async () => {
  const sql = fakeSql([{ id: "c1", nome: "Casa" }]);
  const db = criarDb(sql);
  const r = await db.catalogo();
  assert.equal(sql.chamadas.length, 2);
  assert.match(sql.chamadas[0].text, /from categorias where ativa/i);
  assert.match(sql.chamadas[1].text, /from subcategorias where ativa/i);
  assert.ok(Array.isArray(r.categorias) && Array.isArray(r.subcategorias));
});

test("listarTransacoes faz join p/ nomes (categoria, subcategoria, pessoa)", async () => {
  const sql = fakeSql([{ id: "t1", categoria: "Casa", subcategoria: "Luz", pessoa: "Alice" }]);
  const db = criarDb(sql);
  const r = await db.listarTransacoes();
  assert.equal(r[0].categoria, "Casa");
  assert.match(sql.chamadas[0].text, /left join categorias/i);
  assert.match(sql.chamadas[0].text, /left join subcategorias/i);
  assert.match(sql.chamadas[0].text, /left join pessoas/i);
});

test("atualizarTransacao troca categoria por id, mescla e aprende associação por id", async () => {
  const existente = { id: "t1", data: "2026-08-28", categoria_id: "cPes", subcategoria_id: "sFat",
    valor_total: "916.00", valor_reembolso: "0.00", pessoa_id: null, descricao: "Pix",
    natureza: "despesa", esfera: "pessoal",
    contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "5519995783408" };
  const sql = fakeSql([existente]);
  const db = criarDb(sql);
  await db.atualizarTransacao("t1", { categoria_id: "cEdu", subcategoria_id: "sIdi", descricao: "Aula de inglês" });
  assert.equal(sql.chamadas.length, 3);            // SELECT + UPDATE + UPSERT associacao
  const upd = sql.chamadas[1];
  assert.match(upd.text, /update transacoes/i);
  assert.ok(upd.values.includes("cEdu"));          // categoria_id novo
  assert.ok(upd.values.includes("sIdi"));
  assert.ok(upd.values.includes("Aula de inglês"));
  assert.ok(upd.values.includes("100.00") === false); // sanity
  assert.ok(upd.values.includes("916.00"));        // valor preservado da linha lida
  assert.match(sql.chamadas[2].text, /insert into associacoes/i);
  assert.ok(sql.chamadas[2].values.includes("5519995783408")); // chave
  assert.ok(sql.chamadas[2].values.includes("cEdu"));          // aprende categoria_id
});

test("atualizarTransacao muda só pessoa_id sem aprender associação de categoria", async () => {
  const existente = { id: "t1", data: "2026-01-01", categoria_id: "cCasa", subcategoria_id: null,
    valor_total: "100.00", valor_reembolso: "0.00", pessoa_id: null, natureza: "despesa", esfera: "pessoal" };
  const sql = fakeSql([existente]);
  const db = criarDb(sql);
  await db.atualizarTransacao("t1", { pessoa_id: "p1" });
  assert.equal(sql.chamadas.length, 2);            // SELECT + UPDATE (sem upsert)
  const upd = sql.chamadas[1];
  assert.match(upd.text, /update transacoes/i);
  assert.ok(upd.values.includes("p1"));            // pessoa_id atualizado
  assert.ok(upd.values.includes("cCasa"));         // categoria preservada da linha lida
});

test("buscarAssociacao consulta por chave e tipo", async () => {
  const sql = fakeSql([{ chave: "5519995783408", tipo_chave: "pix_cpf", categoria_id: "cEdu", subcategoria_id: "sIdi" }]);
  const db = criarDb(sql);
  const r = await db.buscarAssociacao("5519995783408", "pix_cpf");
  assert.equal(r.categoria_id, "cEdu");
  assert.deepEqual(sql.chamadas[0].values, ["5519995783408", "pix_cpf"]);
});

test("upsertAssociacao insere por id e incrementa n", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.upsertAssociacao({ chave: "5519995783408", tipo: "pix_cpf", categoria_id: "cEdu", subcategoria_id: "sIdi" });
  assert.match(sql.chamadas[0].text, /insert into associacoes/i);
  assert.match(sql.chamadas[0].text, /categoria_id, subcategoria_id/i);
  assert.match(sql.chamadas[0].text, /on conflict/i);
  assert.ok(sql.chamadas[0].values.includes("cEdu"));
});

test("criarCategoria insere com natureza e reativa em conflito", async () => {
  const sql = fakeSql([{ id: "c9" }]);
  const db = criarDb(sql);
  const r = await db.criarCategoria("Viagem", "despesa");
  assert.equal(r.id, "c9");
  assert.match(sql.chamadas[0].text, /insert into categorias/i);
  assert.match(sql.chamadas[0].text, /on conflict \(nome\) do update set ativa = true/i);
  assert.ok(sql.chamadas[0].values.includes("Viagem"));
});

test("renomearCategoria e desativarCategoria atualizam a linha", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.renomearCategoria("c1", "Novo nome");
  assert.match(sql.chamadas[0].text, /update categorias set nome/i);
  await db.desativarCategoria("c1");
  assert.match(sql.chamadas[1].text, /update categorias set ativa = false/i);
});

test("criarSub e renomearSub operam na categoria", async () => {
  const sql = fakeSql([{ id: "s9" }]);
  const db = criarDb(sql);
  const r = await db.criarSub("c1", "Uber");
  assert.equal(r.id, "s9");
  assert.match(sql.chamadas[0].text, /insert into subcategorias/i);
  assert.ok(sql.chamadas[0].values.includes("c1"));
  assert.ok(sql.chamadas[0].values.includes("Uber"));
});

test("mergeSub reaponta transacoes e associacoes p/ destino e desativa a origem", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.mergeSub("sOrig", "sDest");
  assert.equal(sql.chamadas.length, 3);
  assert.match(sql.chamadas[0].text, /update transacoes  set subcategoria_id/i);
  assert.deepEqual(sql.chamadas[0].values, ["sDest", "sOrig"]);
  assert.match(sql.chamadas[1].text, /update associacoes  set subcategoria_id/i);
  assert.deepEqual(sql.chamadas[1].values, ["sDest", "sOrig"]);
  assert.match(sql.chamadas[2].text, /update subcategorias set ativa = false/i);
  assert.deepEqual(sql.chamadas[2].values, ["sOrig"]);
});

test("criarPessoa/renomearPessoa/desativarPessoa", async () => {
  const sql = fakeSql([{ id: "p9" }]);
  const db = criarDb(sql);
  const r = await db.criarPessoa("Vó");
  assert.equal(r.id, "p9");
  assert.match(sql.chamadas[0].text, /insert into pessoas/i);
  await db.renomearPessoa("p1", "Vovó");
  assert.match(sql.chamadas[1].text, /update pessoas set nome/i);
  await db.desativarPessoa("p1");
  assert.match(sql.chamadas[2].text, /update pessoas set ativa = false/i);
});

test("resumoPorCategoria junta categorias e apelida c.nome as macro (forma p/ os gráficos)", async () => {
  const sql = fakeSql([{ macro: "Casa", total: "100.00" }]);
  const db = criarDb(sql);
  const r = await db.resumoPorCategoria("2026-01-01", "2026-12-31");
  assert.equal(r[0].macro, "Casa");
  assert.match(sql.chamadas[0].text, /left join categorias/i);
  assert.match(sql.chamadas[0].text, /c\.nome as macro/i);
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
  assert.deepEqual(sql.chamadas[0].values, ["2026-01-01", "2026-12-31"]);
});

test("resumoMesVsAnterior junta categorias e usa c.nome as macro", async () => {
  const sql = fakeSql([{ macro: "Casa", atual: "16800.00", ant: "14200.00" }]);
  const db = criarDb(sql);
  const r = await db.resumoMesVsAnterior();
  assert.equal(r[0].macro, "Casa");
  assert.match(sql.chamadas[0].text, /left join categorias/i);
  assert.match(sql.chamadas[0].text, /natureza = 'despesa'/i);
});

test("resumoPorPessoa agrupa por pessoa e natureza no intervalo", async () => {
  const sql = fakeSql([{ pessoa: "Alice", natureza: "despesa", total: "500.00" }]);
  const db = criarDb(sql);
  const r = await db.resumoPorPessoa("2026-01-01", "2026-12-31");
  assert.equal(r[0].pessoa, "Alice");
  assert.deepEqual(sql.chamadas[0].values, ["2026-01-01", "2026-12-31"]);
  assert.match(sql.chamadas[0].text, /left join pessoas/i);
  assert.match(sql.chamadas[0].text, /coalesce\(p\.nome,\s*'—'\)/i);
});

test("listarPessoas retorna ativas ordenadas por nome", async () => {
  const sql = fakeSql([{ id: "p1", nome: "Alice" }]);
  const db = criarDb(sql);
  const r = await db.listarPessoas();
  assert.equal(r[0].nome, "Alice");
  assert.match(sql.chamadas[0].text, /from pessoas where ativa/i);
});

test("pessoaPorNome casa nome case-insensitive só entre ativas", async () => {
  const sql = fakeSql([{ id: "p1", nome: "Caio" }]);
  const db = criarDb(sql);
  const r = await db.pessoaPorNome("caio");
  assert.equal(r.id, "p1");
  assert.match(sql.chamadas[0].text, /from pessoas/i);
  assert.match(sql.chamadas[0].text, /where ativa/i);
  assert.match(sql.chamadas[0].text, /lower\(nome\)\s*=\s*lower/i);
  assert.deepEqual(sql.chamadas[0].values, ["caio"]);
});

test("pessoaPorNome retorna null quando não acha", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  assert.equal(await db.pessoaPorNome("Xuxa"), null);
});

test("resumoKPIs ignora não-gasto (computa_resumo)", async () => {
  const sql = fakeSql([{ receita: "0", despesa: "0", reembolso: "0" }]);
  const db = criarDb(sql);
  await db.resumoKPIs("2026-01-01", "2026-12-31");
  assert.match(sql.chamadas[0].text, /computa_resumo/i);
});

test("resumoPorCategoria ignora não-gasto", async () => {
  const sql = fakeSql([{ macro: "Casa", total: "1" }]);
  const db = criarDb(sql);
  await db.resumoPorCategoria("2026-01-01", "2026-12-31");
  assert.match(sql.chamadas[0].text, /computa_resumo/i);
});

test("resumoPorPessoa ignora não-gasto", async () => {
  const sql = fakeSql([{ pessoa: "Caio", natureza: "despesa", total: "1" }]);
  const db = criarDb(sql);
  await db.resumoPorPessoa("2026-01-01", "2026-12-31");
  assert.match(sql.chamadas[0].text, /computa_resumo/i);
});

test("atualizarTransacao alterna computa_resumo", async () => {
  const existente = { id: "t1", data: "2026-01-01", categoria_id: "cCasa", subcategoria_id: null,
    valor_total: "100.00", valor_reembolso: "0.00", pessoa_id: null, natureza: "despesa",
    esfera: "pessoal", computa_resumo: true };
  const sql = fakeSql([existente]);
  const db = criarDb(sql);
  await db.atualizarTransacao("t1", { computa_resumo: false });
  const upd = sql.chamadas[1];
  assert.match(upd.text, /computa_resumo/i);
  assert.ok(upd.values.includes(false));
});

test("transacoesNaJanela traz só linha_hash null com valor em cents", async () => {
  const sql = fakeSql([{ id:"t1", data:"2025-12-10", valor_cents: 19478 }]);
  const db = criarDb(sql);
  const r = await db.transacoesNaJanela("2025-12-01","2025-12-31");
  assert.equal(r[0].valorCents, 19478);
  assert.match(sql.chamadas[0].text, /linha_hash is null/i);
  assert.match(sql.chamadas[0].text, /round\(valor_final\*100\)/i);
});

test("hashesNaJanela devolve os hashes não-nulos", async () => {
  const sql = fakeSql([{ linha_hash:"abc" }]);
  const db = criarDb(sql);
  const r = await db.hashesNaJanela("2025-12-01","2025-12-31");
  assert.deepEqual(r, ["abc"]);
  assert.match(sql.chamadas[0].text, /linha_hash is not null/i);
});
