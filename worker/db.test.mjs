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
  // sql.transaction([...]) do driver Neon: roda várias queries num POST só (1 subrequest, atômico).
  fn.transaction = (queries) => { fn.transacao = queries; return Promise.resolve(queries.map(() => resultado)); };
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

test("inserirTransacao grava computa_resumo/linha_hash quando informados (fluxo de importação)", async () => {
  const sql = fakeSql([{ id: "t1" }]);
  const db = criarDb(sql);
  await db.inserirTransacao({
    dataISO: "2026-08-29", natureza: "despesa", esfera: "pessoal",
    valorCents: 1550, reembolsoCents: 0, categoria_id: "cCasa", subcategoria_id: "sLimp",
    descricao: "x", pessoa_id: null, fonte: "extrato", origem_categoria: "modelo",
    computa_resumo: false, linha_hash: "abc",
  });
  assert.match(sql.chamadas[0].text, /computa_resumo, linha_hash/i);
  assert.ok(sql.chamadas[0].values.includes(false));
  assert.ok(sql.chamadas[0].values.includes("abc"));
});

test("inserirTransacao sem computa_resumo/linha_hash mantém o default (true/null) — não quebra a captura", async () => {
  const sql = fakeSql([{ id: "t1" }]);
  const db = criarDb(sql);
  await db.inserirTransacao({
    dataISO: "2026-08-29", natureza: "despesa", esfera: "pessoal",
    valorCents: 1550, reembolsoCents: 0, categoria_id: "cCasa", subcategoria_id: "sLimp",
    descricao: "x", pessoa_id: null, fonte: "imagem", origem_categoria: "modelo",
  });
  assert.ok(sql.chamadas[0].values.includes(true));
  assert.ok(sql.chamadas[0].values.includes(null)); // linha_hash default null (entre outros nulls, ok)
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

test("resumoPorPessoaCategoria soma despesa que conta por pessoa × categoria, em centavos", async () => {
  // o driver devolve ::bigint como string; a borda converte pra number (senão o front concatena)
  const sql = fakeSql([{ pessoa: "sem pessoa", categoria: "Casa", total_cents: "70000" }]);
  const db = criarDb(sql);
  const r = await db.resumoPorPessoaCategoria("2026-09-01", "2026-09-30");
  assert.deepEqual(r, [{ pessoa: "sem pessoa", categoria: "Casa", total_cents: 70000 }]);
  assert.equal(typeof r[0].total_cents, "number");
  const q = sql.chamadas[0];
  assert.deepEqual(q.values, ["2026-09-01", "2026-09-30"]);
  assert.match(q.text, /conta_no_resumo/i);           // nunca computa_resumo: membro de grupo não conta
  assert.match(q.text, /natureza = 'despesa'/i);
  assert.match(q.text, /sum\(t\.valor_final\)/i);      // soma em SQL, não em JS
  assert.match(q.text, /::bigint/i);
  // left join: despesa sem pessoa_id não some — senão o anel interno não fecha com kpis.despesa
  assert.match(q.text, /left join pessoas/i);
  assert.match(q.text, /left join categorias/i);
  assert.match(q.text, /coalesce\(p\.nome,\s*'sem pessoa'\)/i);
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

test("resumoKPIs ignora não-gasto (conta_no_resumo)", async () => {
  const sql = fakeSql([{ receita: "0", despesa: "0", reembolso: "0" }]);
  const db = criarDb(sql);
  await db.resumoKPIs("2026-01-01", "2026-12-31");
  assert.match(sql.chamadas[0].text, /conta_no_resumo/i);
});

test("resumoPorCategoria ignora não-gasto", async () => {
  const sql = fakeSql([{ macro: "Casa", total: "1" }]);
  const db = criarDb(sql);
  await db.resumoPorCategoria("2026-01-01", "2026-12-31");
  assert.match(sql.chamadas[0].text, /conta_no_resumo/i);
});

test("resumoPorPessoa ignora não-gasto", async () => {
  const sql = fakeSql([{ pessoa: "Caio", natureza: "despesa", total: "1" }]);
  const db = criarDb(sql);
  await db.resumoPorPessoa("2026-01-01", "2026-12-31");
  assert.match(sql.chamadas[0].text, /conta_no_resumo/i);
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

test("associacoesPorNome monta dict camelCase chaveado por normalizarNome, só tipo_chave=nome", async () => {
  const sql = fakeSql([
    { chave: "loja x", categoria_nome: "Casa", sub_nome: "Limpeza" },
  ]);
  const db = criarDb(sql);
  const r = await db.associacoesPorNome();
  assert.match(sql.chamadas[0].text, /tipo_chave = 'nome'/i);
  assert.match(sql.chamadas[0].text, /left join categorias/i);
  assert.match(sql.chamadas[0].text, /left join subcategorias/i);
  assert.deepEqual(r, { "LOJA X": { categoriaNome: "Casa", subNome: "Limpeza" } });
});

test("marcarPagamentoFaturaNaoGasto marca quando há exatamente 1 candidato", async () => {
  const sql = fakeSql([{ id: "pg1" }]); // select devolve 1 candidato
  const db = criarDb(sql);
  const r = await db.marcarPagamentoFaturaNaoGasto(16700, "2025-05-01", "2025-07-02");
  // 1º call: select dos candidatos (extrato/despesa/conta no resumo/valor bate/janela). Fase B:
  // filtra por conta_no_resumo, não computa_resumo=true — uma linha de extrato dentro de um grupo
  // tem computa_resumo=true mas já não conta (quem conta é o representante); marcar computa_resumo
  // nela não evita a dupla contagem no card.
  assert.match(sql.chamadas[0].text, /from transacoes/i);
  assert.match(sql.chamadas[0].text, /fonte = 'extrato'/i);
  assert.match(sql.chamadas[0].text, /conta_no_resumo/i);
  assert.doesNotMatch(sql.chamadas[0].text, /computa_resumo = true/i);
  assert.ok(sql.chamadas[0].values.includes(16700));
  // 2º call: update marcando fora do resumo
  assert.match(sql.chamadas[1].text, /update transacoes set computa_resumo = false/i);
  assert.deepEqual(sql.chamadas[1].values, ["pg1"]);
  assert.deepEqual(r, { marcados: 1, candidatos: 1 });
});

test("marcarPagamentoFaturaNaoGasto não marca com 0 candidatos", async () => {
  const sql = fakeSql([]); // nenhum candidato
  const db = criarDb(sql);
  const r = await db.marcarPagamentoFaturaNaoGasto(16700, "2025-05-01", "2025-07-02");
  assert.equal(sql.chamadas.length, 1); // só o select, sem update
  assert.deepEqual(r, { marcados: 0, candidatos: 0 });
});

test("marcarPagamentoFaturaNaoGasto não marca com >1 candidato (ambíguo, deixa manual)", async () => {
  const sql = fakeSql([{ id: "a" }, { id: "b" }]);
  const db = criarDb(sql);
  const r = await db.marcarPagamentoFaturaNaoGasto(16700, "2025-05-01", "2025-07-02");
  assert.equal(sql.chamadas.length, 1); // só o select, sem update
  assert.deepEqual(r, { marcados: 0, candidatos: 2 });
});

// fake com resultados em sequência: a 1ª query recebe resultados[0], a 2ª resultados[1]...
// (o fakeSql acima devolve o mesmo resultado em toda chamada e não distingue select de update).
// Um resultado pode ser função do texto da query, pra responder como o banco responderia àquele
// WHERE (ex.: a linha já fora do resumo só volta se o select perguntar por ela).
function fakeSqlSeq(resultados) {
  const chamadas = [];
  const fn = (strings, ...values) => {
    const text = strings.join("?");
    chamadas.push({ text, values });
    const r = resultados[chamadas.length - 1] || [];
    return Promise.resolve(typeof r === "function" ? r(text) : r);
  };
  fn.chamadas = chamadas;
  return fn;
}
// mesma conta do index.js (rota aplicar): dia ISO + n dias, em UTC
const deslocaDias = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const semUpdate = (sql) => sql.chamadas.every((c) => !/update transacoes/i.test(c.text));

// Exemplo do C3: fatura de agosto, R$ 500,00. O pagamento de agosto já foi marcado (fora do
// resumo) na 1ª aplicação; o extrato de setembro trouxe outra despesa de R$ 500,00 dentro da
// janela de 62 dias. Antes, o pagamento marcado saía do select e a despesa de setembro virava o
// candidato único — e era tirada do resumo. Agora o pagamento já marcado bloqueia a marcação.
test("marcarPagamentoFaturaNaoGasto: pagamento já marcado na janela → não marca outra linha (Exemplo)", async () => {
  const ano = 2031; // ano fictício: nada de dado real no repositório
  const de = `${ano}-08-01`;
  const pgAgo = { id: "pgAgo", computa_resumo: false, conta_no_resumo: false };  // pagamento de agosto, já marcado
  const despSet = { id: "despSet", computa_resumo: true, conta_no_resumo: true }; // despesa de setembro, mesmo total
  // responde como o banco: a linha já fora do resumo só volta se o select perguntar por ela
  const sql = fakeSqlSeq([(text) => (/computa_resumo = false/i.test(text) ? [pgAgo, despSet] : [despSet])]);
  const db = criarDb(sql);
  const r = await db.marcarPagamentoFaturaNaoGasto(50000, de, deslocaDias(de, 62));
  // o select tem que enxergar também a linha já fora do resumo, senão não há como saber que o
  // pagamento já foi marcado (o critério de total exato e a janela seguem os mesmos)
  assert.match(sql.chamadas[0].text, /computa_resumo = false/i);
  assert.match(sql.chamadas[0].text, /round\(valor_final\*100\)/i);
  assert.ok(sql.chamadas[0].values.includes(50000));
  assert.ok(sql.chamadas[0].values.includes(de));
  assert.ok(sql.chamadas[0].values.includes(`${ano}-10-02`));
  assert.ok(semUpdate(sql), "nenhum update: a despesa de setembro segue no resumo");
  assert.equal(r.marcados, 0);
  assert.equal(r.jaMarcado, true);
});

test("marcarPagamentoFaturaNaoGasto aplicado duas vezes: só a 1ª marca (idempotente)", async () => {
  // 1ª aplicação: só o pagamento, que ainda conta → marca. 2ª: o banco devolve o pagamento já
  // marcado + uma despesa de mesmo total que ainda conta → não mexe em nada.
  const sql = fakeSqlSeq([
    [{ id: "pg1", computa_resumo: true, conta_no_resumo: true }],
    [], // resposta do update
    // o banco só devolve o pagamento já marcado se o select perguntar por computa_resumo = false
    (text) => /computa_resumo = false/i.test(text)
      ? [{ id: "pg1", computa_resumo: false, conta_no_resumo: false }, { id: "outra", computa_resumo: true, conta_no_resumo: true }]
      : [{ id: "outra", computa_resumo: true, conta_no_resumo: true }],
  ]);
  const db = criarDb(sql);
  const r1 = await db.marcarPagamentoFaturaNaoGasto(16700, "2025-05-01", "2025-07-02");
  const r2 = await db.marcarPagamentoFaturaNaoGasto(16700, "2025-05-01", "2025-07-02");
  const updates = sql.chamadas.filter((c) => /update transacoes set computa_resumo = false/i.test(c.text));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].values, ["pg1"]);
  assert.deepEqual(r1, { marcados: 1, candidatos: 1 });
  assert.equal(r2.marcados, 0);
});

test("aplicarImportacao grava tudo numa ÚNICA transação (1 subrequest, atômica)", async () => {
  const sql = fakeSql([{ id: "x" }]);
  const db = criarDb(sql);
  const linha = { dataISO: "2026-02-02", natureza: "despesa", esfera: "pessoal", valorCents: 1500, categoria_id: "cCasa",
    descricao: "PIX", fonte: "extrato", origem_categoria: "modelo", computa_resumo: true, linha_hash: "h3", grupo_id: "G1", representante: false };
  const r = await db.aplicarImportacao({
    novos: [{ dataISO: "2026-02-01", natureza: "despesa", esfera: "pessoal", valorCents: 1000, fonte: "extrato", origem_categoria: "modelo", linha_hash: "h1" }],
    naoGasto: [{ dataISO: "2026-02-03", natureza: "despesa", esfera: "pessoal", valorCents: 2000, fonte: "extrato", origem_categoria: "modelo", computa_resumo: false, linha_hash: "h2" }],
    casados: [{ linha, matchId: "t9", grupoExistente: false }],
  });
  // 2 inserts (novo+naoGasto) + 1 insert (linha do extrato) + 1 update (representante), numa transação só
  assert.equal(sql.transacao.length, 4);
  assert.deepEqual(r, { gravados: 2, agrupados: 1, naoGasto: 1 });
  assert.equal(sql.chamadas.filter(c => /insert into transacoes/i.test(c.text)).length, 3, "deve construir 3 inserts");
  const upd = sql.chamadas.find(c => /update transacoes set grupo_id = \?, representante = true/i.test(c.text));
  assert.ok(upd, "deve construir update de representante");
  assert.deepEqual(upd.values, ["G1", "t9"]);
});

test("aplicarImportacao com decisão vazia não abre transação", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const r = await db.aplicarImportacao({ novos: [], naoGasto: [], casados: [] });
  assert.equal(sql.transacao, undefined); // não chamou sql.transaction
  assert.deepEqual(r, { gravados: 0, agrupados: 0, naoGasto: 0 });
});

test("atualizarTransacoesLote: UPDATE único com guard por campo (any(ids)) + aprende em lote", async () => {
  // SELECT das contrapartes devolve 2 linhas, mas MESMA contraparte → 1 regra (dedupe)
  const sql = fakeSql([
    { contraparte_nome: "PADARIA REAL", contraparte_chave: null },
    { contraparte_nome: "PADARIA REAL", contraparte_chave: null },
  ]);
  const db = criarDb(sql);
  const r = await db.atualizarTransacoesLote(["id1", "id2"], { categoria_id: "cCasa", subcategoria_id: "sMerc" });
  assert.match(sql.chamadas[0].text, /update transacoes set/i);
  assert.match(sql.chamadas[0].text, /id = any\(/i);
  assert.ok(sql.chamadas[0].values.includes("cCasa"));
  assert.ok(sql.chamadas[0].values.some(v => Array.isArray(v) && v.includes("id1")), "ids vão como array");
  assert.match(sql.chamadas[1].text, /select contraparte_nome, contraparte_chave/i); // leitura p/ aprender
  assert.equal(sql.transacao.length, 1);   // upserts numa transação; dedupe → 1
  assert.deepEqual(r, { atualizados: 2, regras: 1 });
});

test("atualizarTransacoesLote: só pessoa → sem aprendizado (não lê contrapartes nem abre transação)", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const r = await db.atualizarTransacoesLote(["id1"], { pessoa_id: "p1" });
  assert.equal(sql.chamadas.length, 1);    // só o UPDATE
  assert.equal(sql.transacao, undefined);
  assert.deepEqual(r, { atualizados: 1, regras: 0 });
});

test("atualizarTransacoesLote: fora do resumo sem mexer em categoria/pessoa (sem aprendizado)", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.atualizarTransacoesLote(["id1"], { computa_resumo: false });
  assert.ok(sql.chamadas[0].values.includes(false));
  assert.equal(sql.chamadas.length, 1);
});

test("atualizarTransacoesLote: ids vazios não faz nada", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const r = await db.atualizarTransacoesLote([], { categoria_id: "cX" });
  assert.equal(sql.chamadas.length, 0);
  assert.deepEqual(r, { atualizados: 0, regras: 0 });
});

// ---- Inc 4: planejamento (metas) ----
test("metasBaselines lê baselines em centavos", async () => {
  const sql = fakeSql([{ categoria_id: "c1", vigente_desde: "2026-01-01", valor_cents: 100000 }]);
  const db = criarDb(sql);
  const r = await db.metasBaselines();
  assert.equal(r[0].valor_cents, 100000);
  assert.match(sql.chamadas[0].text, /from metas/i);
  assert.match(sql.chamadas[0].text, /round\(valor_alvo\*100\)/i);
});

test("realizadoPorCategoriaMes: só despesa+conta_no_resumo, janela meio-aberta", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.realizadoPorCategoriaMes("2026-06-01", "2026-09-01");
  const c = sql.chamadas[0];
  assert.match(c.text, /natureza = 'despesa'/i);
  assert.match(c.text, /conta_no_resumo/i);
  assert.match(c.text, /data >= .* and .*data < /is);
  assert.deepEqual(c.values, ["2026-06-01", "2026-09-01"]);
});

