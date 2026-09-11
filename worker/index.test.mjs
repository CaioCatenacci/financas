import { test } from "node:test";
import assert from "node:assert/strict";
import { tratarUpdate } from "./index.js";

function dbFake() {
  const estado = { inseridos: [], docs: [], apagados: [] };
  return {
    estado,
    // catálogo por id (Fase B): cobre os pares usados nos testes de captura
    catalogo: async () => ({
      categorias: [
        { id: "cCasa", nome: "Casa", natureza: "despesa" },
        { id: "cEdu", nome: "Educação", natureza: "despesa" },
        { id: "cOut", nome: "Outros", natureza: "despesa" },
      ],
      subcategorias: [
        { id: "sLimp", categoria_id: "cCasa", nome: "Limpeza" },
        { id: "sIng", categoria_id: "cEdu", nome: "Inglês Particular" },
      ],
    }),
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
      ? { categoria_id: "cEdu", subcategoria_id: "sIng" } : null;
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
  assert.equal(ins.categoria_id, "cEdu");          // veio da regra, não "Pessoal"
  assert.equal(ins.subcategoria_id, "sIng");
  assert.equal(ins.origem_categoria, "regra");
  assert.equal(ins.contraparte_chave, "+5519995783408"); // guarda a contraparte
  assert.ok(enviados.some(t => /aprendido/i.test(t)));
});

test("teach: foto com /aprender grava associação e NÃO cria transação", async () => {
  const db = dbFake();
  const aprendidas = [];
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
  assert.equal(aprendidas[0].categoria_id, "cEdu");      // resolveu nome→id
  assert.equal(aprendidas[0].subcategoria_id, "sIng");
  assert.equal(aprendidas[0].tipo, "pix_cpf");
});

test("teach: /aprender aprende mesmo em comprovante duplicado (dedup não bloqueia)", async () => {
  const db = dbFake();
  const aprendidas = [];
  db.documentoPorHash = async () => ({ id: "jaexiste" }); // duplicado
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

test("PDF de comprovante vira transação (reusa fluxo de imagem, fonte=imagem)", async () => {
  const enviados = [];
  const db = dbFake();
  const subidos = [];
  const deps = {
    db,
    baixar: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "application/pdf" }),
    hashBytes: async () => "hpdf",
    extrairImpl: async (bytes, mime) => {
      assert.equal(mime, "application/pdf");   // o mime do PDF chega ao extrator
      return { ok: true, extraido_por: "gemini", confianca: 0.9,
        normalizado: { dataISO: "2026-03-29", valorCents: 4200, natureza: "despesa",
          macro: "Casa", sub: "Limpeza", descricao: "Recibo", contraparte_nome: null, contraparte_chave: null } };
    },
    subir: async (e, caminho) => { subidos.push(caminho); return caminho; },
    confirmar: async (chat, texto, id) => enviados.push(texto),
    responderImpl: async () => {},
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, document: { file_id: "fpdf", mime_type: "application/pdf" } } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  const ins = db.estado.inseridos[0];
  assert.equal(ins.fonte, "imagem");
  assert.equal(ins.categoria_id, "cCasa");
  assert.equal(ins.subcategoria_id, "sLimp");
  assert.ok(subidos[0].endsWith(".pdf"));       // arquivo salvo como .pdf
  assert.ok(enviados.length === 1);
});

test("texto estruturado vira transação manual, resolvendo categoria e pessoa", async () => {
  const enviados = [];
  const db = dbFake();
  db.pessoaPorNome = async (n) => (n.toLowerCase() === "casa" ? { id: "p2", nome: "Casa" } : null);
  const deps = {
    db,
    confirmar: async (chat, texto, id) => enviados.push(texto),
    responderImpl: async () => {},
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "padaria 57,50 29/03/2026 categoria=Casa pessoa=Casa" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  const ins = db.estado.inseridos[0];
  assert.equal(ins.fonte, "manual");
  assert.equal(ins.origem_categoria, "manual");
  assert.equal(ins.categoria_id, "cCasa");   // resolvido do catálogo do dbFake
  assert.equal(ins.pessoa_id, "p2");
  assert.equal(ins.valorCents, 5750);
  assert.ok(enviados.some((t) => /57,50/.test(t)));
});

test("texto sem categoria cai em Outros e avisa pessoa inexistente", async () => {
  const enviados = [];
  const db = dbFake();
  db.pessoaPorNome = async () => null; // ninguém casa
  const deps = { db, confirmar: async (c, t) => enviados.push(t), responderImpl: async () => {} };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "mercado 30,00 01/03/2026 pessoa=Xuxa" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  const ins = db.estado.inseridos[0];
  assert.equal(ins.categoria_id, "cOut");    // Outros (fallback do resolverCategoria)
  assert.equal(ins.pessoa_id, null);
  assert.ok(enviados.some((t) => /Xuxa/.test(t)));  // avisou o não-encontrado
});

test("texto inválido responde com o formato e não grava", async () => {
  const respostas = [];
  const db = dbFake();
  const deps = { db, confirmar: async () => {}, responderImpl: async (c, t) => respostas.push(t) };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "só uma descrição sem valor nem data" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.estado.inseridos.length, 0);
  assert.ok(respostas.some((t) => /ex\.:/i.test(t)));
});

