import { test } from "node:test";
import assert from "node:assert/strict";
import { tratarUpdate } from "./index.js";

function dbFake() {
  const estado = { inseridos: [], docs: [], apagados: [] };
  return {
    estado,
    listarCategorias: async () => [{ macro: "Casa", sub: "Limpeza" }],
    documentoPorHash: async () => null,
    inserirDocumento: async (d) => { estado.docs.push(d); return { id: "doc1" }; },
    inserirTransacao: async (t) => { estado.inseridos.push(t); return { id: "tx1" }; },
    apagarTransacao: async (id) => { estado.apagados.push(id); },
    buscarAssociacao: async () => null,
    upsertAssociacao: async () => {},
  };
}

const bom = { data: "2026-08-29", valor: "15,50", descricao: "Padaria", natureza: "despesa", macro: "Casa", sub: "Limpeza" };

test("foto vira transação + confirmação", async () => {
  const enviados = [];
  const db = dbFake();
  const deps = {
    db,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    baixar: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }),
    extrairImpl: async () => ({ ok: true, normalizado: { dataISO: "2026-08-29", valorCents: 1550, natureza: "despesa", macro: "Casa", sub: "Limpeza", descricao: "Padaria" }, extraido_por: "gemini", confianca: 0.9 }),
    subir: async () => "/Finanças/Comprovantes/2026/2026-08/x.jpg",
    hashBytes: async () => "h1",
    confirmar: async (chatId, texto, id) => enviados.push({ chatId, texto, id }),
    responderImpl: async () => {},
  };
  const env = { TELEGRAM_TOKEN: "t" };
  const update = { message: { chat: { id: 7 }, message_id: 1, photo: [{ file_id: "b", width: 800 }] } };
  await tratarUpdate(update, env, deps);
  assert.equal(db.estado.inseridos.length, 1);
  assert.equal(db.estado.inseridos[0].fonte, "imagem");
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].texto, /15,50/);
});

test("dedup: hash conhecido não insere de novo", async () => {
  const db = dbFake();
  db.documentoPorHash = async () => ({ id: "jaexiste", recebido_em: "2026-08-01" });
  const respostas = [];
  const deps = {
    db, baixar: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg" }),
    hashBytes: async () => "h1", extrairImpl: async () => { throw new Error("não devia extrair"); },
    subir: async () => "x", confirmar: async () => {}, responderImpl: async (c, t) => respostas.push(t), fetchImpl: async () => ({}),
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, photo: [{ file_id: "b", width: 800 }] } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.estado.inseridos.length, 0);
  assert.ok(respostas.some((t) => /já registrei/i.test(t)));
});