test("metasBaselines converte valor_cents (bigint) de string p/ number — regressão Neon", async () => {
  // o driver do Neon devolve coluna ::bigint como STRING; sem Number(), o += de index.js concatena
  const sql = fakeSql([{ categoria_id: "c1", vigente_desde: "2026-01-01", valor_cents: "100000" }]);
  const db = criarDb(sql);
  const r = await db.metasBaselines();
  assert.equal(typeof r[0].valor_cents, "number");
  assert.equal(r[0].valor_cents, 100000);
});

test("metasExcecoes converte valor_cents (bigint) de string p/ number — regressão Neon", async () => {
  const sql = fakeSql([{ categoria_id: "c1", mes: "2026-08-01", valor_cents: "50000" }]);
  const db = criarDb(sql);
  const r = await db.metasExcecoes();
  assert.equal(typeof r[0].valor_cents, "number");
  assert.equal(r[0].valor_cents, 50000);
});

test("realizadoPorCategoriaMes converte realizado_cents (bigint) de string p/ number — regressão Neon", async () => {
  const sql = fakeSql([{ categoria_id: "c1", mes: "2026-06", realizado_cents: "75000" }]);
  const db = criarDb(sql);
  const r = await db.realizadoPorCategoriaMes("2026-06-01", "2026-09-01");
  assert.equal(typeof r[0].realizado_cents, "number");
  assert.equal(r[0].realizado_cents, 75000);
});