// Testes da API /api/*
function dbApiFake() {
  return {
    listarPessoas: async () => [
      { id: 1, nome: "Alice" },
      { id: 2, nome: "Bob" },
    ],
    catalogo: async () => ({ categorias: [{ id: "c1", nome: "Casa", natureza: "despesa" }], subcategorias: [{ id: "s1", categoria_id: "c1", nome: "Limpeza" }] }),
    criarCategoria: async (nome, natureza) => ({ id: "cNova", nome, natureza }),
    listarCategorias: async () => [{ macro: "Casa", sub: "Limpeza" }],
    resumoKPIs: async () => ({ receita: 1000, despesa: 500, reembolso: 0 }),
    resumoPorCategoria: async () => [{ macro: "Casa", sub: "Limpeza", natureza: "despesa", total: 500, n: 1 }],
    resumoMesVsAnterior: async () => [{ macro: "Casa", atual: 500, ant: 300 }],
    resumoPorPessoa: async () => [
      { pessoa: "Alice", natureza: "despesa", total: 300 },
      { pessoa: "Bob", natureza: "receita", total: 1000 },
    ],
    atualizarTransacoesLote: async (ids, mudancas) => { dbApiFake._lote = { ids, mudancas }; return { atualizados: ids.length, regras: 0 }; },
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

test("GET /api/catalogo devolve categorias + subcategorias", async () => {
  const db = dbApiFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/catalogo", { headers: { "Cookie": "token=token123" } });
  const response = await handleApi(request, env, new URL(request.url), db);
  const data = await response.json();
  assert.ok(Array.isArray(data.categorias) && Array.isArray(data.subcategorias));
  assert.equal(data.categorias[0].nome, "Casa");
});

test("POST /api/categorias cria categoria", async () => {
  const db = dbApiFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/categorias", {
    method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
    body: JSON.stringify({ nome: "Viagem", natureza: "despesa" }),
  });
  const response = await handleApi(request, env, new URL(request.url), db);
  const data = await response.json();
  assert.equal(data.nome, "Viagem");
});

// ---- import de extrato/fatura ----
function dbImportarFake() {
  const estado = { inseridos: [], carimbados: [] };
  return {
    estado,
    catalogo: async () => ({ categorias: [{ id: "cO", nome: "Outros" }], subcategorias: [] }),
    associacoesPorNome: async () => ({}),
    transacoesNaJanela: async () => [],
    hashesNaJanela: async () => [],
    aplicarImportacao: async (d) => {
      estado.aplicado = d;
      return { gravados: (d.novos || []).length + (d.naoGasto || []).length, conciliados: (d.casados || []).length, naoGasto: (d.naoGasto || []).length };
    },
    marcarPagamentoFaturaNaoGasto: async (totalCents, de, ate) => {
      estado.pagamento = { totalCents, de, ate };
      return { marcados: 1, candidatos: 1 };
    },
  };
}

const TXT_EXTRATO = `10/12/2025 SALDO DO DIA 8.876,46
10/12/2025 PIX QRS LOJA X10/12 -100,00
09/12/2025 SALDO DO DIA 8.976,46`;

test("POST /api/importar/preview (extrato) devolve checksum e resumo", async () => {
  const db = dbImportarFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/importar/preview", {
    method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
    body: JSON.stringify({ tipo: "extrato", texto: TXT_EXTRATO, conta: "c1" }),
  });
  const response = await handleApi(request, env, new URL(request.url), db);
  const data = await response.json();
  assert.ok(data.checksum, "resposta deve trazer checksum");
  assert.ok(data.resumo, "resposta deve trazer resumo");
  assert.equal(data.resumo.novos, 1);
});