test("callback del apaga a transação", async () => {
  const db = dbFake();
  const deps = { db, responderImpl: async () => {}, fetchImpl: async () => ({}) };
  const update = { callback_query: { message: { chat: { id: 7 }, message_id: 3 }, data: "del:tx1" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.deepEqual(db.estado.apagados, ["tx1"]);
});

test("regra aprendida sobrepõe o chute do modelo", async () => {
  const enviados = [];
  const db = dbFake();
  db.buscarAssociacao = async (chave, tipo) =>
    (chave === "5519995783408" && tipo === "pix_cpf")
      ? { macro: "Educação", sub: "Inglês Particular" } : null;
  const deps = {
    db,
    baixar: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg" }),
    hashBytes: async () => "h9",
    extrairImpl: async () => ({ ok: true, extraido_por: "claude", confianca: 0.85,
      normalizado: { dataISO: "2026-08-28", valorCents: 91600, natureza: "despesa",
        macro: "Pessoal", sub: "Fatura", descricao: "Pix",
        contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "+5519995783408" } }),
    subir: async () => "/x.jpg",
    confirmar: async (chat, texto, id) => enviados.push(texto),
    responderImpl: async () => {},
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, photo: [{ file_id: "b", width: 800 }] } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  const ins = db.estado.inseridos[0];
  assert.equal(ins.macro, "Educação");           // veio da regra, não "Pessoal"
  assert.equal(ins.sub, "Inglês Particular");
  assert.equal(ins.origem_categoria, "regra");
  assert.equal(ins.contraparte_chave, "+5519995783408"); // guarda a contraparte
  assert.ok(enviados.some(t => /aprendido/i.test(t)));
});

test("teach: foto com /aprender grava associação e NÃO cria transação", async () => {
  const db = dbFake();
  const aprendidas = [];
  db.listarCategorias = async () => [{ macro: "Educação", sub: null }];
  db.upsertAssociacao = async (a) => aprendidas.push(a);
  const deps = {
    db,
    baixar: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg" }),
    hashBytes: async () => "h1",
    extrairImpl: async () => ({ ok: true, extraido_por: "gemini", confianca: 0.9,
      normalizado: { contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "+5519995783408" } }),
    responderImpl: async () => {},
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, caption: "/aprender Educação > Inglês Particular",
    photo: [{ file_id: "b", width: 800 }] } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.estado.inseridos.length, 0);           // dry-run: nada gravado como transação
  assert.equal(aprendidas[0].macro, "Educação");
  assert.equal(aprendidas[0].tipo, "pix_cpf");
});

test("teach: /aprender aprende mesmo em comprovante duplicado (dedup não bloqueia)", async () => {
  const db = dbFake();
  const aprendidas = [];
  db.documentoPorHash = async () => ({ id: "jaexiste" }); // duplicado
  db.listarCategorias = async () => [{ macro: "Educação", sub: null }];
  db.upsertAssociacao = async (a) => aprendidas.push(a);
  const deps = {
    db,
    baixar: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg" }),
    hashBytes: async () => "h1",
    extrairImpl: async () => ({ ok: true, normalizado: { contraparte_nome: "VIVIANE FERRER BORGATO", contraparte_chave: "+5519995783408" } }),
    responderImpl: async () => {},
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, caption: "/aprender Educação", photo: [{ file_id: "b", width: 800 }] } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(aprendidas.length, 1);              // aprendeu apesar do duplicado
  assert.equal(db.estado.inseridos.length, 0);     // dry-run
});

// Testes da API /api/*
function dbApiFake() {
  return {
    listarPessoas: async () => [
      { id: 1, nome: "Alice" },
      { id: 2, nome: "Bob" },
    ],
    listarCategorias: async () => [{ macro: "Casa", sub: "Limpeza" }],
    resumoKPIs: async () => ({ receita: 1000, despesa: 500, reembolso: 0 }),
    resumoPorCategoria: async () => [{ macro: "Casa", sub: "Limpeza", natureza: "despesa", total: 500, n: 1 }],
    resumoMensal: async () => [{ mes: "2026-09", natureza: "despesa", total: 500 }],
    resumoMesVsAnterior: async () => [{ macro: "Casa", atual: 500, ant: 300 }],
    resumoPorPessoa: async () => [
      { pessoa: "Alice", natureza: "despesa", total: 300 },
      { pessoa: "Bob", natureza: "receita", total: 1000 },
    ],
  };
}

// Importar handleApi para teste — precisa ser exportado
import { handleApi } from "./index.js";

test("GET /api/pessoas retorna lista de pessoas", async () => {
  const db = dbApiFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/pessoas", { headers: { "Cookie": "token=token123" } });
  const url = new URL(request.url);

  const response = await handleApi(request, env, url, db);
  const data = await response.json();
  assert.deepEqual(data, [
    { id: 1, nome: "Alice" },
    { id: 2, nome: "Bob" },
  ]);
});

test("/api/resumo inclui porPessoa", async () => {
  const db = dbApiFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/resumo?de=2026-01-01&ate=2026-12-31", { headers: { "Cookie": "token=token123" } });
  const url = new URL(request.url);

  const response = await handleApi(request, env, url, db);
  const data = await response.json();
  assert.ok(data.porPessoa, "resposta deve incluir campo porPessoa");
  assert.ok(Array.isArray(data.porPessoa), "porPessoa deve ser array");
  assert.equal(data.porPessoa.length, 2, "porPessoa deve ter 2 registros");
  assert.ok(data.kpis, "resposta deve manter kpis");
  assert.ok(data.porCategoria, "resposta deve manter porCategoria");
  assert.ok(data.mensal, "resposta deve manter mensal");
  assert.ok(data.mesVsAnterior, "resposta deve manter mesVsAnterior");
});