test("setBaseline faz upsert convertendo centavos → numeric", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.setBaseline("c1", "2026-09-01", 150000);
  const c = sql.chamadas[0];
  assert.match(c.text, /insert into metas/i);
  assert.match(c.text, /on conflict .*do update/is);
  assert.ok(c.values.includes("c1"));
  assert.ok(c.values.includes("2026-09-01"));
  assert.ok(c.values.includes("1500.00"));
});

test("setExcecao faz upsert em metas_excecao", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.setExcecao("c1", "2026-08-01", 200000);
  const c = sql.chamadas[0];
  assert.match(c.text, /insert into metas_excecao/i);
  assert.ok(c.values.includes("2000.00"));
});

test("apagarExcecao remove pela chave (categoria, mes)", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.apagarExcecao("c1", "2026-08-01");
  const c = sql.chamadas[0];
  assert.match(c.text, /delete from metas_excecao/i);
  assert.deepEqual(c.values, ["c1", "2026-08-01"]);
});

test("resumoDiario: despesa+conta_no_resumo por dia, meio-aberto, cents numérico", async () => {
  const sql = fakeSql([{ dia: "2026-09-03", total_cents: "1500" }]); // Neon devolve bigint como STRING
  const db = criarDb(sql);
  const r = await db.resumoDiario("2026-09-01", "2026-10-01");
  assert.equal(typeof r[0].total_cents, "number");
  assert.equal(r[0].total_cents, 1500);
  const c = sql.chamadas[0];
  assert.match(c.text, /natureza = 'despesa'/i);
  assert.match(c.text, /conta_no_resumo/i);
  assert.match(c.text, /data >= .* and .*data < /is);
  assert.deepEqual(c.values, ["2026-09-01", "2026-10-01"]);
});