test("POST /api/importar/aplicar grava novos e retorna as contagens", async () => {
  const db = dbImportarFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const decisao = {
    novos: [{ descricao: "a", categoria_id: "cO" }],
    naoGasto: [],
    casados: [],
  };
  const request = new Request("http://localhost/api/importar/aplicar", {
    method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
    body: JSON.stringify({ decisao }),
  });
  const response = await handleApi(request, env, new URL(request.url), db);
  const data = await response.json();
  assert.equal(db.estado.aplicado.novos.length, 1); // a decisão chegou no lote transacional
  assert.equal(data.gravados, 1);
});

test("POST /api/importar/aplicar (fatura) marca o pagamento no extrato como fora do resumo", async () => {
  const db = dbImportarFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/importar/aplicar", {
    method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
    body: JSON.stringify({
      decisao: { novos: [{ descricao: "item", categoria_id: "cO" }], naoGasto: [], casados: [] },
      fatura: { totalCents: 16700, ano: 2025, mes: 5 },
    }),
  });
  const data = await (await handleApi(request, env, new URL(request.url), db)).json();
  // janela: 1º dia do mês (mês padronizado p/ "05") até +62 dias
  assert.equal(db.estado.pagamento.totalCents, 16700);
  assert.equal(db.estado.pagamento.de, "2025-05-01");
  assert.equal(db.estado.pagamento.ate, "2025-07-02"); // 2025-05-01 + 62 dias
  assert.equal(data.pagamentoMarcado, 1);
});

test("POST /api/importar/aplicar (extrato, sem fatura) NÃO chama marcação de pagamento", async () => {
  const db = dbImportarFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/importar/aplicar", {
    method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
    body: JSON.stringify({ decisao: { novos: [], naoGasto: [], casados: [] } }),
  });
  const data = await (await handleApi(request, env, new URL(request.url), db)).json();
  assert.equal(db.estado.pagamento, undefined); // não tocou no pagamento
  assert.equal(data.pagamentoMarcado, undefined);
});

test("POST /api/importar/preview (extrato) amplia a janela de reconciliação ±3 dias", async () => {
  // uma transação já lançada 3 dias APÓS o único lançamento do extrato (10/12 → 13/12), mesmo
  // valor: com a janela ampliada ela é candidata e CASA; sem ampliar (bug), viraria "novo" =
  // duplicata. O fake filtra pela janela recebida, então o teste falha se a janela não abrir ±3d.
  const janelas = [];
  const db = {
    catalogo: async () => ({ categorias: [{ id: "cO", nome: "Outros" }], subcategorias: [] }),
    associacoesPorNome: async () => ({}),
    transacoesNaJanela: async (de, ate) => {
      janelas.push({ de, ate });
      return [{ id: "tX", data: "2025-12-13", valorCents: 10000 }].filter(t => t.data >= de && t.data <= ate);
    },
    hashesNaJanela: async () => [],
    inserirTransacao: async () => ({ id: "x" }),
    carimbarLinhaHash: async () => {},
  };
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/importar/preview", {
    method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
    body: JSON.stringify({ tipo: "extrato", texto: TXT_EXTRATO, conta: "c1" }),
  });
  const data = await (await handleApi(request, env, new URL(request.url), db)).json();
  assert.deepEqual(janelas[0], { de: "2025-12-07", ate: "2025-12-13" }); // ±3 dias do 10/12
  assert.equal(data.resumo.casados, 1); // casou com a de 13/12 (borda)
  assert.equal(data.resumo.novos, 0);   // não duplicou
});

const TXT_FATURA_MIN = `                DATA       ESTABELECIMENTO                       VALOR EM R$
                29/05      PARK E CO ESTACIONAME                          17,00`;

test("POST /api/importar/preview (fatura) padroniza o mês p/ 2 dígitos (idempotência do linha_hash)", async () => {
  const call = async (mes) => {
    const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
    const request = new Request("http://localhost/api/importar/preview", {
      method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
      body: JSON.stringify({ tipo: "fatura", texto: TXT_FATURA_MIN, ano: 2025, mes }),
    });
    const data = await (await handleApi(request, env, new URL(request.url), dbImportarFake())).json();
    return data.itens[0].linhaHash;
  };
  assert.equal(await call(5), await call("05"), "mes 5 e '05' devem gerar o mesmo linha_hash");
});

test("POST /api/importar/preview (fatura) sem ano/mês → 400 com mensagem clara (não 500)", async () => {
  const db = dbImportarFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/importar/preview", {
    method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
    body: JSON.stringify({ tipo: "fatura", texto: TXT_FATURA_MIN, ano: "", mes: "" }),
  });
  const response = await handleApi(request, env, new URL(request.url), db);
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.erro, /ano.*mês|mês.*ano/i);
});