test("resumoMesVsAnterior ancora no mês passado (não em max(data))", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.resumoMesVsAnterior("2026-09");
  const c = sql.chamadas[0];
  assert.ok(c.values.includes("2026-09-01") || c.text.includes("2026-09"), "usa o mês passado por parâmetro");
  assert.doesNotMatch(c.text, /max\(data\)/i);
});

test("catalogo devolve a flag padrao das categorias (fallback por flag, não por nome)", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.catalogo();
  assert.match(sql.chamadas[0].text, /padrao/i);
});

test("desativarCategoria nunca desativa a categoria padrão (guard no próprio SQL)", async () => {
  // se a padrão sumisse do catálogo, o fallback voltaria a devolver null (o bug do Telegram mudo)
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.desativarCategoria("c1");
  assert.match(sql.chamadas[0].text, /not padrao/i);
});

// ---- Inc 4.6: grupos ----
// A regra "quem conta" mora na coluna gerada conta_no_resumo (computa_resumo AND (sem grupo OU
// representante)). Se alguma leitura agregada ainda filtrar por computa_resumo, um membro de
// grupo volta a contar e o Resumo dobra o valor da duplicata.
test("leituras agregadas filtram por conta_no_resumo, não por computa_resumo", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.resumoPorCategoria("2026-09-01", "2026-09-30");
  await db.resumoKPIs("2026-09-01", "2026-09-30");
  await db.resumoDiario("2026-09-01", "2026-10-01");
  await db.resumoMesVsAnterior("2026-09");
  await db.resumoReembolsoAno();
  await db.resumoPorPessoa("2026-09-01", "2026-09-30");
  await db.realizadoPorCategoriaMes("2026-09-01", "2026-10-01");
  assert.equal(sql.chamadas.length, 7);
  for (const c of sql.chamadas) {
    assert.match(c.text, /conta_no_resumo/, c.text);
    assert.doesNotMatch(c.text, /\bcomputa_resumo\b/, c.text);
  }
});

test("transacoesPorIds/membrosDoGrupo/grupoDaTransacao devolvem a forma mínima que grupos.js precisa", async () => {
  const sql = fakeSql([{ id: "t1", fonte: "manual", criado_em: "x", grupo_id: null, representante: false, valor_final: "1.00" }]);
  const db = criarDb(sql);
  await db.transacoesPorIds(["t1", "t2"]);
  assert.match(sql.chamadas[0].text, /select id, fonte, criado_em, grupo_id, representante, valor_final/i);
  assert.match(sql.chamadas[0].text, /id = any\(/i);
  await db.membrosDoGrupo("G0");
  assert.match(sql.chamadas[1].text, /where grupo_id = /i);
  await db.grupoDaTransacao("t1");
  assert.match(sql.chamadas[2].text, /grupo_id = \(select grupo_id from transacoes where id = /i);
  // lista vazia não vai ao banco
  assert.deepEqual(await db.transacoesPorIds([]), []);
  assert.equal(sql.chamadas.length, 3);
});

test("membrosDosGrupos lê todos os membros de vários grupos numa query só; lista vazia não vai ao banco", async () => {
  // F2: a conferência da prévia olha o grupo inteiro de cada casado (quem é representante),
  // num único subrequest, antes da transação do aplicar.
  const sql = fakeSql([]);
  const db = criarDb(sql);
  assert.deepEqual(await db.membrosDosGrupos([]), []);
  assert.equal(sql.chamadas.length, 0);
  await db.membrosDosGrupos(["G0", "G1"]);
  assert.equal(sql.chamadas.length, 1);
  assert.match(sql.chamadas[0].text, /select id, fonte, criado_em, grupo_id, representante, valor_final/i);
  assert.match(sql.chamadas[0].text, /grupo_id = any\(/i);
});

test("gravarGrupo grava todas as mudanças (na ordem) e o delete opcional numa ÚNICA transação", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const r = await db.gravarGrupo({
    mudancas: [
      { id: "m1", grupo_id: "G0", representante: false },
      { id: "e1", grupo_id: "G0", representante: true },
    ],
    apagarId: "x9",
  });
  assert.deepEqual(r, { alterados: 2, apagados: 1 });
  assert.ok(Array.isArray(sql.transacao), "usa sql.transaction");
  assert.equal(sql.transacao.length, 3);
  // as queries da transação são construídas pelo fakeSql: verificamos a ordem via chamadas
  assert.match(sql.chamadas[0].text, /update transacoes set grupo_id = \?, representante = \? where id = \?/i);
  assert.deepEqual(sql.chamadas[0].values, ["G0", false, "m1"]);
  assert.deepEqual(sql.chamadas[1].values, ["G0", true, "e1"]);
  assert.match(sql.chamadas[2].text, /delete from transacoes where id = \?/i);
  assert.deepEqual(sql.chamadas[2].values, ["x9"]);
});

test("gravarGrupo sem mudanças nem delete não abre transação", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  assert.deepEqual(await db.gravarGrupo({ mudancas: [] }), { alterados: 0, apagados: 0 });
  assert.equal(sql.transacao, undefined);
});

test("transacoesNaJanela: só candidatas legítimas ao casamento (nem extrato/fatura, nem hash antigo, nem grupo que já tem extrato) e devolve grupo_id", async () => {
  // descricao vem junto (C2): o ambíguo mostra os candidatos na tela e o Caio precisa saber qual é qual.
  const sql = fakeSql([{ id: "m1", data: "2026-09-02", valor_cents: "250000", grupo_id: "G0", descricao: "aluguel" }]);
  const db = criarDb(sql);
  const r = await db.transacoesNaJanela("2026-09-01", "2026-09-30");
  const q = sql.chamadas[0].text;
  assert.match(q, /fonte not in \('extrato', ?'fatura'\)/i);
  assert.match(q, /linha_hash is null/i);
  assert.match(q, /not exists \(select 1 from transacoes x where x\.grupo_id = t\.grupo_id and x\.fonte = 'extrato'\)/i);
  assert.match(q, /descricao/i);
  assert.deepEqual(r, [{ id: "m1", data: "2026-09-02", descricao: "aluguel", valorCents: 250000, grupo_id: "G0" }]);
});

test("aplicarImportacao: casado insere a linha do extrato no grupo e põe o casado como representante (grupo novo) — tudo numa transação", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const linha = { dataISO: "2026-09-30", natureza: "despesa", esfera: "pessoal", valorCents: 250000, reembolsoCents: 0,
    categoria_id: "cCasa", subcategoria_id: null, descricao: "PIX ALUGUEL", fonte: "extrato", origem_categoria: "modelo",
    computa_resumo: true, linha_hash: "h1", grupo_id: "G1", representante: false };
  const r = await db.aplicarImportacao({ novos: [], naoGasto: [], casados: [{ linha, matchId: "m1", grupoExistente: false }] });
  assert.deepEqual(r, { gravados: 0, agrupados: 1, naoGasto: 0 });
  assert.equal(sql.transacao.length, 2);
  assert.match(sql.chamadas[0].text, /insert into transacoes/i);
  assert.match(sql.chamadas[0].text, /grupo_id, representante\)/i);
  assert.ok(sql.chamadas[0].values.includes("G1") && sql.chamadas[0].values.includes(false));
  assert.match(sql.chamadas[1].text, /update transacoes set grupo_id = \?, representante = true where id = \? and grupo_id is null/i);
  assert.deepEqual(sql.chamadas[1].values, ["G1", "m1"]);
});