test("POST /api/importar/preview com texto vazio → 400 (PDF ilegível)", async () => {
  const db = dbImportarFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/importar/preview", {
    method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
    body: JSON.stringify({ tipo: "extrato", texto: "   ", conta: "itau" }),
  });
  const response = await handleApi(request, env, new URL(request.url), db);
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.erro, /extrair texto|ilegível|vazio/i);
});

test("POST /api/transacoes/lote chama atualizarTransacoesLote com ids e mudancas", async () => {
  const db = dbApiFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/transacoes/lote", {
    method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
    body: JSON.stringify({ ids: ["a", "b", "c"], mudancas: { categoria_id: "c1", subcategoria_id: "s1" } }),
  });
  const data = await (await handleApi(request, env, new URL(request.url), db)).json();
  assert.deepEqual(dbApiFake._lote, { ids: ["a", "b", "c"], mudancas: { categoria_id: "c1", subcategoria_id: "s1" } });
  assert.equal(data.atualizados, 3);
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
  assert.ok(data.mesVsAnterior, "resposta deve manter mesVsAnterior"); // "mensal" saiu do payload (Task 5, Inc 4.5)
});

// ---- Inc 4: planejamento (metas) ----
// fake do db p/ as rotas de metas
function dbMetasFake(over = {}) {
  const estado = { baselines: [], excecoes: [], apagados: [] };
  return {
    estado,
    catalogo: async () => ({
      categorias: [
        { id: "c1", nome: "Casa", natureza: "despesa" },
        { id: "c2", nome: "Salário", natureza: "receita" }, // deve ser filtrada (só despesa)
      ],
      subcategorias: [],
    }),
    metasBaselines: async () => (over.baselines || [{ categoria_id: "c1", vigente_desde: "2026-01-01", valor_cents: 100000 }]),
    metasExcecoes: async () => (over.excecoes || []),
    realizadoPorCategoriaMes: async () => (over.realizado || [{ categoria_id: "c1", mes: "2026-09", realizado_cents: 80000 }]),
    setBaseline: async (cat, mes, v) => estado.baselines.push({ cat, mes, v }),
    setExcecao: async (cat, mes, v) => estado.excecoes.push({ cat, mes, v }),
    apagarBaseline: async (cat, mes) => estado.apagados.push({ tipo: "baseline", cat, mes }),
    apagarExcecao: async (cat, mes) => estado.apagados.push({ tipo: "excecao", cat, mes }),
  };
}
const envTok = { APP_TOKEN: "token123", DATABASE_URL: "" };
const cook = { "Cookie": "token=token123" };

test("GET /api/metas monta linha por categoria de despesa com alvo/realizado/status", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas?mes=2026-09", { headers: cook });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.equal(data.mes, "2026-09");
  assert.equal(data.linhas.length, 1); // 'Salário' (receita) filtrada
  const l = data.linhas[0];
  assert.equal(l.categoria, "Casa");
  assert.equal(l.alvo_cents, 100000);      // baseline de jan vale em set
  assert.equal(l.realizado_cents, 80000);
  assert.equal(l.diff_cents, 20000);
  assert.equal(l.origem, "baseline");
  assert.equal(l.status, "aviso");          // 80%
  assert.equal(data.total.alvo_cents, 100000);
  assert.equal(data.total.realizado_cents, 80000);
});

test("GET /api/metas: categoria sem baseline vem alvo_cents null e diff null", async () => {
  const db = dbMetasFake({ baselines: [] });
  const req = new Request("http://localhost/api/metas?mes=2026-09", { headers: cook });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.equal(data.linhas[0].alvo_cents, null);
  assert.equal(data.linhas[0].diff_cents, null);
  assert.equal(data.linhas[0].origem, "sem-alvo");
  assert.equal(data.total.alvo_cents, 0); // total soma só quem tem alvo
});

test("GET /api/metas rejeita mes inválido", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas?mes=2026", { headers: cook });
  const resp = await handleApi(req, envTok, new URL(req.url), db);
  assert.equal(resp.status, 400);
});

test("GET /api/metas/sugestao devolve média dos 3 meses anteriores por categoria", async () => {
  const db = dbMetasFake({ realizado: [
    { categoria_id: "c1", mes: "2026-06", realizado_cents: 100000 },
    { categoria_id: "c1", mes: "2026-07", realizado_cents: 110000 },
    { categoria_id: "c1", mes: "2026-08", realizado_cents: 90100 },
  ]});
  const req = new Request("http://localhost/api/metas/sugestao?mes=2026-09", { headers: cook });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.equal(data.linhas.find(x => x.categoria_id === "c1").sugestao_cents, 100033);
});