test("aplicarImportacao: casado com grupoExistente só insere a linha do extrato (representante fica quem era)", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  const linha = { dataISO: "2026-09-30", natureza: "despesa", esfera: "pessoal", valorCents: 250000, categoria_id: "cCasa",
    descricao: "PIX ALUGUEL", fonte: "extrato", origem_categoria: "modelo", computa_resumo: true, linha_hash: "h1", grupo_id: "G0", representante: false };
  await db.aplicarImportacao({ casados: [{ linha, matchId: "m1", grupoExistente: true }] });
  assert.equal(sql.transacao.length, 1);
  assert.match(sql.chamadas[0].text, /insert into transacoes/i);
});

// ---- natureza segue a categoria ao reclassificar (bug do salário, 25/09/2026) ----
test("atualizarTransacao: trocar p/ categoria de receita grava natureza receita (lê a natureza da categoria nova no mesmo SELECT)", async () => {
  const existente = { id: "t1", data: "2026-09-22", categoria_id: "cOut", subcategoria_id: null,
    valor_total: "36120.00", valor_reembolso: "0.00", pessoa_id: null, descricao: "Salário",
    natureza: "despesa", esfera: "pessoal", fonte: "manual", contraparte_nome: null, contraparte_chave: null,
    nova_cat_natureza: "receita" };
  const sql = fakeSql([existente]);
  const db = criarDb(sql);
  await db.atualizarTransacao("t1", { categoria_id: "cRec", subcategoria_id: "" });
  assert.match(sql.chamadas[0].text, /nova_cat_natureza/i, "o SELECT traz a natureza da categoria nova");
  const upd = sql.chamadas[1];
  assert.match(upd.text, /update transacoes/i);
  assert.ok(upd.values.includes("receita"), "natureza virou receita");
});

test("atualizarTransacoesLote: com categoria nova, natureza segue a categoria (exceto crédito de extrato/fatura) no mesmo UPDATE", async () => {
  const sql = fakeSql([]);
  const db = criarDb(sql);
  await db.atualizarTransacoesLote(["id1"], { categoria_id: "cRec" }, { aprender: false });
  const upd = sql.chamadas[0].text;
  assert.match(upd, /natureza\s*=\s*case when/i);
  assert.match(upd, /select natureza from categorias where id = /i);
  assert.match(upd, /fonte in \('extrato', ?'fatura'\)/i);
});

// ---- B2: painel de regras aprendidas ----
test("listarAssociacoes junta categorias/subcategorias por id e ordena por atualizado_em desc", async () => {
  // macro/sub saíram da tabela: o nome só vem pelo join; a ordem é a que o painel mostra
  const sql = fakeSql([{ chave: "PADARIA EXEMPLO", tipo_chave: "nome" }]);
  const db = criarDb(sql);
  const r = await db.listarAssociacoes();
  assert.equal(r.length, 1);
  const q = sql.chamadas[0].text;
  assert.match(q, /join categorias c\s+on c\.id = a\.categoria_id/i);
  assert.match(q, /join subcategorias s\s+on s\.id = a\.subcategoria_id/i);
  assert.match(q, /order by a\.atualizado_em desc/i);
  for (const col of ["a.chave", "a.tipo_chave", "a.categoria_id", "a.subcategoria_id", "a.n", "a.atualizado_em"]) {
    assert.ok(q.includes(col), `select traz ${col}`);
  }
});