test("PUT /api/metas escopo baseline chama setBaseline com dia-01", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas", {
    method: "PUT", headers: { ...cook, "content-type": "application/json" },
    body: JSON.stringify({ categoria_id: "c1", mes: "2026-09", valor_cents: 150000, escopo: "baseline" }),
  });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.deepEqual(data, { ok: true });
  assert.deepEqual(db.estado.baselines, [{ cat: "c1", mes: "2026-09-01", v: 150000 }]);
});

test("PUT /api/metas escopo excecao chama setExcecao", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas", {
    method: "PUT", headers: { ...cook, "content-type": "application/json" },
    body: JSON.stringify({ categoria_id: "c1", mes: "2026-08", valor_cents: 200000, escopo: "excecao" }),
  });
  await handleApi(req, envTok, new URL(req.url), db);
  assert.deepEqual(db.estado.excecoes, [{ cat: "c1", mes: "2026-08-01", v: 200000 }]);
});

test("PUT /api/metas rejeita valor_cents negativo", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas", {
    method: "PUT", headers: { ...cook, "content-type": "application/json" },
    body: JSON.stringify({ categoria_id: "c1", mes: "2026-09", valor_cents: -1, escopo: "baseline" }),
  });
  const resp = await handleApi(req, envTok, new URL(req.url), db);
  assert.equal(resp.status, 400);
});

test("DELETE /api/metas escopo excecao chama apagarExcecao", async () => {
  const db = dbMetasFake();
  const req = new Request("http://localhost/api/metas?categoria_id=c1&mes=2026-08&escopo=excecao", { method: "DELETE", headers: cook });
  await handleApi(req, envTok, new URL(req.url), db);
  assert.deepEqual(db.estado.apagados, [{ tipo: "excecao", cat: "c1", mes: "2026-08-01" }]);
});

test("GET /api/metas/grade monta meses e células com alvo e realizado", async () => {
  const db = dbMetasFake({
    baselines: [{ categoria_id: "c1", vigente_desde: "2026-01-01", valor_cents: 100000 }],
    realizado: [{ categoria_id: "c1", mes: "2026-08", realizado_cents: 90000 }],
  });
  const req = new Request("http://localhost/api/metas/grade?de=2026-08&ate=2026-10", { headers: cook });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.deepEqual(data.meses, ["2026-08", "2026-09", "2026-10"]);
  const c1 = data.categorias.find(c => c.categoria_id === "c1");
  assert.equal(c1.celulas.length, 3);
  assert.equal(c1.celulas[0].alvo_cents, 100000);       // baseline propaga
  assert.equal(c1.celulas[0].realizado_cents, 90000);   // ago (passado) tem realizado
});

test("GET /api/metas/grade: default de/ate = 12 meses (−3..+8) do mês corrente", async () => {
  const db = dbMetasFake({ baselines: [], realizado: [] });
  const req = new Request("http://localhost/api/metas/grade", { headers: cook });
  const data = await (await handleApi(req, envTok, new URL(req.url), db)).json();
  assert.equal(data.meses.length, 12);
});

// Inc 4.5 Task 5: /api/resumo?mes= — fake dedicado, registra o que a rota passou pro db
function dbResumoFake() {
  const estado = { mesRef: null, de: null, ateExcl: null };
  return {
    estado,
    resumoKPIs: async () => ({ receita: 1000, despesa: 500, reembolso: 0 }),
    resumoPorCategoria: async () => [{ macro: "Casa", sub: "Limpeza", natureza: "despesa", total: 500, n: 1 }],
    resumoPorPessoa: async () => [{ pessoa: "Alice", natureza: "despesa", total: 300 }],
    resumoDiario: async (de, ateExcl) => { estado.de = de; estado.ateExcl = ateExcl; return [{ dia: "2026-09-01", total: 500 }]; },
    resumoMesVsAnterior: async (mesRef) => { estado.mesRef = mesRef; return [{ macro: "Casa", atual: 500, ant: 300 }]; },
  };
}

test("/api/resumo?mes= devolve diario e mesVsAnterior do mês", async () => {
  const db = dbResumoFake(); // fake com kpis/porCategoria/porPessoa/resumoDiario/resumoMesVsAnterior
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const req = new Request("http://localhost/api/resumo?mes=2026-09", { headers: { "Cookie": "token=token123" } });
  const data = await (await handleApi(req, env, new URL(req.url), db)).json();
  assert.ok(Array.isArray(data.diario), "tem diario");
  assert.ok(Array.isArray(data.mesVsAnterior), "tem mesVsAnterior");
  assert.equal(db.estado.mesRef, "2026-09"); // resumoMesVsAnterior recebeu o mês
});