test("editarAssociacao troca categoria/sub por (chave, tipo_chave) e NÃO mexe no contador n", async () => {
  // decisão de 27/09: editar mantém n (upsertAssociacao incrementa, por isso não é usado aqui)
  const sql = fakeSql([{ chave: "PADARIA EXEMPLO" }]);
  const db = criarDb(sql);
  const r = await db.editarAssociacao({ chave: "PADARIA EXEMPLO", tipo_chave: "nome", categoria_id: "cCompras", subcategoria_id: null });
  assert.equal(r.alterados, 1);
  const { text, values } = sql.chamadas[0];
  assert.match(text, /^\s*update associacoes/i);
  assert.match(text, /categoria_id = \?/);
  assert.match(text, /subcategoria_id = \?/);
  assert.doesNotMatch(text, /\bn\s*=/i);
  assert.match(text, /where chave = \? and tipo_chave = \?/i);
  assert.deepEqual(values, ["cCompras", null, "PADARIA EXEMPLO", "nome"]);
});

test("editarAssociacao sem linha casada devolve alterados 0", async () => {
  const db = criarDb(fakeSql([]));
  const r = await db.editarAssociacao({ chave: "X", tipo_chave: "nome", categoria_id: "c1", subcategoria_id: null });
  assert.equal(r.alterados, 0);
});

test("apagarAssociacao apaga por (chave, tipo_chave)", async () => {
  const sql = fakeSql([{ chave: "PADARIA EXEMPLO" }]);
  const db = criarDb(sql);
  const r = await db.apagarAssociacao("PADARIA EXEMPLO", "nome");
  assert.equal(r.apagados, 1);
  assert.match(sql.chamadas[0].text, /delete from associacoes\s+where chave = \? and tipo_chave = \?/i);
  assert.deepEqual(sql.chamadas[0].values, ["PADARIA EXEMPLO", "nome"]);
});
