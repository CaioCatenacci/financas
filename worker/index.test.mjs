import { test } from "node:test";
import assert from "node:assert/strict";
import { tratarUpdate, handleTelegram } from "./index.js";

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
        { id: "cNI", nome: "Não Identificado", natureza: "despesa", padrao: true },
        { id: "cRec", nome: "Receita", natureza: "receita" },
      ],
      subcategorias: [
        { id: "sLimp", categoria_id: "cCasa", nome: "Limpeza" },
        { id: "sIng", categoria_id: "cEdu", nome: "Inglês Particular" },
      ],
    }),
    documentoPorHash: async () => null,
    inserirDocumento: async (d) => { estado.docs.push(d); return { id: "doc1" }; },
    inserirTransacao: async (t) => { estado.inseridos.push(t); return { id: "tx1" }; },
    // Inc 4.6: apagar passa por podeApagar; sem grupo → gravarGrupo só apaga
    grupoDaTransacao: async () => [],
    gravarGrupo: async ({ apagarId }) => { if (apagarId) estado.apagados.push(apagarId); return { alterados: 0, apagados: 1 }; },
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

test("texto sem categoria cai na categoria padrão (flag) e avisa pessoa inexistente", async () => {
  const enviados = [];
  const db = dbFake();
  db.pessoaPorNome = async () => null; // ninguém casa
  const deps = { db, confirmar: async (c, t) => enviados.push(t), responderImpl: async () => {} };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "mercado 30,00 01/03/2026 pessoa=Xuxa" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  const ins = db.estado.inseridos[0];
  assert.equal(ins.categoria_id, "cNI");     // padrão por flag (fallback do resolverCategoria)
  assert.equal(ins.pessoa_id, null);
  assert.ok(enviados.some((t) => /Xuxa/.test(t)));  // avisou o não-encontrado
});

test("texto com categoria inexistente cai na padrão e o aviso cita o nome dela", async () => {
  const enviados = [];
  const db = dbFake();
  const deps = { db, confirmar: async (c, t) => enviados.push(t), responderImpl: async () => {} };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "mercado 30,00 01/03/2026 categoria=Marte" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.estado.inseridos[0].categoria_id, "cNI");
  assert.ok(enviados.some((t) => /Não Identificado/.test(t)));
});

test("handleTelegram: exceção no fluxo responde 200 e avisa o usuário (nunca 500 mudo)", async () => {
  // 500 faz o Telegram retentar em loop e o usuário fica sem resposta; 200 + aviso fecha o ciclo.
  const respostas = [];
  const db = dbFake();
  db.inserirTransacao = async () => { throw new Error("boom no banco"); };
  const deps = { db, confirmar: async () => {}, responderImpl: async (c, t) => respostas.push(t) };
  const env = { TELEGRAM_SECRET: "s", ALLOWLIST: "7", TELEGRAM_TOKEN: "t" };
  const request = new Request("http://localhost/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "content-type": "application/json" },
    body: JSON.stringify({ message: { chat: { id: 7 }, message_id: 1, text: "mercado 30,00 01/03/2026" } }),
  });
  const resp = await handleTelegram(request, env, deps);
  assert.equal(resp.status, 200);
  assert.equal(respostas.length, 1);
  assert.match(respostas[0], /erro/i);
});

test("texto sem natureza= sob categoria de receita grava receita e a confirmação mostra o sinal +", async () => {
  // B5: o Caio lançou o salário por texto sem natureza=receita e ficou despesa no Resumo
  const enviados = [];
  const db = dbFake();
  const deps = { db, confirmar: async (c, t) => enviados.push(t), responderImpl: async () => {} };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "salário 36120,00 22/09/2026 categoria=Receita" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  const ins = db.estado.inseridos[0];
  assert.equal(ins.categoria_id, "cRec");
  assert.equal(ins.natureza, "receita");
  assert.match(enviados[0], /\+R\$ 36\.120,00/);
});

test("texto com natureza=despesa explícita sob categoria de receita respeita o que foi escrito", async () => {
  const db = dbFake();
  const deps = { db, confirmar: async () => {}, responderImpl: async () => {} };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "estorno 10,00 22/09/2026 categoria=Receita natureza=despesa" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.estado.inseridos[0].natureza, "despesa");
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
    resumoPorPessoaCategoria: async () => [{ pessoa: "Alice", categoria: "Casa", total_cents: 30000 }],
    atualizarTransacoesLote: async (ids, mudancas) => { dbApiFake._lote = { ids, mudancas }; return { atualizados: ids.length, regras: 0 }; },
  };
}

// Importar handleApi para teste — precisa ser exportado
import { handleApi } from "./index.js";
import { linhaHash as linhaHashC8 } from "./reconciliar.js";

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
    hashesExistentes: async () => [],
    aplicarImportacao: async (d) => {
      estado.aplicado = d;
      return { gravados: (d.novos || []).length + (d.naoGasto || []).length, agrupados: (d.casados || []).length, naoGasto: (d.naoGasto || []).length };
    },
    marcarPagamentoFaturaNaoGasto: async (totalCents, de, ate) => {
      estado.pagamento = { totalCents, de, ate };
      return { marcados: 1, candidatos: 1 };
    },
    // G2: o aplicar grava o período coberto pelo arquivo
    registrarImportacao: async (i) => { (estado.importacoes ||= []).push(i); },
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

test("C8: POST /api/importar/preview (fatura) busca as chaves nova e antiga por igualdade e não duplica a linha corrigida", async () => {
  // banco depois da 0010: a linha está em 2025-05-29 (um ano antes) com a linha_hash antiga
  // (data 2026-05-29 = ano da fatura + DD/MM). A fatura é de 2026-04: compra de maio à vista
  // numa fatura de abril → a regra nova data em 2025-05-29. Uma janela de data não acharia a
  // chave antiga; a busca por igualdade acha.
  const antiga = linhaHashC8("fatura-202604", "2026-05-29", "PARK E CO ESTACIONAME", 1700, 0);
  let pedidas = null;
  const db = {
    ...dbImportarFake(),
    hashesNaJanela: async () => { throw new Error("fatura não usa janela"); },
    hashesExistentes: async (ch) => { pedidas = ch; return ch.filter((h) => h === antiga); },
  };
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const request = new Request("http://localhost/api/importar/preview", {
    method: "POST", headers: { "Cookie": "token=token123", "content-type": "application/json" },
    body: JSON.stringify({ tipo: "fatura", texto: TXT_FATURA_MIN, ano: 2026, mes: 4 }),
  });
  const data = await (await handleApi(request, env, new URL(request.url), db)).json();
  assert.ok(pedidas.includes(antiga), "a chave antiga entra na busca");
  assert.ok(pedidas.includes(linhaHashC8("fatura-202604", "2025-05-29", "PARK E CO ESTACIONAME", 1700, 0)), "a nova também");
  assert.equal(data.resumo.jaTem, 1);
  assert.equal(data.resumo.novos, 0);
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
    // G1: salário por competência (números inventados): USD 8.000 desde jan/2026, uma conversão
    // de 8.000 → 40.000 em setembro — setembro fecha exato
    salarioParams: async () => [{ vigente_desde: "2026-01-01", usd_cents: 800000 }],
    conversoes: async () => [{ id: "c1", data: "2026-09-03", usd_cents: 800000, brl_cents: 4000000, origem: "wise" }],
    saldoPorMes: async (de, ateExcl) => { estado.saldo = { de, ateExcl }; return [{ mes: "2026-09", receita_cents: 100000, despesa_cents: 3800000 }]; },
    // A3: somas da cascata (inventadas; a igualdade com o saldo-mensal tem teste próprio, abaixo)
    somasPorEsfera: async (de, ateExcl) => { estado.esfera = { de, ateExcl }; return { despesa_empresa_cents: 300000, despesa_pessoal_cents: 2500000, outras_receitas_cents: 100000 }; },
    despesaPessoalPorCategoria: async () => [{ macro: "Casa", total_cents: 2500000 }],
    resumoKPIs: async () => ({ receita: "1000.00", despesa: "500.00", reembolso: "0.00" }),
    resumoPorCategoria: async () => [{ macro: "Casa", sub: "Limpeza", natureza: "despesa", total: 500, n: 1 }],
    resumoPorPessoa: async () => [{ pessoa: "Alice", natureza: "despesa", total: 300 }],
    resumoPorPessoaCategoria: async (de, ate) => { estado.ppc = { de, ate }; return [{ pessoa: "Alice", categoria: "Casa", total_cents: 30000 }]; },
    resumoDiario: async (de, ateExcl) => { estado.de = de; estado.ateExcl = ateExcl; return [{ dia: "2026-09-01", total: 500 }]; },
    resumoMesVsAnterior: async (mesRef) => { estado.mesRef = mesRef; return [{ macro: "Casa", atual: 500, ant: 300 }]; },
    // D5 (meses e valores inventados): primeira fatura do ano anterior vence em maio
    faturasImportadas: async (de, ateExcl) => { estado.faturas = { de, ateExcl }; return estado.mesesFatura || ["2025-05", "2025-06", "2025-07", "2026-08", "2026-09"]; },
    resumoAnoVsAnterior: async (de, ateExcl, deAnt, ateExclAnt) => {
      estado.ano = { de, ateExcl, deAnt, ateExclAnt };
      return [
        { categoria: "Escola", atual_cents: 440000, anterior_cents: 400000 },
        { categoria: "Não Identificado", atual_cents: 10000, anterior_cents: 90000 },
      ];
    },
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

test("/api/resumo?mes= devolve porPessoaCategoria do db, no intervalo do mês", async () => {
  // o sunburst pessoa → categoria (D6) lê este corte; o intervalo é o mesmo dos kpis
  const db = dbResumoFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const req = new Request("http://localhost/api/resumo?mes=2026-09", { headers: { "Cookie": "token=token123" } });
  const data = await (await handleApi(req, env, new URL(req.url), db)).json();
  assert.deepEqual(data.porPessoaCategoria, [{ pessoa: "Alice", categoria: "Casa", total_cents: 30000 }]);
  assert.deepEqual(db.estado.ppc, { de: "2026-09-01", ate: "2026-09-30" });
});

// ---------- D5: este ano × ano passado ----------
test("D5 /api/resumo?mes= devolve anoVsAnterior com as datas do período e as categorias em centavos inteiros", async () => {
  // Exemplo do D5: setembro/2026 e primeira fatura de 2025 em maio → jun–set nos dois anos
  const db = dbResumoFake();
  const req = new Request("http://localhost/api/resumo?mes=2026-09", { headers: { "Cookie": "token=token123" } });
  const data = await (await handleApi(req, { APP_TOKEN: "token123", DATABASE_URL: "" }, new URL(req.url), db)).json();
  const a = data.anoVsAnterior;
  assert.equal(a.de, "2026-06-01");
  assert.equal(a.ate, "2026-09-30");
  assert.equal(a.de_anterior, "2025-06-01");
  assert.equal(a.ate_anterior, "2025-09-30");
  assert.deepEqual(Object.keys(a).sort(), ["ate", "ate_anterior", "categorias", "de", "de_anterior"]);
  // as faturas do ano anterior (início) e do corrente (fim) vêm numa leitura só; o SQL recebe janelas meio-abertas
  assert.deepEqual(db.estado.faturas, { de: "2025-01-01", ateExcl: "2027-01-01" });
  assert.deepEqual(db.estado.ano, { de: "2026-06-01", ateExcl: "2026-10-01", deAnt: "2025-06-01", ateExclAnt: "2025-10-01" });
  for (const c of a.categorias) {
    assert.ok(Number.isInteger(c.atual_cents) && Number.isInteger(c.anterior_cents), "centavos inteiros");
  }
});

test("D5 a categoria padrão (Não Identificado) entra em anoVsAnterior.categorias como as outras, sem filtro nem ajuste", async () => {
  const db = dbResumoFake();
  const req = new Request("http://localhost/api/resumo?mes=2026-09", { headers: { "Cookie": "token=token123" } });
  const data = await (await handleApi(req, { APP_TOKEN: "token123", DATABASE_URL: "" }, new URL(req.url), db)).json();
  assert.deepEqual(data.anoVsAnterior.categorias.find((c) => c.categoria === "Não Identificado"),
    { categoria: "Não Identificado", atual_cents: 10000, anterior_cents: 90000 });
});

test("D5 sem fatura no ano anterior, anoVsAnterior vem null (o card não aparece)", async () => {
  const db = dbResumoFake();
  db.estado.mesesFatura = ["2026-01"];
  const req = new Request("http://localhost/api/resumo?mes=2026-09", { headers: { "Cookie": "token=token123" } });
  const data = await (await handleApi(req, { APP_TOKEN: "token123", DATABASE_URL: "" }, new URL(req.url), db)).json();
  assert.equal(data.anoVsAnterior, null);
  assert.equal(db.estado.ano, undefined, "nem consulta a soma");
});

test("D5 mês antes do início: o objeto vem com `de` = início e categorias vazias, sem somar nada", async () => {
  const db = dbResumoFake();
  const req = new Request("http://localhost/api/resumo?mes=2026-03", { headers: { "Cookie": "token=token123" } });
  const data = await (await handleApi(req, { APP_TOKEN: "token123", DATABASE_URL: "" }, new URL(req.url), db)).json();
  assert.equal(data.anoVsAnterior.de, "2026-06-01");
  assert.deepEqual(data.anoVsAnterior.categorias, []);
  assert.equal(db.estado.ano, undefined);
});

// ---------- Inc 4.6: grupos ----------
// Ids em forma de uuid: as rotas de grupo recusam id que não é uuid antes de chegar ao SQL (F3),
// então as fixtures precisam ter a mesma forma que o banco devolve.
const M1 = "00000000-0000-4000-8000-0000000000a1";
const E1 = "00000000-0000-4000-8000-0000000000e1";
const G0 = "00000000-0000-4000-8000-0000000000f0";
const NAO_EXISTE = "00000000-0000-4000-8000-000000000999";
const FORA_DO_GRUPO = "00000000-0000-4000-8000-000000000777";
function dbGruposFake(linhas) {
  // `linhas`: o que transacoesPorIds/membrosDoGrupo/grupoDaTransacao devolvem (mesmo conjunto,
  // pra simplificar); `gravado` guarda o que gravarGrupo recebeu.
  const f = {
    gravado: null,
    chamadas: [],   // quais leituras do banco a rota fez (F3: entrada malformada não pode chegar lá)
    transacoesPorIds: async (ids) => { f.chamadas.push("transacoesPorIds"); return linhas.filter((l) => ids.includes(l.id)); },
    membrosDoGrupo: async (g) => { f.chamadas.push("membrosDoGrupo"); return linhas.filter((l) => l.grupo_id === g); },
    grupoDaTransacao: async (id) => { const t = linhas.find((l) => l.id === id); return t && t.grupo_id ? linhas.filter((l) => l.grupo_id === t.grupo_id) : []; },
    gravarGrupo: async (arg) => { f.gravado = arg; return { alterados: arg.mudancas.length, apagados: arg.apagarId ? 1 : 0 }; },
  };
  return f;
}
const envApi = { APP_TOKEN: "token123", DATABASE_URL: "" };
const reqApi = (path, method, body) => new Request(`http://localhost${path}`, {
  method, headers: { "Cookie": "token=token123", "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});
const manualG = { id: M1, fonte: "manual",  criado_em: "2026-09-02", grupo_id: null, representante: false, valor_final: "2500.00" };
const extratoG = { id: E1, fonte: "extrato", criado_em: "2026-09-30", grupo_id: null, representante: false, valor_final: "2500.00" };

test("POST /api/grupos agrupa e grava as mudanças; representante = o lançamento manual", async () => {
  const db = dbGruposFake([manualG, extratoG]);
  const r = await handleApi(reqApi("/api/grupos", "POST", { ids: [M1, E1] }), envApi, new URL("http://localhost/api/grupos"), db);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.representante_id, M1);
  assert.ok(data.grupo_id, "gera um grupo_id");
  assert.equal(db.gravado.mudancas.length, 2);
  assert.ok(db.gravado.mudancas.every((m) => m.grupo_id === data.grupo_id));
});

test("POST /api/grupos com ids repetidos/inexistentes → 400 legível (não cria grupo de 1)", async () => {
  const db = dbGruposFake([manualG, extratoG]);
  const r = await handleApi(reqApi("/api/grupos", "POST", { ids: [M1, M1, NAO_EXISTE] }), envApi, new URL("http://localhost/api/grupos"), db);
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro, /pelo menos 2/i);
  assert.equal(db.gravado, null);
});

test("PATCH /api/grupos/:g troca o representante; id fora do grupo → 400", async () => {
  const db = dbGruposFake([{ ...manualG, grupo_id: G0, representante: true }, { ...extratoG, grupo_id: G0 }]);
  const ok = await handleApi(reqApi(`/api/grupos/${G0}`, "PATCH", { representante_id: E1 }), envApi, new URL(`http://localhost/api/grupos/${G0}`), db);
  assert.equal(ok.status, 200);
  assert.deepEqual(db.gravado.mudancas.map((m) => [m.id, m.representante]), [[M1, false], [E1, true]]);
  const bad = await handleApi(reqApi(`/api/grupos/${G0}`, "PATCH", { representante_id: FORA_DO_GRUPO }), envApi, new URL(`http://localhost/api/grupos/${G0}`), db);
  assert.equal(bad.status, 400);
});

test("DELETE /api/grupos/:g/membros/:id tira o membro; tirar o representante → 400", async () => {
  const db = dbGruposFake([{ ...manualG, grupo_id: G0, representante: true }, { ...extratoG, grupo_id: G0 }]);
  const bad = await handleApi(reqApi(`/api/grupos/${G0}/membros/${M1}`, "DELETE"), envApi, new URL(`http://localhost/api/grupos/${G0}/membros/${M1}`), db);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).erro, /escolha outro representante/i);
  const ok = await handleApi(reqApi(`/api/grupos/${G0}/membros/${E1}`, "DELETE"), envApi, new URL(`http://localhost/api/grupos/${G0}/membros/${E1}`), db);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).dissolveu, true);
});

test("DELETE /api/grupos/:g desagrupa todos", async () => {
  const db = dbGruposFake([{ ...manualG, grupo_id: G0, representante: true }, { ...extratoG, grupo_id: G0 }]);
  const r = await handleApi(reqApi(`/api/grupos/${G0}`, "DELETE"), envApi, new URL(`http://localhost/api/grupos/${G0}`), db);
  assert.equal(r.status, 200);
  assert.ok(db.gravado.mudancas.every((m) => m.grupo_id === null && m.representante === false));
});

test("DELETE /api/transacoes/:id recusa apagar representante com membros; membro comum apaga e dissolve", async () => {
  const db = dbGruposFake([{ ...manualG, grupo_id: G0, representante: true }, { ...extratoG, grupo_id: G0 }]);
  const bad = await handleApi(reqApi(`/api/transacoes/${M1}`, "DELETE"), envApi, new URL(`http://localhost/api/transacoes/${M1}`), db);
  assert.equal(bad.status, 400);
  const ok = await handleApi(reqApi(`/api/transacoes/${E1}`, "DELETE"), envApi, new URL(`http://localhost/api/transacoes/${E1}`), db);
  assert.equal(ok.status, 200);
  assert.equal(db.gravado.apagarId, E1);
  assert.deepEqual(db.gravado.mudancas, [{ id: M1, grupo_id: null, representante: false }]);
});

test("Telegram del: recusa apagar representante com membros e avisa no chat", async () => {
  const respostas = [];
  const db = dbGruposFake([{ ...manualG, grupo_id: G0, representante: true }, { ...extratoG, grupo_id: G0 }]);
  const deps = { db, confirmar: async () => {}, responderImpl: async (c, t) => respostas.push(t) };
  const update = { callback_query: { message: { chat: { id: 7 }, message_id: 3 }, data: `del:${M1}` } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.gravado, null);
  assert.match(respostas[0], /escolha outro representante/i);
});

// ---------- F3: entrada malformada nas rotas de grupo responde 400, não 500 ----------
// Antes, `ids` que não era lista estourava num TypeError (`.map` de string/número/objeto) e id
// que não era uuid estourava no cast `::uuid` do Postgres — os dois viravam 500 sem mensagem.
// A validação roda antes de qualquer leitura: o banco nunca vê a entrada torta.
const grupoFormado = () => dbGruposFake([{ ...manualG, grupo_id: G0, representante: true }, { ...extratoG, grupo_id: G0 }]);
const semBanco = (db) => { assert.deepEqual(db.chamadas, []); assert.equal(db.gravado, null); };

for (const [nome, ids] of [["string", M1], ["número", 42], ["objeto", { a: M1 }]]) {
  test(`POST /api/grupos com ids ${nome} → 400 {erro}, sem tocar no banco`, async () => {
    const db = dbGruposFake([manualG, extratoG]);
    const r = await handleApi(reqApi("/api/grupos", "POST", { ids }), envApi, new URL("http://localhost/api/grupos"), db);
    assert.equal(r.status, 400);
    assert.ok((await r.json()).erro);
    semBanco(db);
  });
}

test("POST /api/grupos com um id que não é uuid na lista → 400 antes do SQL", async () => {
  const db = dbGruposFake([manualG, extratoG]);
  const r = await handleApi(reqApi("/api/grupos", "POST", { ids: ["abc", M1] }), envApi, new URL("http://localhost/api/grupos"), db);
  assert.equal(r.status, 400);
  assert.ok((await r.json()).erro);
  semBanco(db);
});

test("POST /api/grupos com ids ausente ou null segue 400 'pelo menos 2' (como antes)", async () => {
  for (const b of [{}, { ids: null }]) {
    const db = dbGruposFake([manualG, extratoG]);
    const r = await handleApi(reqApi("/api/grupos", "POST", b), envApi, new URL("http://localhost/api/grupos"), db);
    assert.equal(r.status, 400);
    assert.match((await r.json()).erro, /pelo menos 2/i);
    assert.equal(db.gravado, null);
  }
});

test("PATCH /api/grupos/:g com :g que não é uuid → 400 sem ler membros", async () => {
  const db = grupoFormado();
  const r = await handleApi(reqApi("/api/grupos/G0", "PATCH", { representante_id: E1 }), envApi, new URL("http://localhost/api/grupos/G0"), db);
  assert.equal(r.status, 400);
  assert.ok((await r.json()).erro);
  semBanco(db);
});

test("PATCH /api/grupos/:g com representante_id que não é uuid → 400", async () => {
  const db = grupoFormado();
  const r = await handleApi(reqApi(`/api/grupos/${G0}`, "PATCH", { representante_id: "zzz" }), envApi, new URL(`http://localhost/api/grupos/${G0}`), db);
  assert.equal(r.status, 400);
  assert.ok((await r.json()).erro);
  semBanco(db);
});

test("DELETE /api/grupos/:g/membros/:id com :g que não é uuid → 400 sem ler membros", async () => {
  const db = grupoFormado();
  const r = await handleApi(reqApi(`/api/grupos/G0/membros/${E1}`, "DELETE"), envApi, new URL(`http://localhost/api/grupos/G0/membros/${E1}`), db);
  assert.equal(r.status, 400);
  assert.ok((await r.json()).erro);
  semBanco(db);
});

test("DELETE /api/grupos/:g/membros/:id com :id que não é uuid → 400 sem ler membros", async () => {
  const db = grupoFormado();
  const r = await handleApi(reqApi(`/api/grupos/${G0}/membros/e1`, "DELETE"), envApi, new URL(`http://localhost/api/grupos/${G0}/membros/e1`), db);
  assert.equal(r.status, 400);
  assert.ok((await r.json()).erro);
  semBanco(db);
});

test("DELETE /api/grupos/:g com :g que não é uuid → 400 sem ler nem gravar", async () => {
  const db = grupoFormado();
  const r = await handleApi(reqApi("/api/grupos/G0", "DELETE"), envApi, new URL("http://localhost/api/grupos/G0"), db);
  assert.equal(r.status, 400);
  assert.ok((await r.json()).erro);
  semBanco(db);
});

// ---------- F2: aplicar com prévia velha → 409, nada gravado ----------
// O fake devolve o estado ATUAL das linhas (transacoesPorIds) e dos grupos (membrosDosGrupos);
// a prévia que o app mandou descreve o estado que ele viu. Divergiu → 409 antes de qualquer
// gravação (nem o lote, nem a marcação do pagamento da fatura).
const L1 = "00000000-0000-4000-8000-0000000000b1";
const L2 = "00000000-0000-4000-8000-0000000000b2";
const G9 = "00000000-0000-4000-8000-0000000000f9";
const GN = "00000000-0000-4000-8000-0000000000fa";
function dbAplicarFake(linhas) {
  const f = {
    chamadas: [],
    transacoesPorIds: async (ids) => { f.chamadas.push("transacoesPorIds"); return linhas.filter((l) => ids.includes(l.id)); },
    membrosDosGrupos: async (gs) => { f.chamadas.push("membrosDosGrupos"); return linhas.filter((l) => l.grupo_id && gs.includes(l.grupo_id)); },
    aplicarImportacao: async (d) => { f.chamadas.push("aplicarImportacao"); return { gravados: 0, agrupados: d.casados.length, naoGasto: 0 }; },
    marcarPagamentoFaturaNaoGasto: async () => { f.chamadas.push("marcarPagamentoFaturaNaoGasto"); return { marcados: 1, candidatos: 1 }; },
    registrarImportacao: async () => { f.chamadas.push("registrarImportacao"); }, // G2
  };
  return f;
}
const lanc = (grupo_id, representante = false, id = L1) =>
  ({ id, fonte: "manual", criado_em: "2026-09-01", grupo_id, representante, valor_final: "10.00" });
const casado = (grupo_id, grupoExistente) =>
  ({ matchId: L1, grupoExistente, linha: { descricao: "x", categoria_id: "cO", grupo_id, representante: false } });
async function aplicarCom(db, casados) {
  const req = reqApi("/api/importar/aplicar", "POST", {
    decisao: { novos: [{ descricao: "n", categoria_id: "cO" }], naoGasto: [], casados },
    fatura: { totalCents: 16700, ano: 2025, mes: 5 },
  });
  return handleApi(req, envApi, new URL(req.url), db);
}
async function confere409(r, db) {
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { erro: "a prévia ficou velha, gere de novo" });
  assert.ok(!db.chamadas.includes("aplicarImportacao"), "não gravou o lote");
  assert.ok(!db.chamadas.includes("marcarPagamentoFaturaNaoGasto"), "não marcou o pagamento da fatura");
}

test("POST /api/importar/aplicar: grupo da prévia não existe mais → 409, nada gravado", async () => {
  // Exemplo do item: G0 foi desagrupado depois da prévia e L ficou solto
  const db = dbAplicarFake([lanc(null)]);
  await confere409(await aplicarCom(db, [casado(G0, true)]), db);
});

test("POST /api/importar/aplicar: grupo existe mas sem representante → 409, nada gravado", async () => {
  const db = dbAplicarFake([lanc(G0, false), lanc(G0, false, L2)]);
  await confere409(await aplicarCom(db, [casado(G0, true)]), db);
});

test("POST /api/importar/aplicar: lançamento casado em outro grupo / solto / agrupado → 409", async () => {
  for (const [linhas, c] of [
    [[lanc(G9, true)], casado(G0, true)],   // prévia viu G0, agora está em G9
    [[lanc(null)], casado(G0, true)],       // prévia viu G0, agora está solto
    [[lanc(G9, true)], casado(GN, false)],  // prévia viu solto, agora está em G9
  ]) {
    const db = dbAplicarFake(linhas);
    await confere409(await aplicarCom(db, [c]), db);
  }
});

test("POST /api/importar/aplicar: lançamento casado apagado → 409, nada gravado", async () => {
  const db = dbAplicarFake([]);
  await confere409(await aplicarCom(db, [casado(GN, false)]), db);
});

test("POST /api/importar/aplicar: prévia em dia (L solto, grupo novo) grava; leitura vem antes da gravação", async () => {
  // segunda metade do Exemplo: prévia nova casa X com L solto → grava normalmente
  const db = dbAplicarFake([lanc(null)]);
  const r = await aplicarCom(db, [casado(GN, false)]);
  assert.equal(r.status, 200);
  assert.ok(db.chamadas.indexOf("transacoesPorIds") < db.chamadas.indexOf("aplicarImportacao"));
  assert.ok(db.chamadas.includes("marcarPagamentoFaturaNaoGasto"));
});

test("POST /api/importar/aplicar: grupo existe com representante → grava", async () => {
  const db = dbAplicarFake([lanc(G0, false), lanc(G0, true, L2)]);
  const r = await aplicarCom(db, [casado(G0, true)]);
  assert.equal(r.status, 200);
  assert.ok(db.chamadas.indexOf("membrosDosGrupos") < db.chamadas.indexOf("aplicarImportacao"));
});

test("POST /api/importar/aplicar sem casados não lê nada antes de gravar", async () => {
  const db = dbAplicarFake([]);
  const r = await aplicarCom(db, []);
  assert.equal(r.status, 200);
  // G2: a fatura também registra o mês coberto em importacoes, depois de gravar
  assert.deepEqual(db.chamadas, ["aplicarImportacao", "marcarPagamentoFaturaNaoGasto", "registrarImportacao"]);
});

// ---------- F2: POST /api/grupos num grupo sem representante → 400 ----------
test("POST /api/grupos num grupo existente sem representante → 400, nada gravado", async () => {
  const db = dbGruposFake([{ ...manualG, grupo_id: G0, representante: false }, extratoG]);
  const r = await handleApi(reqApi("/api/grupos", "POST", { ids: [M1, E1] }), envApi, new URL("http://localhost/api/grupos"), db);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).erro, "o grupo não tem representante");
  assert.equal(db.gravado, null);
});

test("POST /api/grupos: representante do grupo fora da seleção → aceito (checa o grupo inteiro)", async () => {
  const db = dbGruposFake([
    { ...manualG, id: L2, grupo_id: G0, representante: true },  // representante, não selecionado
    { ...manualG, grupo_id: G0, representante: false },
    extratoG,
  ]);
  const r = await handleApi(reqApi("/api/grupos", "POST", { ids: [M1, E1] }), envApi, new URL("http://localhost/api/grupos"), db);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { grupo_id: G0, representante_id: L2 });
  assert.deepEqual(db.gravado.mudancas, [{ id: E1, grupo_id: G0, representante: false }]);
});

// ---- B2: painel de regras aprendidas (GET/PATCH/DELETE /api/associacoes) ----
// Fake com as associações em memória: a mesma instância atende a rota do painel e a captura
// do Telegram, pra provar que editar/remover vale já na próxima captura (a captura relê
// buscarAssociacao a cada foto). Chaves inventadas — o repositório é público.
function dbAssocFake() {
  const base = dbFake();
  const catalogo = {
    categorias: [
      { id: "cAli", nome: "Alimentação", natureza: "despesa" },
      { id: "cComp", nome: "Compras", natureza: "despesa" },
      { id: "cCasa", nome: "Casa", natureza: "despesa" },
      { id: "cNI", nome: "Não Identificado", natureza: "despesa", padrao: true },
    ],
    subcategorias: [
      { id: "sPad", categoria_id: "cAli", nome: "Padaria" },
      { id: "sLimp", categoria_id: "cCasa", nome: "Limpeza" },
    ],
  };
  const assoc = new Map([
    ["nome|PADARIA EXEMPLO", { chave: "PADARIA EXEMPLO", tipo_chave: "nome", categoria_id: "cAli", subcategoria_id: "sPad", n: 3, atualizado_em: "2026-09-10T12:00:00.000Z" }],
    ["pix_cpf|00000000000191", { chave: "00000000000191", tipo_chave: "pix_cpf", categoria_id: "cCasa", subcategoria_id: null, n: 1, atualizado_em: "2026-09-03T12:00:00.000Z" }],
  ]);
  const nomeCat = (id) => catalogo.categorias.find((c) => c.id === id)?.nome ?? null;
  const nomeSub = (id) => catalogo.subcategorias.find((s) => s.id === id)?.nome ?? null;
  return {
    ...base,
    assoc,
    catalogo: async () => catalogo,
    buscarAssociacao: async (chave, tipo) => assoc.get(`${tipo}|${chave}`) ?? null,
    listarAssociacoes: async () => [...assoc.values()]
      .map((a) => ({ ...a, categoria: nomeCat(a.categoria_id), subcategoria: nomeSub(a.subcategoria_id) }))
      .sort((x, y) => (x.atualizado_em < y.atualizado_em ? 1 : -1)),
    editarAssociacao: async ({ chave, tipo_chave, categoria_id, subcategoria_id }) => {
      const a = assoc.get(`${tipo_chave}|${chave}`); if (!a) return { alterados: 0 };
      Object.assign(a, { categoria_id, subcategoria_id: subcategoria_id ?? null }); return { alterados: 1 };
    },
    apagarAssociacao: async (chave, tipo_chave) => ({ apagados: assoc.delete(`${tipo_chave}|${chave}`) ? 1 : 0 }),
  };
}
// captura de um comprovante da contraparte inventada; o modelo "chuta" Casa › Limpeza
async function capturarPadaria(db) {
  const deps = {
    db,
    baixar: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg" }),
    hashBytes: async () => "hB2",
    extrairImpl: async () => ({ ok: true, extraido_por: "gemini", confianca: 0.9,
      normalizado: { dataISO: "2026-09-20", valorCents: 1250, natureza: "despesa",
        macro: "Casa", sub: "Limpeza", descricao: "Pão",
        contraparte_nome: "Padaria Exemplo", contraparte_chave: null } }),
    subir: async () => "/x.jpg",
    confirmar: async () => {},
    responderImpl: async () => {},
  };
  const update = { message: { chat: { id: 7 }, message_id: 1, photo: [{ file_id: "b", width: 800 }] } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  return db.estado.inseridos.at(-1);
}

test("GET /api/associacoes devolve chave, tipo, categoria e sub (id e nome), n e atualizado_em, mais recente primeiro", async () => {
  const db = dbAssocFake();
  const r = await handleApi(reqApi("/api/associacoes", "GET"), envApi, new URL("http://localhost/api/associacoes"), db);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.length, 2);
  assert.deepEqual(data[0], {
    chave: "PADARIA EXEMPLO", tipo_chave: "nome", categoria_id: "cAli", categoria: "Alimentação",
    subcategoria_id: "sPad", subcategoria: "Padaria", n: 3, atualizado_em: "2026-09-10T12:00:00.000Z",
  });
  assert.equal(data[1].tipo_chave, "pix_cpf");
  assert.equal(data[1].subcategoria_id, null);
  assert.equal(data[1].subcategoria, null);
});

test("PATCH /api/associacoes troca a categoria, mantém n, e a próxima captura usa a nova com origem 'regra'", async () => {
  const db = dbAssocFake();
  const r = await handleApi(reqApi("/api/associacoes", "PATCH",
    { chave: "PADARIA EXEMPLO", tipo_chave: "nome", categoria_id: "cComp", subcategoria_id: null }),
    envApi, new URL("http://localhost/api/associacoes"), db);
  assert.equal(r.status, 200);
  assert.equal(db.assoc.get("nome|PADARIA EXEMPLO").n, 3);
  const ins = await capturarPadaria(db);
  assert.equal(ins.categoria_id, "cComp");
  assert.equal(ins.subcategoria_id, null);
  assert.equal(ins.origem_categoria, "regra");
});

test("PATCH /api/associacoes recusa tipo fora do vocabulário, categoria inexistente e sub de outra categoria", async () => {
  const db = dbAssocFake();
  const patch = (b) => handleApi(reqApi("/api/associacoes", "PATCH", b), envApi, new URL("http://localhost/api/associacoes"), db);
  assert.equal((await patch({ chave: "PADARIA EXEMPLO", tipo_chave: "cpf", categoria_id: "cComp" })).status, 400);
  assert.equal((await patch({ chave: "PADARIA EXEMPLO", tipo_chave: "nome", categoria_id: "nao-existe" })).status, 400);
  assert.equal((await patch({ chave: "PADARIA EXEMPLO", tipo_chave: "nome", categoria_id: "cComp", subcategoria_id: "sPad" })).status, 400);
  assert.equal((await patch({ chave: "", tipo_chave: "nome", categoria_id: "cComp" })).status, 400);
  assert.equal(db.assoc.get("nome|PADARIA EXEMPLO").categoria_id, "cAli"); // nada mudou
});

test("PATCH /api/associacoes de uma associação que não existe → 404", async () => {
  const db = dbAssocFake();
  const r = await handleApi(reqApi("/api/associacoes", "PATCH", { chave: "NINGUEM", tipo_chave: "nome", categoria_id: "cComp" }),
    envApi, new URL("http://localhost/api/associacoes"), db);
  assert.equal(r.status, 404);
});

test("DELETE /api/associacoes remove por (chave, tipo_chave) e a próxima captura volta à sugestão do modelo", async () => {
  const db = dbAssocFake();
  const r = await handleApi(reqApi("/api/associacoes", "DELETE", { chave: "PADARIA EXEMPLO", tipo_chave: "nome" }),
    envApi, new URL("http://localhost/api/associacoes"), db);
  assert.equal(r.status, 200);
  assert.equal(db.assoc.has("nome|PADARIA EXEMPLO"), false);
  assert.equal(db.assoc.size, 1); // a outra regra ficou
  const ins = await capturarPadaria(db);
  assert.equal(ins.categoria_id, "cCasa");       // o chute do modelo
  assert.equal(ins.subcategoria_id, "sLimp");
  assert.equal(ins.origem_categoria, "modelo");
});

test("DELETE /api/associacoes de uma associação que não existe → 404; tipo inválido → 400", async () => {
  const db = dbAssocFake();
  const del = (b) => handleApi(reqApi("/api/associacoes", "DELETE", b), envApi, new URL("http://localhost/api/associacoes"), db);
  assert.equal((await del({ chave: "NINGUEM", tipo_chave: "nome" })).status, 404);
  assert.equal((await del({ chave: "PADARIA EXEMPLO", tipo_chave: "outro" })).status, 400);
});

// C3: reaplicar a mesma fatura tem que deixar o banco como uma aplicação só. O db é o de verdade
// (criarDb) sobre um sql fake que guarda as linhas de extrato de mesmo total e responde ao select
// da marcação como o banco responderia àquele WHERE — assim o teste pega o defeito real: o
// pagamento marcado sumia do select e a outra despesa de mesmo total virava o candidato único.
import { criarDb } from "./db.js";

function sqlBancoFake(linhas) {
  const chamadas = [];
  const fn = (strings, ...values) => {
    const text = strings.join("?");
    chamadas.push({ text, values });
    if (/update transacoes set computa_resumo = false/i.test(text)) {
      for (const l of linhas) if (l.id === values[0]) { l.computa_resumo = false; l.conta_no_resumo = false; }
      return Promise.resolve([]);
    }
    if (/select id/i.test(text) && /fonte = 'extrato'/i.test(text)) {
      const pedeMarcadas = /computa_resumo = false/i.test(text);
      return Promise.resolve(linhas.filter((l) => l.conta_no_resumo || (pedeMarcadas && !l.computa_resumo)).map((l) => ({ ...l })));
    }
    return Promise.resolve([{ id: "novo" }]); // insert ... returning id
  };
  fn.chamadas = chamadas;
  fn.transaction = (queries) => Promise.resolve(queries.map(() => [{ id: "novo" }]));
  return fn;
}

test("POST /api/importar/aplicar (fatura) duas vezes: só a 1ª marca o pagamento (C3, Exemplo)", async () => {
  // fatura de agosto, R$ 500,00 (ano fictício). No banco, só linhas de extrato de mesmo total.
  const fatura = { totalCents: 50000, ano: 2031, mes: 8 };
  const linhas = [{ id: "pgAgo", data: "2031-08-10", computa_resumo: true, conta_no_resumo: true }];
  const sql = sqlBancoFake(linhas);
  const db = criarDb(sql);
  const aplicarFatura = async (novos) => {
    const req = reqApi("/api/importar/aplicar", "POST", { decisao: { novos, naoGasto: [], casados: [] }, fatura });
    return (await handleApi(req, envApi, new URL(req.url), db)).json();
  };
  const updates = () => sql.chamadas.filter((c) => /update transacoes/i.test(c.text)).length;

  const r1 = await aplicarFatura([{ descricao: "item", categoria_id: "cO", valorCents: 50000 }]);
  assert.equal(r1.pagamentoMarcado, 1);
  assert.equal(updates(), 1, "a 1ª aplicação marca o pagamento");

  // o extrato de setembro entra depois com outra despesa de R$ 500,00, dentro da janela de 62 dias
  linhas.push({ id: "despSet", data: "2031-09-15", computa_resumo: true, conta_no_resumo: true });
  const antes = JSON.stringify(linhas);

  // reaplicação: os itens voltam como jaTem pelo hash, então o lote não traz novos
  const r2 = await aplicarFatura([]);
  assert.equal(updates(), 1, "a 2ª aplicação não produz update nenhum");
  assert.equal(r2.pagamentoMarcado, 0);
  assert.equal(r2.pagamentoJaMarcado, true);
  assert.equal(JSON.stringify(linhas), antes, "banco igual ao de uma aplicação só");
  assert.equal(linhas.find((l) => l.id === "despSet").conta_no_resumo, true, "a despesa de setembro segue no resumo");
});

// ---- C1: extrato do C6 Bank ----
// Senha e nomes inventados: o repositório é público.
const SENHA_FAKE = "senha-ficticia-123";

test("GET /api/importar/c6-senha sem token → 401 e não entrega a senha", async () => {
  const req = new Request("http://localhost/api/importar/c6-senha");
  const r = await handleApi(req, { ...envApi, C6_PDF_SENHA: SENHA_FAKE }, new URL(req.url), dbImportarFake());
  assert.equal(r.status, 401);
  assert.ok(!(await r.text()).includes(SENHA_FAKE));
});

test("GET /api/importar/c6-senha com token devolve o secret C6_PDF_SENHA (sem cache)", async () => {
  const req = reqApi("/api/importar/c6-senha", "GET");
  const r = await handleApi(req, { ...envApi, C6_PDF_SENHA: SENHA_FAKE }, new URL(req.url), dbImportarFake());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { senha: SENHA_FAKE });
});

test("GET /api/importar/c6-senha sem o secret devolve senha null, sem erro (o app pede num campo)", async () => {
  const req = reqApi("/api/importar/c6-senha", "GET");
  const r = await handleApi(req, envApi, new URL(req.url), dbImportarFake());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { senha: null });
});

test("POST /api/importar/preview com erro não ecoa a senha do C6 na mensagem", async () => {
  const db = { ...dbImportarFake(), catalogo: async () => { throw new Error("banco fora"); } };
  const req = reqApi("/api/importar/preview", "POST", { tipo: "c6", texto: "x" });
  const r = await handleApi(req, { ...envApi, C6_PDF_SENHA: SENHA_FAKE }, new URL(req.url), db);
  assert.equal(r.status, 500);
  assert.ok(!(await r.text()).includes(SENHA_FAKE));
});

const TXT_C6 = `Setembro 2031
0 9 / 0 9 0 9 / 0 9 Saldo do dia R$ 0,00
1 0 / 0 9 1 0 / 0 9 Entrada PIX Pix recebido de CAMBIO FICTICIO LTDA R$ 1.000,00
1 1 / 0 9 1 1 / 0 9 Saída PIX Pix enviado para FULANO DE TAL -R$ 400,00
1 1 / 0 9 1 1 / 0 9 Saldo do dia R$ 600,00`;

test("POST /api/importar/preview tipo c6: usa CONTAS_PROPRIAS do env, janela ±3 dias, sem aviso", async () => {
  const janelas = [];
  const db = { ...dbImportarFake(), transacoesNaJanela: async (de, ate) => { janelas.push([de, ate]); return []; } };
  const req = reqApi("/api/importar/preview", "POST", { tipo: "c6", texto: TXT_C6, conta: "c6" });
  const data = await (await handleApi(req, { ...envApi, CONTAS_PROPRIAS: "Fulano de Tal" }, new URL(req.url), db)).json();
  assert.equal(data.checksum.bloqueiaAplicar, false);
  assert.deepEqual(janelas, [["2031-09-07", "2031-09-14"]]);
  const sai = data.itens.find((i) => i.tipo === "Saída PIX");
  assert.equal(sai.computaResumo, false);
  assert.equal(data.itens.find((i) => i.tipo === "Entrada PIX").computaResumo, true);
  assert.deepEqual(data.avisos, []);
});

test("POST /api/importar/preview tipo c6 sem o secret CONTAS_PROPRIAS: nada é repasse e a resposta avisa", async () => {
  const req = reqApi("/api/importar/preview", "POST", { tipo: "c6", texto: TXT_C6 });
  const data = await (await handleApi(req, envApi, new URL(req.url), dbImportarFake())).json();
  assert.ok(data.itens.every((i) => i.computaResumo === true));
  assert.equal(data.avisos.length, 1);
});

test("POST /api/importar/aplicar tipo c6 ou extrato pareia os repasses na janela importada ±3 dias", async () => {
  for (const tipo of ["c6", "extrato"]) {
    const chamadas = [];
    const db = { ...dbImportarFake(), marcarRepassesEntreContas: async (de, ate) => { chamadas.push([de, ate]); return { marcados: 1, jaMarcados: 0, avisos: [] }; } };
    const decisao = { novos: [{ dataISO: "2031-09-12" }], naoGasto: [{ dataISO: "2031-09-10" }], casados: [] };
    const req = reqApi("/api/importar/aplicar", "POST", { decisao, tipo });
    const data = await (await handleApi(req, envApi, new URL(req.url), db)).json();
    assert.deepEqual(chamadas, [["2031-09-07", "2031-09-15"]], tipo);
    assert.equal(data.repassesMarcados, 1);
    assert.deepEqual(data.repassesAvisos, []);
  }
});

test("POST /api/importar/aplicar de fatura não pareia repasse (só extrato tem repasse)", async () => {
  let chamou = false;
  const db = { ...dbImportarFake(), marcarRepassesEntreContas: async () => { chamou = true; return { marcados: 0, jaMarcados: 0, avisos: [] }; } };
  const req = reqApi("/api/importar/aplicar", "POST", { decisao: { novos: [{ dataISO: "2031-09-12" }], naoGasto: [], casados: [] }, tipo: "fatura" });
  await handleApi(req, envApi, new URL(req.url), db);
  assert.equal(chamou, false);
});

// ---------- G1: salário por competência ----------
const G1_ENV = { APP_TOKEN: "token123", DATABASE_URL: "" };
const G1_COOK = { "Cookie": "token=token123" };

test("G1 /api/resumo?mes= devolve salario em centavos e kpis.receita (reais) = salário + outras receitas", async () => {
  const db = dbResumoFake();
  const req = new Request("http://localhost/api/resumo?mes=2026-09", { headers: G1_COOK });
  const data = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.deepEqual(data.salario, { mes: "2026-09", brl_cents: 4000000, usd_cents: 800000, taxa: 5, estimado: false });
  assert.equal(data.kpis.receita, "41000.00"); // 40.000 de salário + 1.000 das outras receitas, string em reais como hoje
  assert.equal(data.kpis.despesa, "500.00");
});

test("G1 /api/resumo?mes= num mês sem conversão: salário estimado (última taxa) e o selo vai junto", async () => {
  const db = dbResumoFake();
  const req = new Request("http://localhost/api/resumo?mes=2026-10", { headers: G1_COOK });
  const data = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.equal(data.salario.estimado, true);
  assert.equal(data.salario.brl_cents, 4000000);
});

test("G1 /api/resumo?mes= antes do primeiro parâmetro: salario nulo e kpis.receita só das outras receitas", async () => {
  const db = dbResumoFake();
  const req = new Request("http://localhost/api/resumo?mes=2025-06", { headers: G1_COOK });
  const data = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.equal(data.salario.brl_cents, null);
  assert.equal(data.salario.estimado, false);
  assert.equal(data.kpis.receita, "1000.00");
});

test("G1 /api/saldo-mensal?ate= devolve 12 meses com receita (salário + outras), despesa, saldo e estimado", async () => {
  const db = dbResumoFake();
  const req = new Request("http://localhost/api/saldo-mensal?ate=2026-09", { headers: G1_COOK });
  const data = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.equal(data.length, 12);
  assert.equal(data[0].mes, "2025-10");
  assert.deepEqual(db.estado.saldo, { de: "2025-10-01", ateExcl: "2026-10-01" }); // janela meio-aberta dos 12 meses
  const set = data[11];
  // Exemplo do card: salário 40.000 + 1.000 de outras receitas − 38.000 de despesa
  assert.deepEqual(set, { mes: "2026-09", receita_cents: 4100000, despesa_cents: 3800000, saldo_cents: 300000, estimado: false });
  // mês sem transação e sem salário em dólar (antes do parâmetro) vem zerado, não some
  assert.deepEqual(data[0], { mes: "2025-10", receita_cents: 0, despesa_cents: 0, saldo_cents: 0, estimado: false });
  // mês coberto só por estimativa carrega o selo
  assert.equal(data[7].mes, "2026-05");
  assert.equal(data[7].estimado, true);
});

test("G1 /api/saldo-mensal sem ate válido usa o mês corrente", async () => {
  const db = dbResumoFake();
  const req = new Request("http://localhost/api/saldo-mensal", { headers: G1_COOK });
  const data = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.equal(data[11].mes, new Date().toISOString().slice(0, 7));
});

test("G1 GET /api/salario lista os parâmetros; PUT grava {vigente_desde, usd_cents} no dia 01", async () => {
  const gravados = [];
  const db = { salarioParams: async () => [{ vigente_desde: "2026-01-01", usd_cents: 800000 }], setSalarioParam: async (d, u) => gravados.push([d, u]) };
  const get = new Request("http://localhost/api/salario", { headers: G1_COOK });
  assert.deepEqual(await (await handleApi(get, G1_ENV, new URL(get.url), db)).json(), [{ vigente_desde: "2026-01-01", usd_cents: 800000 }]);
  const put = new Request("http://localhost/api/salario", { method: "PUT", headers: { ...G1_COOK, "content-type": "application/json" }, body: JSON.stringify({ vigente_desde: "2026-03", usd_cents: 850000 }) });
  const r = await handleApi(put, G1_ENV, new URL(put.url), db);
  assert.equal(r.status, 200);
  assert.deepEqual(gravados, [["2026-03-01", 850000]]);
});

test("G1 PUT /api/salario recusa mês inválido ou usd_cents não inteiro (nada chega ao banco)", async () => {
  const gravados = [];
  const db = { setSalarioParam: async (d, u) => gravados.push([d, u]) };
  for (const body of [{ vigente_desde: "x", usd_cents: 1 }, { vigente_desde: "2026-03", usd_cents: 12.5 }, { vigente_desde: "2026-03", usd_cents: -1 }]) {
    const put = new Request("http://localhost/api/salario", { method: "PUT", headers: { ...G1_COOK, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await handleApi(put, G1_ENV, new URL(put.url), db)).status, 400);
  }
  assert.equal(gravados.length, 0);
});

const CSV_G1 = [
  '"TransferWise ID",Date,"Date Time",Amount,Currency,Description,"Payment Reference","Running Balance","Exchange From","Exchange To","Exchange Rate","Payer Name","Payee Name","Payee Account Number",Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,"Total fees","Exchange To Amount","Transaction Type","Transaction Details Type"',
  'BALANCE-111,04-08-2026,"04-08-2026 09:00:00.000",8000.00,USD,"Received money",,8000.00,,,,"Empresa Exemplo",,,,,,,,0.00,,CREDIT,DEPOSIT',
  'BALANCE-222,04-08-2026,"04-08-2026 10:00:00.000",-8000.00,USD,"Converted USD to BRL",,0.00,USD,BRL,5.00000,,,,,,,,,12.34,40000.00,DEBIT,CONVERSION',
  'BALANCE-333,14-08-2026,"14-08-2026 10:00:00.000",-5000.00,USD,"Converted USD to BRL",,0.00,USD,BRL,5.20000,,,,,,,,,8.00,26000.00,DEBIT,CONVERSION',
].join("\n");

test("G1 POST /api/importar/preview tipo wise: conversões novas × já importadas (por linha_hash)", async () => {
  const { hashWise } = await import("./wise.js");
  const db = { catalogo: async () => ({ categorias: [], subcategorias: [] }), associacoesPorNome: async () => ({}), conversoesHashes: async () => [hashWise("BALANCE-222")] };
  const req = new Request("http://localhost/api/importar/preview", { method: "POST", headers: { ...G1_COOK, "content-type": "application/json" }, body: JSON.stringify({ tipo: "wise", texto: CSV_G1 }) });
  const data = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.equal(data.resumo.novos, 1);
  assert.equal(data.resumo.jaTem, 1);
  assert.equal(data.resumo.ignoradas, 1);
  assert.equal(data.checksum.bloqueiaAplicar, false);
  assert.deepEqual(data.itens.map((i) => i.status), ["jaTem", "novo"]);
  assert.equal(data.itens[1].usd_cents, 500000);
});

test("G1 POST /api/importar/aplicar tipo wise grava as conversões (origem wise) e devolve a contagem", async () => {
  const gravadas = [];
  const db = { inserirConversoes: async (l) => { gravadas.push(...l); return { gravados: l.length }; }, registrarImportacao: async () => {} };
  const conversoes = [{ data: "2026-08-14", usd_cents: 500000, brl_cents: 2600000, taxa: 5.2, linhaHash: "h" }];
  const req = new Request("http://localhost/api/importar/aplicar", { method: "POST", headers: { ...G1_COOK, "content-type": "application/json" }, body: JSON.stringify({ tipo: "wise", conversoes }) });
  const data = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.equal(data.gravados, 1);
  assert.equal(gravadas[0].origem, "wise");
  assert.equal(gravadas[0].linhaHash, "h");
});

// ---------- G2: fechamento do mês ----------
test("G2 POST /api/importar/aplicar grava em importacoes o período do arquivo nos quatro tipos", async () => {
  const casos = [
    // extrato do Itaú: a conta é sempre 'itau' (a fonte "Itaú" do fechamento lê conta='itau')
    [{ tipo: "extrato", decisao: { novos: [], naoGasto: [], casados: [] }, cobertura: { de: "2031-07-01", ate: "2031-07-31" } },
      { conta: "itau", tipo: "extrato", de: "2031-07-01", ate: "2031-07-31" }],
    [{ tipo: "c6", decisao: { novos: [], naoGasto: [], casados: [] }, cobertura: { de: "2031-09-09", ate: "2031-09-28" } },
      { conta: "c6", tipo: "extrato", de: "2031-09-09", ate: "2031-09-28" }],
    // fatura sem total impresso: grava do mesmo jeito (o mês do vencimento, dia 01 ao último dia)
    [{ tipo: "fatura", decisao: { novos: [], naoGasto: [], casados: [] }, fatura: { totalCents: 0, ano: 2031, mes: 2 } },
      { conta: "itau", tipo: "fatura", de: "2031-02-01", ate: "2031-02-28" }],
    [{ tipo: "wise", conversoes: [{ data: "2031-08-14", usd_cents: 100, brl_cents: 500, linhaHash: "h" }], cobertura: { de: "2031-08-04", ate: "2031-08-14" } },
      { conta: "wise", tipo: "wise", de: "2031-08-04", ate: "2031-08-14" }],
  ];
  for (const [corpo, esperado] of casos) {
    const db = { ...dbImportarFake(), inserirConversoes: async (l) => ({ gravados: l.length }), marcarRepassesEntreContas: async () => ({ marcados: 0, avisos: [] }) };
    const req = reqApi("/api/importar/aplicar", "POST", corpo);
    const r = await handleApi(req, envApi, new URL(req.url), db);
    assert.equal(r.status, 200, corpo.tipo);
    assert.deepEqual(db.estado.importacoes, [esperado], corpo.tipo);
  }
});

test("G2 aplicar wise sem cobertura no corpo: o período sai da primeira e da última conversão enviada", async () => {
  const db = { ...dbImportarFake(), inserirConversoes: async (l) => ({ gravados: l.length }) };
  const conversoes = [{ data: "2031-08-14", usd_cents: 1, brl_cents: 5, linhaHash: "a" }, { data: "2031-08-04", usd_cents: 1, brl_cents: 5, linhaHash: "b" }];
  const req = reqApi("/api/importar/aplicar", "POST", { tipo: "wise", conversoes });
  await handleApi(req, envApi, new URL(req.url), db);
  assert.deepEqual(db.estado.importacoes, [{ conta: "wise", tipo: "wise", de: "2031-08-04", ate: "2031-08-14" }]);
});

test("G2 aplicar de extrato sem cobertura válida não inventa período (nada em importacoes)", async () => {
  for (const cobertura of [undefined, null, { de: "x", ate: "2031-13-40" }]) {
    const db = { ...dbImportarFake(), marcarRepassesEntreContas: async () => ({ marcados: 0, avisos: [] }) };
    const req = reqApi("/api/importar/aplicar", "POST", { tipo: "extrato", decisao: { novos: [], naoGasto: [], casados: [] }, cobertura });
    assert.equal((await handleApi(req, envApi, new URL(req.url), db)).status, 200);
    assert.equal(db.estado.importacoes, undefined);
  }
});

function dbFechamentoFake() {
  const estado = {};
  return {
    estado,
    coberturaImportacoes: async () => [
      { conta: "itau", tipo: "extrato", ate: "2024-09-30" },
      { conta: "c6", tipo: "extrato", ate: "2024-09-28" },
    ],
    faturasImportadas: async (de, ateExcl) => { estado.faturas = { de, ateExcl }; return ["2024-08", "2024-09"]; },
    semCategoriaPorMes: async (de, ateExcl) => { estado.semCat = { de, ateExcl }; return [{ mes: "2024-09", n: 3 }, { mes: "2024-08", n: 6 }]; },
    salarioParams: async () => [{ vigente_desde: "2024-01-01", usd_cents: 100 }],
    conversoes: async () => [{ data: "2024-08-20", usd_cents: 100, brl_cents: 500, origem: "wise" }],
    // G6: as rotinas que não são import
    printsPorMes: async () => [
      { mes: "2024-01", conta: "itau", pessoa: "Bia" }, { mes: "2024-09", conta: "c6", pessoa: "Ana" },
    ],
    diagnosticosNaJanela: async (de, ate) => { estado.diag = { de, ate }; return ["2024-08"]; },
    transacoesPorMes: async (de, ateExcl) => { estado.trans = { de, ateExcl }; return [{ mes: "2024-09", n: 30 }]; },
  };
}

test("G6 GET /api/fechamento traz, por mês, patrimonio por conta, diagnostico, contagem de transações e o brl do salário", async () => {
  const db = dbFechamentoFake();
  const req = reqApi("/api/fechamento?ate=2024-10", "GET");
  const data = await (await handleApi(req, envApi, new URL(req.url), db)).json();
  assert.equal(data.primeiro_print, "2024-01");
  assert.deepEqual(db.estado.diag, { de: "2023-11", ate: "2024-10" });
  assert.deepEqual(db.estado.trans, { de: "2023-11-01", ateExcl: "2024-11-01" });
  const ago = data.meses[9], set = data.meses[10];
  assert.deepEqual(set.patrimonio, [{ conta: "itau", pessoa: "Bia", tem_print: false }, { conta: "c6", pessoa: "Ana", tem_print: true }]);
  assert.equal(ago.diagnostico, true);
  assert.equal(set.diagnostico, false);
  assert.equal(set.transacoes, 30);
  assert.equal(ago.transacoes, 0);
  assert.equal(ago.salario_brl_cents, 500);
  // o estado do mês não muda por causa das rotinas novas
  assert.equal(ago.estado, "fechado");
});

// datas no passado: a rota usa o relógio para o mês corrente, e um mês futuro nunca fecha
test("G2 GET /api/fechamento?ate= devolve 12 meses terminando em ate, com estado e fontes por mês", async () => {
  const db = dbFechamentoFake();
  const req = reqApi("/api/fechamento?ate=2024-10", "GET");
  const data = await (await handleApi(req, envApi, new URL(req.url), db)).json();
  assert.equal(data.meses.length, 12);
  assert.equal(data.meses[0].mes, "2023-11");
  assert.equal(data.meses[11].mes, "2024-10");
  assert.deepEqual(db.estado.semCat, { de: "2023-11-01", ateExcl: "2024-11-01" });
  assert.deepEqual(db.estado.faturas, { de: "2023-11-01", ateExcl: "2024-11-01" });
  const ago = data.meses[9], set = data.meses[10], out = data.meses[11];
  assert.equal(ago.estado, "fechado");
  assert.equal(ago.sem_categoria, 6);
  assert.equal(set.estado, "parcial");
  assert.deepEqual(set.fontes.c6, { ate: "2024-09-28", cobertura: "parcial" });
  assert.equal(set.sem_categoria, 3);
  assert.equal(out.estado, "faltando");
  assert.deepEqual(out.fontes.fatura, { existe: false, cobertura: "faltando" });
  // salário: até a última conversão (de qualquer origem); setembro já é estimado
  assert.deepEqual(set.fontes.salario, { ate: "2024-08-20", estimado: true });
  assert.equal(ago.fontes.salario.estimado, false);
});

test("G2 GET /api/fechamento com ate inválido ou ausente → 400, sem ler o banco", async () => {
  for (const q of ["", "?ate=2024-13", "?ate=x", "?ate=2024-1"]) {
    const req = reqApi(`/api/fechamento${q}`, "GET");
    assert.equal((await handleApi(req, envApi, new URL(req.url), {})).status, 400, q);
  }
});

// ---------- G3: diagnóstico mensal ----------
// o texto é livre (markdown escrito pelo assistente); o Worker só guarda e devolve por mês
function dbDiagnosticoFake(linhas = {}) {
  const estado = { lidos: [], gravados: [] };
  return {
    estado,
    diagnosticoDoMes: async (mes) => { estado.lidos.push(mes); return linhas[mes] || null; },
    gravarDiagnostico: async (mes, texto) => { estado.gravados.push({ mes, texto }); },
  };
}

test("G3 GET /api/diagnostico?mes= devolve {mes, texto, atualizado_em} quando o mês tem diagnóstico", async () => {
  const db = dbDiagnosticoFake({ "2026-09": { mes: "2026-09", texto: "## 1. Fechou no azul?\nSim.", atualizado_em: "2026-10-01T12:00:00Z" } });
  const req = reqApi("/api/diagnostico?mes=2026-09", "GET");
  const r = await handleApi(req, envApi, new URL(req.url), db);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { mes: "2026-09", texto: "## 1. Fechou no azul?\nSim.", atualizado_em: "2026-10-01T12:00:00Z" });
  assert.deepEqual(db.estado.lidos, ["2026-09"]);
});

test("G3 GET /api/diagnostico sem diagnóstico no mês → 200 com texto null (não 404: a aba mostra o vazio)", async () => {
  const db = dbDiagnosticoFake();
  const req = reqApi("/api/diagnostico?mes=2026-10", "GET");
  const r = await handleApi(req, envApi, new URL(req.url), db);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { mes: "2026-10", texto: null });
});

test("G3 PUT /api/diagnostico grava o texto do mês (upsert) e devolve ok", async () => {
  const db = dbDiagnosticoFake();
  const req = reqApi("/api/diagnostico", "PUT", { mes: "2026-09", texto: "## 1. Fechou no azul?" });
  const r = await handleApi(req, envApi, new URL(req.url), db);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(db.estado.gravados, [{ mes: "2026-09", texto: "## 1. Fechou no azul?" }]);
});

test("G3 mes inválido ou ausente → 400 legível, sem ler nem gravar o banco", async () => {
  const db = dbDiagnosticoFake();
  for (const q of ["", "?mes=", "?mes=2026-13", "?mes=2026-9", "?mes=x"]) {
    const req = reqApi(`/api/diagnostico${q}`, "GET");
    const r = await handleApi(req, envApi, new URL(req.url), db);
    assert.equal(r.status, 400, q);
    assert.match((await r.json()).erro, /mes inválido/);
  }
  for (const mes of [undefined, "", "2026-13", "2026-9"]) {
    const req = reqApi("/api/diagnostico", "PUT", { mes, texto: "x" });
    assert.equal((await handleApi(req, envApi, new URL(req.url), db)).status, 400, String(mes));
  }
  // texto vazio ou não-string: a coluna é not null e um diagnóstico em branco não diz nada
  for (const texto of [undefined, "", "   ", 42]) {
    const req = reqApi("/api/diagnostico", "PUT", { mes: "2026-09", texto });
    assert.equal((await handleApi(req, envApi, new URL(req.url), db)).status, 400, String(texto));
  }
  assert.deepEqual(db.estado.lidos, []);
  assert.deepEqual(db.estado.gravados, []);
});

test("G3 /api/diagnostico sem token → 401, sem ler nem gravar", async () => {
  const db = dbDiagnosticoFake({ "2026-09": { mes: "2026-09", texto: "segredo", atualizado_em: "x" } });
  const get = new Request("http://localhost/api/diagnostico?mes=2026-09");
  assert.equal((await handleApi(get, envApi, new URL(get.url), db)).status, 401);
  const put = new Request("http://localhost/api/diagnostico", { method: "PUT", body: JSON.stringify({ mes: "2026-09", texto: "x" }) });
  assert.equal((await handleApi(put, envApi, new URL(put.url), db)).status, 401);
  assert.deepEqual(db.estado.lidos, []);
  assert.deepEqual(db.estado.gravados, []);
});

// ---------- A2: patrimônio por print ----------
// Tudo inventado: valores, nomes de produto. Deps injetados como na captura de comprovante.
function depsPatrimonio({ leitura, jaTem = null, pessoas = { caio: { id: "pCaio", nome: "Caio" }, paola: { id: "pPaola", nome: "Paola" } } } = {}) {
  const estado = { hashes: [], extracoes: [], subidos: [], docs: [], patrimonio: [], respostas: [], transacoes: [] };
  const db = {
    catalogo: async () => ({ categorias: [{ id: "cNI", nome: "Não Identificado", natureza: "despesa", padrao: true }], subcategorias: [] }),
    documentoPorHash: async (h) => { estado.hashes.push(h); return jaTem; },
    pessoaPorNome: async (nome) => pessoas[String(nome).toLowerCase()] || null,
    inserirDocumento: async (d) => { estado.docs.push(d); return { id: "doc1" }; },
    inserirPatrimonio: async (lista) => { estado.patrimonio.push(...lista); return { gravados: lista.length }; },
    inserirTransacao: async (t) => { estado.transacoes.push(t); return { id: "tx1" }; },
  };
  return {
    estado,
    deps: {
      db,
      baixar: async () => ({ bytes: new Uint8Array([9, 9]), mime: "image/jpeg" }),
      hashBytes: async () => "hP",
      extrairImpl: async (b, m, c, modo) => { estado.extracoes.push(modo); return leitura; },
      subir: async (env, caminho) => { estado.subidos.push(caminho); return caminho; },
      confirmar: async () => { throw new Error("patrimônio não usa o botão de apagar transação"); },
      responderImpl: async (chat, texto) => estado.respostas.push(texto),
    },
  };
}
const leituraItau = (mud = {}) => ({ ok: true, extraido_por: "gemini", confianca: 0.9, normalizado: {
  dataISO: "2026-10-09", conta: "itau", pessoa: "Caio",
  produtos: [
    { produto: "Fundos", familia: "fundos", nivel: "agregado", saldo_cents: 50000000, vencimento: null, taxa: null, rendimento_print_cents: 5000000, periodo_rendimento: "ano" },
    { produto: "CDB, Renda Fixa", familia: "renda_fixa", nivel: "agregado", saldo_cents: 25000000, vencimento: null, taxa: null, rendimento_print_cents: null, periodo_rendimento: null },
    { produto: "Cofrinhos", familia: "caixa", nivel: "agregado", saldo_cents: 2000000, vencimento: null, taxa: null, rendimento_print_cents: null, periodo_rendimento: null },
  ], ...mud } });
const fotoPat = (caption) => ({ message: { chat: { id: 7 }, message_id: 1, date: Date.UTC(2026, 9, 11, 15) / 1000, caption, photo: [{ file_id: "fP", width: 800 }] } });

test("A2: foto com /patrimonio passa pelo dedup (documentoPorHash) e extrai no modo patrimonio", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau() });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.deepEqual(estado.hashes, ["hP"]);
  assert.deepEqual(estado.extracoes, ["patrimonio"]);
  assert.equal(estado.patrimonio.length, 3);
  assert.equal(estado.transacoes.length, 0); // não vira transação
  const p = estado.patrimonio[0];
  assert.equal(p.conta, "itau");
  assert.equal(p.pessoa_id, "pCaio");
  assert.equal(p.data, "2026-10-09");
  assert.equal(p.documento_id, "doc1");
  assert.equal(estado.docs[0].hash, "hP");
});

test("A2: print repetido (hash conhecido) recebe a resposta de duplicado e não grava nem extrai", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau(), jaTem: { id: "docVelho" } });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.deepEqual(estado.extracoes, []);
  assert.equal(estado.patrimonio.length, 0);
  assert.equal(estado.subidos.length, 0);
  assert.ok(estado.respostas.some((t) => /já registrei/i.test(t)));
});

test("A2: conta e pessoa vêm do que o modelo leu; a confirmação traz o total e o número de produtos", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau() });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.deepEqual(estado.subidos, ["/Finanças/Patrimônio/2026/2026-10-09_itau_caio.jpg"]);
  const r = estado.respostas.at(-1);
  assert.match(r, /770\.000,00/); // 500k + 250k + 20k
  assert.match(r, /3 produtos/);
  assert.match(r, /itau/);
  assert.match(r, /Caio/);
});

test("A2: a legenda /patrimonio paola c6 vence o que o modelo leu", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau() });
  await tratarUpdate(fotoPat("/patrimonio paola c6"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.ok(estado.patrimonio.every((p) => p.conta === "c6" && p.pessoa_id === "pPaola"));
  assert.deepEqual(estado.subidos, ["/Finanças/Patrimônio/2026/2026-10-09_c6_paola.jpg"]);
});

test("A2: sem data no print, vale a data da mensagem", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau({ dataISO: null }) });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(estado.patrimonio[0].data, "2026-10-11");
  assert.deepEqual(estado.subidos, ["/Finanças/Patrimônio/2026/2026-10-11_itau_caio.jpg"]);
});

test("A2: sem conta nem na leitura nem na legenda, pede a legenda e não grava", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau({ conta: null }) });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(estado.patrimonio.length, 0);
  assert.equal(estado.subidos.length, 0);
  assert.match(estado.respostas.at(-1), /\/patrimonio <pessoa>/);
});

test("A2: leitura inválida do modelo responde sem gravar", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: { ok: false, erros: ["gemini: família inválida"] } });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(estado.patrimonio.length, 0);
  assert.match(estado.respostas.at(-1), /Não consegui ler/);
});

test("A2: foto sem a legenda segue o fluxo do comprovante (modo padrão)", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: { ok: true, extraido_por: "gemini", confianca: 0.9,
    normalizado: { dataISO: "2026-10-09", valorCents: 1000, natureza: "despesa", macro: null, sub: null, descricao: "x" } } });
  deps.db.buscarAssociacao = async () => null;
  deps.confirmar = async () => {};
  await tratarUpdate(fotoPat(undefined), { TELEGRAM_TOKEN: "t" }, deps);
  assert.deepEqual(estado.extracoes, [undefined]);
  assert.equal(estado.transacoes.length, 1);
  assert.equal(estado.patrimonio.length, 0);
});

// ---------- A4 ----------
// a mensagem de fotoPat é de 11/10/2026 (Brasília)
test("A4: data do print a 61 dias da mensagem é descartada; grava com a da mensagem e avisa", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau({ dataISO: "2026-08-11" }) });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.ok(estado.patrimonio.every((p) => p.data === "2026-10-11"));
  assert.deepEqual(estado.subidos, ["/Finanças/Patrimônio/2026/2026-10-11_itau_caio.jpg"]);
  assert.match(estado.respostas.at(-1), /data do print ignorada, usei 11\/10/);
});

test("A4: data do print a 59 dias da mensagem vale, sem aviso", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau({ dataISO: "2026-08-13" }) });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.ok(estado.patrimonio.every((p) => p.data === "2026-08-13"));
  assert.doesNotMatch(estado.respostas.at(-1), /ignorada/);
});

test("A4: print do Itaú sem pessoa e sem legenda grava como Caio (mapa fixo por conta)", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau({ pessoa: null }) });
  const pedidas = [];
  const orig = deps.db.pessoaPorNome;
  deps.db.pessoaPorNome = async (n) => { pedidas.push(n); return orig(n); };
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.deepEqual(pedidas, ["Caio"]);
  assert.equal(estado.patrimonio.length, 3);
  assert.ok(estado.patrimonio.every((p) => p.pessoa_id === "pCaio"));
});

test("A4: a legenda vence o mapa — /patrimonio paola itau grava Paola", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau({ pessoa: null }) });
  await tratarUpdate(fotoPat("/patrimonio paola itau"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(estado.patrimonio.length, 3);
  assert.ok(estado.patrimonio.every((p) => p.conta === "itau" && p.pessoa_id === "pPaola"));
});

test("A4: a pessoa lida no print vence o mapa (um c6 do Caio não vira da Paola)", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau({ conta: "c6", pessoa: "Caio" }) });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(estado.patrimonio.length, 3);
  assert.ok(estado.patrimonio.every((p) => p.conta === "c6" && p.pessoa_id === "pCaio"));
});

test("A4: print-resumo não grava nada (nem Dropbox, nem documento, nem patrimônio) e pede o print com os produtos", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau({ resumo: true, produtos: [] }) });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(estado.subidos.length, 0);
  assert.equal(estado.docs.length, 0);
  assert.equal(estado.patrimonio.length, 0);
  assert.deepEqual(estado.respostas, ["Esse é o resumo da carteira; manda o print com os produtos."]);
});

test("A4: print do app da Caixa → conta fgts, pessoa Caio pelo mapa, família fgts", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau({ conta: "fgts", pessoa: null, dataISO: "2026-10-10",
    produtos: [{ produto: "Saldo FGTS", familia: "fgts", nivel: "agregado", saldo_cents: 300000, vencimento: null, taxa: null, rendimento_print_cents: null, periodo_rendimento: null }] }) });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.deepEqual(estado.patrimonio.map((p) => [p.conta, p.pessoa_id, p.familia]), [["fgts", "pCaio", "fgts"]]);
});

test("A4: sem conta, a resposta lista o fgts entre as contas da legenda", async () => {
  const { deps, estado } = depsPatrimonio({ leitura: leituraItau({ conta: null }) });
  await tratarUpdate(fotoPat("/patrimonio"), { TELEGRAM_TOKEN: "t" }, deps);
  assert.match(estado.respostas.at(-1), /fgts/);
});

function dbPatrimonioFake() {
  const estado = {};
  return {
    estado,
    patrimonioPorDia: async (de, ateExcl) => { estado.janela = { de, ateExcl }; return [
      { mes: "2026-10", data: "2026-10-09", conta: "itau", pessoa: "Caio", familia: "fundos", nivel: "agregado", saldo_cents: 77000000, rend_mes_cents: null, n_rend_mes: 0 },
      { mes: "2026-10", data: "2026-10-09", conta: "c6", pessoa: "Paola", familia: "renda_fixa", nivel: "agregado", saldo_cents: 20000000, rend_mes_cents: null, n_rend_mes: 0 },
    ]; },
    aportesInvestimentoPorMes: async (de, ateExcl) => { estado.aportes = { de, ateExcl }; return []; },
    periodosImportacao: async (conta, tipo) => { estado.periodos = { conta, tipo }; return [{ de: "2025-07-01", ate: "2026-09-02" }]; },
  };
}

test("A2 GET /api/patrimonio?ate= devolve 12 meses com a foto por conta, total por pessoa e da família, e o rendimento com a origem", async () => {
  const db = dbPatrimonioFake();
  const req = reqApi("/api/patrimonio?ate=2026-10", "GET");
  const data = await (await handleApi(req, envApi, new URL(req.url), db)).json();
  assert.equal(data.meses.length, 12);
  assert.equal(data.meses[0].mes, "2025-11");
  assert.equal(data.meses[11].mes, "2026-10");
  // a janela começa um mês antes: o rendimento do 1º mês precisa da foto do anterior
  assert.deepEqual(db.estado.janela, { de: "2025-10-01", ateExcl: "2026-11-01" });
  assert.deepEqual(db.estado.periodos, { conta: "itau", tipo: "extrato" });
  const out = data.meses[11];
  assert.equal(out.total_cents, 97000000);
  assert.deepEqual(out.porPessoa.map((p) => [p.pessoa, p.total_cents]).sort(), [["Caio", 77000000], ["Paola", 20000000]]);
  const itau = out.porConta.find((c) => c.conta === "itau");
  assert.equal(itau.rendimento_cents, null);
  assert.equal(itau.origem, "sem");
  assert.equal(itau.motivo, "extrato pendente");
});

test("A2 GET /api/patrimonio com ate inválido ou ausente → 400, sem ler o banco", async () => {
  for (const q of ["", "?ate=2026-13", "?ate=x"]) {
    const req = reqApi(`/api/patrimonio${q}`, "GET");
    assert.equal((await handleApi(req, envApi, new URL(req.url), {})).status, 400, q);
  }
});

// ---------- G4: Projeto Casa ----------
// Números inventados (repositório público). O fake grava o que o handler pediu ao banco.
function dbCasaFake({ params = [], linhas = [] } = {}) {
  const estado = { gravados: [], janelas: {} };
  return {
    estado,
    casaParams: async () => params,
    setCasaParam: async (p) => { estado.gravados.push(p); },
    patrimonioPorDia: async (de, ateExcl) => { estado.janelas.patrimonio = { de, ateExcl }; return linhas; },
    aportesInvestimentoPorMes: async () => [],
    periodosImportacao: async () => [],
    coberturaImportacoes: async () => [{ conta: "itau", tipo: "extrato", ate: "2026-09-30" }, { conta: "c6", tipo: "extrato", ate: "2026-09-30" }],
    faturasImportadas: async () => ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"],
    semCategoriaPorMes: async () => [],
    salarioParams: async () => [],
    conversoes: async () => [],
    saldoPorMes: async (de, ateExcl) => {
      estado.janelas.saldo = { de, ateExcl };
      const out = [];
      for (let m = 1; m <= 9; m++) out.push({ mes: `2026-0${m}`, receita_cents: 1000000, despesa_cents: m === 8 ? 900000 : 800000 });
      return out;
    },
    despesaProjetoCasaPorMes: async (de, ateExcl) => { estado.janelas.casa = { de, ateExcl }; return [{ mes: "2026-08", despesa_cents: 100000 }]; },
    jaGastoProjetoCasa: async () => 2000000,
  };
}
const putCasa = (corpo) => new Request("http://localhost/api/casa/param", {
  method: "PUT", headers: { "Cookie": "token=token123", "content-type": "application/json" },
  body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
});

test("G4 /api/casa e /api/casa/param sem token → 401, sem tocar no banco", async () => {
  for (const [path, method] of [["/api/casa?ate=2026-09", "GET"], ["/api/casa/param", "GET"], ["/api/casa/param", "PUT"]]) {
    const req = new Request(`http://localhost${path}`, { method, body: method === "PUT" ? "{}" : undefined });
    assert.equal((await handleApi(req, envApi, new URL(req.url), {})).status, 401, `${method} ${path}`);
  }
});

test("G4 PUT /api/casa/param: cada valor inválido volta 400 com mensagem legível e nada chega ao banco", async () => {
  const db = dbCasaFake();
  const ok = { vigente_desde: "2026-10", custo_total_cents: 100000000, reserva_cents: 30000000, data_alvo: null };
  const casos = [
    [{ ...ok, vigente_desde: "outubro" }, /vigente_desde/],
    [{ ...ok, vigente_desde: "2026-13" }, /vigente_desde/],
    [{ ...ok, vigente_desde: "2026-02-30" }, /vigente_desde/],
    [{ ...ok, custo_total_cents: 0 }, /custo_total_cents/],
    [{ ...ok, custo_total_cents: 1000.5 }, /custo_total_cents/],
    [{ ...ok, custo_total_cents: "1000" }, /custo_total_cents/],
    [{ ...ok, reserva_cents: -1 }, /reserva_cents/],
    [{ ...ok, reserva_cents: 1.5 }, /reserva_cents/],
    [{ ...ok, data_alvo: "2029-13-01" }, /data_alvo/],
    [{ ...ok, data_alvo: "amanhã" }, /data_alvo/],
    ["não é json", /corpo/],
  ];
  for (const [corpo, msg] of casos) {
    const r = await handleApi(putCasa(corpo), envApi, new URL("http://localhost/api/casa/param"), db);
    assert.equal(r.status, 400, JSON.stringify(corpo));
    assert.match((await r.json()).erro, msg);
  }
  assert.equal(db.estado.gravados.length, 0);
});

test("G4 PUT /api/casa/param grava o parâmetro (vigente no dia 01); GET devolve o vigente, ou null sem nenhum", async () => {
  const db = dbCasaFake();
  const r = await handleApi(putCasa({ vigente_desde: "2026-10-12", custo_total_cents: 100000000, reserva_cents: 30000000, data_alvo: "2029-10-01" }), envApi, new URL("http://localhost/api/casa/param"), db);
  assert.equal(r.status, 200);
  assert.deepEqual(db.estado.gravados, [{ vigente_desde: "2026-10-01", custo_total_cents: 100000000, reserva_cents: 30000000, data_alvo: "2029-10-01" }]);

  const vazio = reqApi("/api/casa/param", "GET");
  assert.equal(await (await handleApi(vazio, envApi, new URL(vazio.url), dbCasaFake())).json(), null);

  const params = [{ vigente_desde: "2026-01-01", custo_total_cents: 1, reserva_cents: 0, data_alvo: null },
    { vigente_desde: "2026-08-01", custo_total_cents: 2, reserva_cents: 0, data_alvo: null }];
  const get = reqApi("/api/casa/param?mes=2026-09", "GET");
  assert.equal((await (await handleApi(get, envApi, new URL(get.url), dbCasaFake({ params }))).json()).custo_total_cents, 2);
  const ruim = reqApi("/api/casa/param?mes=2026-9", "GET");
  assert.equal((await handleApi(ruim, envApi, new URL(ruim.url), dbCasaFake({ params }))).status, 400);
});

test("G4 GET /api/casa com ate inválido ou ausente → 400, sem ler o banco", async () => {
  for (const q of ["", "?ate=2026-13", "?ate=2026-9", "?ate=x"]) {
    const req = reqApi(`/api/casa${q}`, "GET");
    assert.equal((await handleApi(req, envApi, new URL(req.url), {})).status, 400, q);
  }
});

test("G4 GET /api/casa?ate= junta patrimônio (todo o histórico), saldo do G1, fechamento e a obra pela flag", async () => {
  const linhas = [{ mes: "2025-03", data: "2025-03-05", conta: "c6", pessoa: "Caio", familia: "caixa", nivel: "agregado", saldo_cents: 90000000, rend_mes_cents: null, n_rend_mes: 0 }];
  const params = [{ vigente_desde: "2026-01-01", custo_total_cents: 100000000, reserva_cents: 30000000, data_alvo: null }];
  const db = dbCasaFake({ params, linhas });
  const req = reqApi("/api/casa?ate=2026-09", "GET");
  const r = await handleApi(req, envApi, new URL(req.url), db);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.meses.length, 12);
  assert.equal(data.meses[0].mes, "2025-10");
  // a foto de março/2025 (antes dos 12 meses) é carregada: o patrimônio lê desde o começo
  assert.equal(db.estado.janelas.patrimonio.ateExcl, "2026-10-01");
  assert.ok(db.estado.janelas.patrimonio.de <= "2025-03-01");
  assert.deepEqual(db.estado.janelas.casa, { de: "2025-10-01", ateExcl: "2026-10-01" });
  const set = data.meses[11];
  assert.equal(set.patrimonio_cents, 90000000);
  assert.equal(set.data_foto_mais_antiga, "2025-03-05");
  assert.equal(set.disponivel_cents, 60000000);
  assert.equal(set.falta_cents, 100000000 - 60000000 - 2000000);
  assert.equal(data.ja_gasto_cents, 2000000);
  // janela: 6 últimos fechados (2026-04..09 se o mês corrente for depois deles) — saldo 2.000 por mês;
  // agosto teve 1.000 de obra, somada de volta (saldo 1.000 + 1.000)
  if (new Date().toISOString().slice(0, 7) > "2026-09") {
    assert.deepEqual(data.janela_ritmo, ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    assert.equal(data.ritmo_cents, 200000);
    assert.equal(data.projecao_meses, Math.ceil(38000000 / 200000));
  }
});

// ---- H4: POST /api/importar/sugestoes (JEV no import) ----
// Tudo com fetch falso que conta as chamadas: o CI não tem rede nem chave, e o repositório é
// público (descrições inventadas). O fetch global é trocado só durante cada teste.
const CATALOGO_JEV = {
  categorias: [
    { id: "kA", nome: "Alimentação", natureza: "despesa", padrao: false, ativa: true },
    { id: "kC", nome: "Compras", natureza: "despesa", padrao: false, ativa: true },
    { id: "kN", nome: "Não Identificado", natureza: "despesa", padrao: true, ativa: true },
  ],
  subcategorias: [
    { id: "a1", categoria_id: "kA", nome: "Ifood", ativa: true },
    { id: "c1", categoria_id: "kC", nome: "Amazon", ativa: true },
    { id: "c2", categoria_id: "kC", nome: "Compras", ativa: true },
  ],
};
function dbJev({ associacoes = {} } = {}) {
  const f = {
    escritas: [],
    catalogo: async () => CATALOGO_JEV,
    associacoesPorNome: async () => associacoes,
    // qualquer escrita em associações aqui é bug: nenhuma regra nasce do JEV
    upsertAssociacao: async (...a) => { f.escritas.push(a); },
  };
  return f;
}
const envJev = { ...envApi, TYPESAFE_API_KEY: "chave-de-teste" };
const linhaJev = (indice, descricao, extra = {}) => ({
  indice, descricao, contraparte: null, valorCents: 4990, natureza: "despesa", status: "novo",
  categoriaNome: null, categoriaOrg: null, ...extra,
});
// responde por pergunta: porDescricao[descricao] = { categoria: [choice, prob], subcategoria: [...] }
function fetchJev(porDescricao, { status = null } = {}) {
  const f = { chamadas: [] };
  f.impl = async (url, init) => {
    const corpo = JSON.parse(init.body);
    f.chamadas.push({ url, init, corpo });
    if (status) return new Response("{}", { status });
    const [id] = Object.keys(corpo.questions);
    const [choice, prob] = porDescricao[corpo.state.descricao][id];
    return new Response(JSON.stringify({ answers: { [id]: { choice, probabilities: { [choice]: prob } } } }), { status: 200 });
  };
  return f;
}
async function comFetch(f, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = f.impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}
const postSug = (corpo) => reqApi("/api/importar/sugestoes", "POST", corpo);
const urlSug = new URL("http://localhost/api/importar/sugestoes");

test("H4: lote com mais de 20 linhas → 400, sem chamar o JEV", async () => {
  const f = fetchJev({});
  const itens = Array.from({ length: 21 }, (_, i) => linhaJev(i, `LOJA ${i}`));
  const r = await comFetch(f, () => handleApi(postSug({ fonte: "fatura", itens }), envJev, urlSug, dbJev()));
  assert.equal(r.status, 400);
  assert.equal(f.chamadas.length, 0);
});

test("H4: Exemplo do card — IFD* pela regra sem chamada, 0,96 preenche, 0,46 fica na padrão", async () => {
  const f = fetchJev({
    "LOJA EXEMPLO LTDA": { categoria: ["Compras", 0.96], subcategoria: ["Compras", 0.88] },
    "FULANO DE TAL": { categoria: ["Compras", 0.46] },
  });
  const db = dbJev();
  const itens = [linhaJev(0, "IFD*LANCHONETE EXEMPLO"), linhaJev(1, "LOJA EXEMPLO LTDA"), linhaJev(2, "FULANO DE TAL")];
  const r = await comFetch(f, () => handleApi(postSug({ fonte: "fatura", itens }), envJev, urlSug, db));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.indisponivel, false);
  const [ifd, loja, fulano] = d.itens;
  assert.deepEqual(ifd, { indice: 0, preenche: true,
    sugestao: { categoria: "Alimentação", subcategoria: "Ifood", prob_categoria: 1, prob_subcategoria: 1 } });
  assert.deepEqual(loja, { indice: 1, preenche: true,
    sugestao: { categoria: "Compras", subcategoria: "Compras", prob_categoria: 0.96, prob_subcategoria: 0.88 } });
  assert.equal(fulano.preenche, false);
  assert.equal(fulano.sugestao.prob_categoria, 0.46);
  // IFD*: nenhuma; LOJA: categoria + sub; FULANO: só categoria (abaixo do limiar a sub não é usada)
  assert.equal(f.chamadas.length, 3);
  assert.ok(f.chamadas.every((c) => !c.corpo.state.descricao.startsWith("IFD*")));
  assert.deepEqual(db.escritas, []);
});

test("H4: contrato HTTP — POST no systemone, Bearer com a chave, corpo {model, state, questions}", async () => {
  const f = fetchJev({ "FULANO DE TAL": { categoria: ["Compras", 0.2] } });
  await comFetch(f, () => handleApi(postSug({ fonte: "extrato", itens: [linhaJev(0, "FULANO DE TAL")] }), envJev, urlSug, dbJev()));
  const [c] = f.chamadas;
  assert.equal(c.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers.authorization, "Bearer chave-de-teste");
  assert.deepEqual(Object.keys(c.corpo).sort(), ["model", "questions", "state"]);
  assert.equal(c.corpo.model, "jev-latest");
  assert.equal(c.corpo.state.fonte, "movimento da conta corrente (linha do extrato bancário)");
  assert.equal(c.corpo.state.valor, "49,90");
});

test("H4: regra aprendida, fora da padrão, casada, repetida, ambígua e repasse não geram chamada", async () => {
  const f = fetchJev({ "LOJA SEM REGRA": { categoria: ["Compras", 0.5] } });
  const itens = [
    linhaJev(0, "LOJA COM REGRA", { categoriaNome: "Compras" }), // regra aprendida na prévia
    linhaJev(1, "PIX TRANSF CONTA PROPRIA", { status: "naoGasto", categoriaOrg: "Transferências" }), // repasse
    linhaJev(2, "TALVEZ CASE", { status: "ambiguo" }),
    linhaJev(3, "JA CASADA", { status: "casado" }),
    linhaJev(4, "JA IMPORTADA", { status: "jaTem" }),
    linhaJev(5, "LOJA ENSINADA DEPOIS"), // regra nova no banco, ensinada depois da prévia
    linhaJev(6, "LOJA SEM REGRA"), // só esta vai
  ];
  const db = dbJev({ associacoes: { "LOJA ENSINADA DEPOIS": { categoriaNome: "Compras", subNome: null } } });
  const r = await comFetch(f, () => handleApi(postSug({ fonte: "extrato", itens }), envJev, urlSug, db));
  const d = await r.json();
  assert.equal(f.chamadas.length, 1);
  assert.equal(f.chamadas[0].corpo.state.descricao, "LOJA SEM REGRA");
  assert.deepEqual(d.itens.slice(0, 6).map((i) => i.sugestao), [null, null, null, null, null, null]);
  assert.deepEqual(d.itens.map((i) => i.indice), [0, 1, 2, 3, 4, 5, 6]);
});

test("H4: 429 faz exatamente uma nova tentativa; na segunda falha a linha fica sem sugestão e vira aviso", async () => {
  const f = fetchJev({}, { status: 429 });
  const r = await comFetch(f, () => handleApi(postSug({ fonte: "fatura", itens: [linhaJev(0, "LOJA EXEMPLO LTDA")] }), envJev, urlSug, dbJev()));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(f.chamadas.length, 2);
  assert.equal(d.itens[0].sugestao, null);
  assert.equal(d.indisponivel, true);
  assert.equal(d.aviso, "classificação automática indisponível");
});

test("H4: 529 seguido de sucesso aproveita a segunda tentativa", async () => {
  const resposta = { answers: { categoria: { choice: "Compras", probabilities: { Compras: 0.3 } } } };
  const f = { chamadas: [] };
  f.impl = async (url, init) => {
    f.chamadas.push(init);
    return f.chamadas.length === 1 ? new Response("{}", { status: 529 }) : new Response(JSON.stringify(resposta), { status: 200 });
  };
  const r = await comFetch(f, () => handleApi(postSug({ fonte: "fatura", itens: [linhaJev(0, "LOJA X")] }), envJev, urlSug, dbJev()));
  const d = await r.json();
  assert.equal(f.chamadas.length, 2);
  assert.equal(d.itens[0].sugestao.prob_categoria, 0.3);
  assert.equal(d.indisponivel, false);
});

test("H4: sem TYPESAFE_API_KEY → 200, linhas sem sugestão e aviso, sem chamada (nem a do IFD*)", async () => {
  const f = fetchJev({});
  const itens = [linhaJev(0, "IFD*LANCHONETE EXEMPLO"), linhaJev(1, "LOJA EXEMPLO LTDA")];
  const r = await comFetch(f, () => handleApi(postSug({ fonte: "fatura", itens }), envApi, urlSug, dbJev()));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(f.chamadas.length, 0);
  assert.deepEqual(d.itens.map((i) => i.sugestao), [null, null]);
  assert.equal(d.indisponivel, true);
  assert.equal(d.aviso, "classificação automática indisponível");
});

test("H4: fetch lançando erro → 200, linha sem sugestão e aviso (nunca 500)", async () => {
  const f = { chamadas: [], impl: async () => { f.chamadas.push(1); throw new Error("rede caiu"); } };
  const r = await comFetch(f, () => handleApi(postSug({ fonte: "fatura", itens: [linhaJev(0, "LOJA X")] }), envJev, urlSug, dbJev()));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.itens[0].sugestao, null);
  assert.equal(d.indisponivel, true);
});

test("H4: resposta sem answers válidos → linha sem sugestão e aviso", async () => {
  const f = { chamadas: [], impl: async () => { f.chamadas.push(1); return new Response(JSON.stringify({ outra: 1 }), { status: 200 }); } };
  const r = await comFetch(f, () => handleApi(postSug({ fonte: "fatura", itens: [linhaJev(0, "LOJA X")] }), envJev, urlSug, dbJev()));
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(f.chamadas.length, 1);
  assert.equal(d.itens[0].sugestao, null);
  assert.equal(d.indisponivel, true);
});

test("H4: banco fora do ar na rota de sugestões → 200 com aviso, não 500", async () => {
  const db = dbJev();
  db.catalogo = async () => { throw new Error("banco caiu"); };
  const f = fetchJev({});
  const r = await comFetch(f, () => handleApi(postSug({ fonte: "fatura", itens: [linhaJev(0, "LOJA X")] }), envJev, urlSug, db));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).indisponivel, true);
});

test("H4: fonte fora de extrato/fatura → 400", async () => {
  const r = await handleApi(postSug({ fonte: "imagem", itens: [] }), envJev, urlSug, dbJev());
  assert.equal(r.status, 400);
});

// ---- C4: POST /api/importar/arquivo (arquivo original do import → Dropbox) ----
import { LIMITE_ARQUIVO_IMPORT } from "./index.js";

// Dropbox falso: token + upload; guarda cada upload (Dropbox-API-Arg e bytes) p/ conferir
function dropboxFalso() {
  const uploads = [];
  const fetchImpl = async (u, init) => {
    if (String(u).includes("oauth2/token")) return { ok: true, json: async () => ({ access_token: "tok" }) };
    uploads.push({ arg: JSON.parse(init.headers["Dropbox-API-Arg"]), body: init.body });
    return { ok: true, json: async () => ({ path_display: JSON.parse(init.headers["Dropbox-API-Arg"]).path }) };
  };
  return { fetchImpl, uploads };
}
const reqArquivo = (query, bytes, { token = "token123", headers = {} } = {}) => new Request(
  `http://localhost/api/importar/arquivo?${query}`,
  { method: "POST", headers: { ...(token ? { Cookie: `token=${token}` } : {}), "content-type": "application/octet-stream", ...headers }, body: bytes },
);
const chamarArquivo = (req, dbx) => handleApi(req, envApi, new URL(req.url), {}, { fetchImpl: dbx.fetchImpl });

test("C4: extrato Itaú sobe no caminho do período, com overwrite e sem autorename (reimportar substitui)", async () => {
  const dbx = dropboxFalso();
  const r = await chamarArquivo(reqArquivo("tipo=extrato&banco=itau&de=2026-09-03&ate=2026-10-13", new Uint8Array([1, 2, 3])), dbx);
  assert.equal(r.status, 200);
  assert.equal(dbx.uploads.length, 1);
  assert.deepEqual(dbx.uploads[0].arg, { path: "/Finanças/Extratos/itau/2026-09-03_a_2026-10-13_itau_extrato.pdf", mode: "overwrite" });
  assert.notEqual(dbx.uploads[0].arg.autorename, true);
  assert.equal((await r.json()).path, "/Finanças/Extratos/itau/2026-09-03_a_2026-10-13_itau_extrato.pdf");
});

test("C4: fatura sobe em Faturas/<banco> pelo mês do vencimento", async () => {
  const dbx = dropboxFalso();
  const r = await chamarArquivo(reqArquivo("tipo=fatura&banco=itau&mes=2026-10", new Uint8Array([9])), dbx);
  assert.equal(r.status, 200);
  assert.equal(dbx.uploads[0].arg.path, "/Finanças/Faturas/itau/2026-10_itau_fatura.pdf");
  assert.equal(dbx.uploads[0].arg.mode, "overwrite");
});

test("C4: o PDF do C6 chega ao Dropbox byte a byte como foi enviado (o Worker não abre nem decifra)", async () => {
  const dbx = dropboxFalso();
  // bytes arbitrários de mentira, inclusive os que um decodificador de texto estragaria
  const enviados = new Uint8Array(512).map((_, i) => (i * 37 + 11) % 256);
  const r = await chamarArquivo(reqArquivo("tipo=extrato&banco=c6&de=2026-08-01&ate=2026-08-31", enviados.slice()), dbx);
  assert.equal(r.status, 200);
  assert.equal(dbx.uploads[0].arg.path, "/Finanças/Extratos/c6/2026-08-01_a_2026-08-31_c6_extrato.pdf");
  assert.deepEqual([...new Uint8Array(dbx.uploads[0].body)], [...enviados]);
});

test("C4: o CSV da Wise sobe como extrato .csv", async () => {
  const dbx = dropboxFalso();
  const r = await chamarArquivo(reqArquivo("tipo=extrato&banco=wise&de=2026-07-01&ate=2026-09-30", new Uint8Array([65])), dbx);
  assert.equal(r.status, 200);
  assert.equal(dbx.uploads[0].arg.path, "/Finanças/Extratos/wise/2026-07-01_a_2026-09-30_wise_extrato.csv");
});

test("C4: sem token a rota devolve 401 e não sobe nada (mesma checagem das outras /api/*)", async () => {
  const dbx = dropboxFalso();
  const r = await chamarArquivo(reqArquivo("tipo=extrato&banco=itau&de=2026-09-03&ate=2026-10-13", new Uint8Array([1]), { token: null }), dbx);
  assert.equal(r.status, 401);
  assert.equal(dbx.uploads.length, 0);
});

test("C4: tipo ou banco fora do vocabulário → 400, sem chamar o Dropbox", async () => {
  for (const q of [
    "tipo=wise&banco=wise&de=2026-07-01&ate=2026-09-30",
    "tipo=comprovante&banco=itau&de=2026-09-03&ate=2026-10-13",
    "tipo=extrato&banco=nubank&de=2026-09-03&ate=2026-10-13",
    "banco=itau&de=2026-09-03&ate=2026-10-13",
  ]) {
    const dbx = dropboxFalso();
    const r = await chamarArquivo(reqArquivo(q, new Uint8Array([1])), dbx);
    assert.equal(r.status, 400, q);
    assert.equal(dbx.uploads.length, 0, q);
  }
});

test("C4: período inválido ou ausente para o tipo → 400, sem chamar o Dropbox", async () => {
  for (const q of [
    "tipo=extrato&banco=itau",
    "tipo=extrato&banco=itau&de=2026-09-03",
    "tipo=extrato&banco=itau&de=2026-10-13&ate=2026-09-03",
    "tipo=extrato&banco=itau&mes=2026-10",
    "tipo=fatura&banco=itau",
    "tipo=fatura&banco=itau&mes=2026-13",
    "tipo=fatura&banco=itau&de=2026-10-01&ate=2026-10-31",
  ]) {
    const dbx = dropboxFalso();
    const r = await chamarArquivo(reqArquivo(q, new Uint8Array([1])), dbx);
    assert.equal(r.status, 400, q);
    assert.equal(dbx.uploads.length, 0, q);
  }
});

test("C4: arquivo acima de 20 MB é recusado sem chamar o Dropbox", async () => {
  const dbx = dropboxFalso();
  const grande = new Uint8Array(LIMITE_ARQUIVO_IMPORT + 1);
  const r = await chamarArquivo(reqArquivo("tipo=extrato&banco=itau&de=2026-09-03&ate=2026-10-13", grande), dbx);
  assert.ok(r.status === 413 || r.status === 400, `status ${r.status}`);
  assert.equal(dbx.uploads.length, 0);
  assert.equal(LIMITE_ARQUIVO_IMPORT, 20 * 1024 * 1024);
});

test("C4: o cabeçalho content-length acima de 20 MB já recusa antes de ler o corpo", async () => {
  const dbx = dropboxFalso();
  const req = reqArquivo("tipo=extrato&banco=itau&de=2026-09-03&ate=2026-10-13", new Uint8Array([1]));
  // Request não deixa forjar content-length; um objeto com a mesma interface serve à rota
  const falso = { method: "POST", url: req.url, headers: new Headers({ Cookie: "token=token123", "content-length": String(LIMITE_ARQUIVO_IMPORT + 1) }),
    arrayBuffer: async () => { throw new Error("não devia ler o corpo"); } };
  const r = await handleApi(falso, envApi, new URL(req.url), {}, { fetchImpl: dbx.fetchImpl });
  assert.equal(r.status, 413);
  assert.equal(dbx.uploads.length, 0);
});

test("C4: corpo vazio → 400, sem chamar o Dropbox", async () => {
  const dbx = dropboxFalso();
  const r = await chamarArquivo(reqArquivo("tipo=extrato&banco=itau&de=2026-09-03&ate=2026-10-13", new Uint8Array(0)), dbx);
  assert.equal(r.status, 400);
  assert.equal(dbx.uploads.length, 0);
});

test("C4: falha do Dropbox vira erro (não 200), para o app avisar que o arquivo não foi guardado", async () => {
  const fetchImpl = async (u) => String(u).includes("oauth2/token")
    ? { ok: true, json: async () => ({ access_token: "tok" }) }
    : { ok: false, status: 500, json: async () => ({}) };
  const req = reqArquivo("tipo=fatura&banco=itau&mes=2026-10", new Uint8Array([1]));
  const r = await handleApi(req, envApi, new URL(req.url), {}, { fetchImpl });
  assert.ok(r.status >= 400);
});

// ---- A1: a esfera vem da categoria (Empresa = empresa; o resto, pessoal) ----
function dbFakeComEmpresa() {
  const db = dbFake();
  const base = db.catalogo;
  db.catalogo = async () => {
    const c = await base();
    return {
      categorias: [...c.categorias.map((x) => ({ ...x, esfera: "pessoal" })),
        { id: "cEmp", nome: "Empresa", natureza: "despesa", esfera: "empresa" }],
      subcategorias: [...c.subcategorias, { id: "sContab", categoria_id: "cEmp", nome: "Contabilidade" }],
    };
  };
  return db;
}

test("texto com categoria=Empresa grava esfera empresa (antes era 'pessoal' fixo)", async () => {
  const db = dbFakeComEmpresa();
  const deps = { db, confirmar: async () => {}, responderImpl: async () => {} };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "contador 350,00 10/09/2026 categoria=Empresa" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.estado.inseridos[0].categoria_id, "cEmp");
  assert.equal(db.estado.inseridos[0].esfera, "empresa");
});

test("texto com categoria pessoal segue gravando esfera pessoal", async () => {
  const db = dbFakeComEmpresa();
  const deps = { db, confirmar: async () => {}, responderImpl: async () => {} };
  const update = { message: { chat: { id: 7 }, message_id: 1, text: "padaria 12,00 10/09/2026 categoria=Casa" } };
  await tratarUpdate(update, { TELEGRAM_TOKEN: "t" }, deps);
  assert.equal(db.estado.inseridos[0].esfera, "pessoal");
});

function depsFoto(db, normalizado) {
  return {
    db,
    baixar: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }),
    extrairImpl: async () => ({ ok: true, normalizado, extraido_por: "gemini", confianca: 0.9 }),
    subir: async () => "/x.jpg", hashBytes: async () => "hA1",
    confirmar: async () => {}, responderImpl: async () => {},
  };
}
const fotoA1 = { message: { chat: { id: 7 }, message_id: 1, photo: [{ file_id: "b", width: 800 }] } };

test("foto classificada pelo modelo em Empresa grava esfera empresa", async () => {
  const db = dbFakeComEmpresa();
  await tratarUpdate(fotoA1, { TELEGRAM_TOKEN: "t" }, depsFoto(db,
    { dataISO: "2026-09-10", valorCents: 35000, natureza: "despesa", macro: "Empresa", sub: "Contabilidade", descricao: "Contador" }));
  assert.equal(db.estado.inseridos[0].categoria_id, "cEmp");
  assert.equal(db.estado.inseridos[0].esfera, "empresa");
});

test("foto: a regra aprendida que leva p/ Empresa também dá esfera empresa (a esfera é da categoria final)", async () => {
  const db = dbFakeComEmpresa();
  db.buscarAssociacao = async () => ({ categoria_id: "cEmp", subcategoria_id: "sContab" });
  await tratarUpdate(fotoA1, { TELEGRAM_TOKEN: "t" }, depsFoto(db,
    { dataISO: "2026-09-10", valorCents: 35000, natureza: "despesa", macro: "Casa", sub: null, descricao: "Contador",
      contraparte_nome: "Contabil Exemplo", contraparte_chave: "00000000000" }));
  assert.equal(db.estado.inseridos[0].esfera, "empresa");
});

test("PATCH /api/categorias/:id com {esfera} válida grava a esfera e regrava as transações (200)", async () => {
  const chamadas = [];
  const db = { mudarEsferaCategoria: async (id, esfera) => chamadas.push(["esfera", id, esfera]),
    renomearCategoria: async (id, nome) => chamadas.push(["nome", id, nome]) };
  const r = await handleApi(reqApi("/api/categorias/cEquip", "PATCH", { esfera: "empresa" }), envApi, new URL("http://localhost/api/categorias/cEquip"), db);
  assert.equal(r.status, 200);
  // só {esfera}: não renomeia (antes o PATCH gravava nome=undefined)
  assert.deepEqual(chamadas, [["esfera", "cEquip", "empresa"]]);
});

test("PATCH /api/categorias/:id com esfera fora do vocabulário → 400, sem gravar nada", async () => {
  const chamadas = [];
  const db = { mudarEsferaCategoria: async () => chamadas.push("esfera"), renomearCategoria: async () => chamadas.push("nome") };
  for (const esfera of ["Empresa", "pj", "", null]) {
    const r = await handleApi(reqApi("/api/categorias/cEquip", "PATCH", { nome: "X", esfera }), envApi, new URL("http://localhost/api/categorias/cEquip"), db);
    assert.equal(r.status, 400, `esfera ${JSON.stringify(esfera)}`);
  }
  assert.deepEqual(chamadas, []);
});

test("PATCH /api/categorias/:id só com {nome} continua renomeando, sem tocar na esfera", async () => {
  const chamadas = [];
  const db = { mudarEsferaCategoria: async () => chamadas.push("esfera"), renomearCategoria: async (id, nome) => chamadas.push(["nome", id, nome]) };
  const r = await handleApi(reqApi("/api/categorias/cEquip", "PATCH", { nome: "Equipamento" }), envApi, new URL("http://localhost/api/categorias/cEquip"), db);
  assert.equal(r.status, 200);
  assert.deepEqual(chamadas, [["nome", "cEquip", "Equipamento"]]);
});

test("PATCH /api/categorias/:id com corpo JSON null não vira 500: não há o que gravar, segue 200 sem tocar em nada", async () => {
  // `"esfera" in null` lançava TypeError; o corpo vazio/null tem que ser tratado como {}
  const chamadas = [];
  const db = { mudarEsferaCategoria: async () => chamadas.push("esfera"), renomearCategoria: async () => chamadas.push("nome") };
  const req = new Request("http://localhost/api/categorias/cEquip", {
    method: "PATCH", headers: { "Cookie": "token=token123", "content-type": "application/json" }, body: "null",
  });
  const r = await handleApi(req, envApi, new URL("http://localhost/api/categorias/cEquip"), db);
  assert.equal(r.status, 200);
  assert.deepEqual(chamadas, []);
});

// ---------- A3: cascata no Resumo ----------
// db falso cujas leituras (somas por esfera, grupos pessoais, saldo por mês) saem TODAS das mesmas
// linhas inventadas, com o filtro de conta_no_resumo e a janela [de, ateExcl) que o SQL aplica.
// Sem isso, "cascata.saldo === saldo-mensal" seria tautologia de dois mocks independentes.
function dbCascataFake(linhas) {
  const contam = (de, ateExcl) => linhas.filter(l => l.conta_no_resumo && l.data >= de && l.data < ateExcl);
  const soma = (ls) => ls.reduce((a, l) => a + l.cents, 0);
  return {
    salarioParams: async () => [{ vigente_desde: "2026-01-01", usd_cents: 800000 }],
    conversoes: async () => [{ id: "c1", data: "2026-09-03", usd_cents: 800000, brl_cents: 4000000, origem: "wise" }],
    saldoPorMes: async (de, ateExcl) => {
      const porMes = {};
      for (const l of contam(de, ateExcl)) {
        const m = (porMes[l.data.slice(0, 7)] ||= { mes: l.data.slice(0, 7), receita_cents: 0, despesa_cents: 0 });
        m[`${l.natureza}_cents`] += l.cents;
      }
      return Object.values(porMes);
    },
    somasPorEsfera: async (de, ateExcl) => {
      const ls = contam(de, ateExcl);
      return {
        despesa_empresa_cents: soma(ls.filter(l => l.natureza === "despesa" && l.esfera === "empresa")),
        despesa_pessoal_cents: soma(ls.filter(l => l.natureza === "despesa" && l.esfera === "pessoal")),
        outras_receitas_cents: soma(ls.filter(l => l.natureza === "receita")),
      };
    },
    despesaPessoalPorCategoria: async (de, ateExcl) => {
      const m = {};
      for (const l of contam(de, ateExcl)) if (l.natureza === "despesa" && l.esfera === "pessoal") m[l.macro] = (m[l.macro] || 0) + l.cents;
      return Object.entries(m).map(([macro, total_cents]) => ({ macro, total_cents }));
    },
    resumoKPIs: async () => ({ receita: "0.00", despesa: "0.00", reembolso: "0.00" }),
    resumoPorCategoria: async () => [],
    resumoPorPessoa: async () => [],
    resumoPorPessoaCategoria: async () => [],
    resumoDiario: async () => [],
    resumoMesVsAnterior: async () => [],
    // D5 entrou junto no /api/resumo: sem fatura no ano anterior, anoVsAnterior = null
    faturasImportadas: async () => [],
    resumoAnoVsAnterior: async () => [],
  };
}

// Exemplo do A3 (valores inventados): salário 40.000 (conversão de setembro), empresa 3.000,
// outras receitas 1.000, pessoais 20.000 + 5.000 → disponível 37.000, saldo 13.000.
const LINHAS_A3 = [
  { data: "2026-09-05", natureza: "despesa", esfera: "empresa", macro: "Empresa", cents: 300000, conta_no_resumo: true },
  { data: "2026-09-10", natureza: "despesa", esfera: "pessoal", macro: "Casa", cents: 2000000, conta_no_resumo: true },
  { data: "2026-09-30", natureza: "despesa", esfera: "pessoal", macro: "Lazer", cents: 500000, conta_no_resumo: true },
  { data: "2026-09-12", natureza: "receita", esfera: "pessoal", macro: "Receita", cents: 100000, conta_no_resumo: true },
  // membro de grupo / fora do resumo: não pode contar em nenhum dos dois lados
  { data: "2026-09-15", natureza: "despesa", esfera: "pessoal", macro: "Casa", cents: 999900, conta_no_resumo: false },
  // outro mês: fora da janela
  { data: "2026-08-31", natureza: "despesa", esfera: "empresa", macro: "Empresa", cents: 777700, conta_no_resumo: true },
];

test("A3 /api/resumo?mes= devolve a cascata em centavos: salário → empresa → disponível → outras receitas → pessoais → saldo", async () => {
  const db = dbCascataFake(LINHAS_A3);
  const req = new Request("http://localhost/api/resumo?mes=2026-09", { headers: G1_COOK });
  const { cascata } = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.deepEqual(cascata, {
    salario_cents: 4000000, despesa_empresa_cents: 300000, disponivel_cents: 3700000,
    outras_receitas_cents: 100000, despesa_pessoal_cents: 2500000, saldo_cents: 1300000, estimado: false,
    pessoais: [{ macro: "Casa", total_cents: 2000000 }, { macro: "Lazer", total_cents: 500000 }],
  });
});

test("A3 cascata.saldo_cents é igual ao saldo do mesmo mês em /api/saldo-mensal (mesmas linhas)", async () => {
  const db = dbCascataFake(LINHAS_A3);
  const r1 = new Request("http://localhost/api/resumo?mes=2026-09", { headers: G1_COOK });
  const { cascata } = await (await handleApi(r1, G1_ENV, new URL(r1.url), db)).json();
  const r2 = new Request("http://localhost/api/saldo-mensal?ate=2026-09", { headers: G1_COOK });
  const saldoMensal = await (await handleApi(r2, G1_ENV, new URL(r2.url), db)).json();
  assert.equal(cascata.saldo_cents, saldoMensal.find(m => m.mes === "2026-09").saldo_cents);
  assert.equal(cascata.saldo_cents, 1300000);
});

test("A3 mês com salário estimado (sem conversão ainda): cascata.estimado = true", async () => {
  const db = dbCascataFake(LINHAS_A3);
  const req = new Request("http://localhost/api/resumo?mes=2026-10", { headers: G1_COOK });
  const { cascata } = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.equal(cascata.estimado, true);
  assert.ok(cascata.salario_cents > 0);
});

test("A3 mês antes do primeiro parâmetro: salario_cents = 0 (nunca null), estimado = false, o resto segue", async () => {
  // o primeiro vigente_desde (2026-01) é posterior ao mês pedido
  const db = dbCascataFake([{ data: "2025-06-10", natureza: "despesa", esfera: "pessoal", macro: "Casa", cents: 50000, conta_no_resumo: true }]);
  const req = new Request("http://localhost/api/resumo?mes=2025-06", { headers: G1_COOK });
  const { cascata } = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.equal(cascata.salario_cents, 0);
  assert.equal(cascata.estimado, false);
  assert.equal(cascata.despesa_pessoal_cents, 50000);
  assert.equal(cascata.saldo_cents, -50000);
});

test("A3 /api/resumo sem mes= (de/ate livre) não monta cascata", async () => {
  const db = dbCascataFake(LINHAS_A3);
  const req = new Request("http://localhost/api/resumo?de=2026-01-01&ate=2026-12-31", { headers: G1_COOK });
  const data = await (await handleApi(req, G1_ENV, new URL(req.url), db)).json();
  assert.equal(data.cascata, null);
});

// ---- H5: POST /api/triagem/sugestoes (triagem assistida pelo JEV) ----
// As linhas vêm do banco por id. O db falso só sabe ler (catálogo e as linhas); qualquer outro
// método — escrita em transacoes ou associacoes — lança: a rota não pode gravar nada.
const uuidT = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const linhaT = (n, descricao, extra = {}) => ({
  id: uuidT(n), descricao, contraparte_nome: null, natureza: "despesa", fonte: "fatura",
  categoria_id: "kN", grupo_id: null, representante: false, valor_cents: "4990", ...extra,
});
function dbTriagem(linhas) {
  const f = { lidos: [] };
  const permitido = {
    catalogo: async () => CATALOGO_JEV,
    transacoesParaTriagem: async (ids) => { f.lidos.push(ids); return linhas.filter((l) => ids.includes(l.id)); },
  };
  return new Proxy(f, {
    get(alvo, nome) {
      if (nome in permitido) return permitido[nome];
      if (nome in alvo || typeof nome === "symbol" || nome === "then") return alvo[nome];
      return () => { throw new Error(`a triagem não pode chamar db.${String(nome)}`); };
    },
  });
}
const postTri = (corpo) => reqApi("/api/triagem/sugestoes", "POST", corpo);
const urlTri = new URL("http://localhost/api/triagem/sugestoes");
// responde pela descrição; quem não está no mapa leva Compras 0,2 (só a pergunta da categoria)
function fetchTri(porDescricao = {}) {
  const f = { chamadas: [] };
  f.impl = async (url, init) => {
    const corpo = JSON.parse(init.body);
    f.chamadas.push({ url, init, corpo });
    const [id] = Object.keys(corpo.questions);
    const [choice, prob] = porDescricao[corpo.state.descricao]?.[id] ?? ["Compras", 0.2];
    return new Response(JSON.stringify({ answers: { [id]: { choice, probabilities: { [choice]: prob } } } }), { status: 200 });
  };
  return f;
}

test("H5: lote com mais de 10 ids → 400, sem ler o banco nem chamar o JEV", async () => {
  const f = fetchTri();
  const db = dbTriagem([]);
  const ids = Array.from({ length: 11 }, (_, i) => uuidT(i + 1));
  const r = await comFetch(f, () => handleApi(postTri({ ids, limiar: 0.7 }), envJev, urlTri, db));
  assert.equal(r.status, 400);
  assert.equal(f.chamadas.length, 0);
  assert.deepEqual(db.lidos, []);
});

test("H5: ids que não são uuid, sem lista ou limiar fora de 0..1 → 400", async () => {
  const db = dbTriagem([]);
  assert.equal((await handleApi(postTri({ ids: ["x"] }), envJev, urlTri, db)).status, 400);
  assert.equal((await handleApi(postTri({ ids: [uuidT(1)], limiar: 1.5 }), envJev, urlTri, db)).status, 400);
  assert.equal((await handleApi(postTri({}), envJev, urlTri, db)).status, 400);
});

test("H5: Exemplo do card — LOJA 0,82 com sub, FULANO 0,40 só categoria, IFD* sem chamada", async () => {
  const f = fetchTri({
    "LOJA EXEMPLO": { categoria: ["Compras", 0.82], subcategoria: ["Compras", 0.7] },
    "FULANO DE TAL": { categoria: ["Compras", 0.4] },
  });
  const linhas = [linhaT(1, "LOJA EXEMPLO"), linhaT(2, "FULANO DE TAL"), linhaT(3, "IFD*LANCHE")];
  const r = await comFetch(f, () => handleApi(postTri({ ids: linhas.map((l) => l.id), limiar: 0.7 }), envJev, urlTri, dbTriagem(linhas)));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.indisponivel, false);
  const [loja, fulano, ifd] = d.itens;
  assert.deepEqual(loja, { id: uuidT(1), ignorado: false,
    sugestao: { categoria: "Compras", subcategoria: "Compras", prob_categoria: 0.82, prob_subcategoria: 0.7 } });
  // abaixo do limiar: só a categoria, e a pergunta da sub não é feita
  assert.deepEqual(fulano.sugestao, { categoria: "Compras", subcategoria: null, prob_categoria: 0.4, prob_subcategoria: null });
  assert.deepEqual(ifd.sugestao, { categoria: "Alimentação", subcategoria: "Ifood", prob_categoria: 1, prob_subcategoria: 1 });
  // LOJA: categoria + sub (2); FULANO: só categoria (1); IFD*: nenhuma
  assert.equal(f.chamadas.length, 3);
  assert.equal(f.chamadas.filter((c) => c.corpo.state.descricao === "FULANO DE TAL").length, 1);
  assert.ok(f.chamadas.every((c) => !c.corpo.state.descricao.startsWith("IFD*")));
});

test("H5: o limiar do corpo governa a sub — com 0,90 a LOJA 0,82 não tem a 2ª chamada", async () => {
  const f = fetchTri({ "LOJA EXEMPLO": { categoria: ["Compras", 0.82] } });
  const linhas = [linhaT(1, "LOJA EXEMPLO")];
  const d = await (await comFetch(f, () => handleApi(postTri({ ids: [uuidT(1)], limiar: 0.9 }), envJev, urlTri, dbTriagem(linhas)))).json();
  assert.equal(f.chamadas.length, 1);
  assert.equal(d.itens[0].sugestao.subcategoria, null);
});

test("H5: sem limiar no corpo vale 0,70 (a sub da LOJA 0,82 é perguntada)", async () => {
  const f = fetchTri({ "LOJA EXEMPLO": { categoria: ["Compras", 0.82], subcategoria: ["Amazon", 0.5] } });
  await comFetch(f, () => handleApi(postTri({ ids: [uuidT(1)] }), envJev, urlTri, dbTriagem([linhaT(1, "LOJA EXEMPLO")])));
  assert.equal(f.chamadas.length, 2);
});

test("H5: membro não-representante de grupo, id fora da padrão e id inexistente são ignorados, sem chamada", async () => {
  const f = fetchTri();
  const linhas = [
    linhaT(1, "MEMBRO DO GRUPO", { grupo_id: uuidT(90), representante: false }),
    linhaT(2, "JA CLASSIFICADA", { categoria_id: "kC" }),
    linhaT(3, "REPRESENTANTE NA PADRAO", { grupo_id: uuidT(91), representante: true }),
    linhaT(4, "LOJA SOLTA"),
  ];
  const ids = [...linhas.map((l) => l.id), uuidT(99)]; // o último não existe no banco
  const d = await (await comFetch(f, () => handleApi(postTri({ ids, limiar: 0.7 }), envJev, urlTri, dbTriagem(linhas)))).json();
  assert.deepEqual(d.itens.map((i) => i.id), ids);
  assert.deepEqual(d.itens.map((i) => i.ignorado), [true, true, false, false, true]);
  assert.equal(d.itens[0].sugestao, null);
  assert.equal(d.itens[1].sugestao, null);
  const perguntadas = f.chamadas.map((c) => c.corpo.state.descricao).sort();
  assert.deepEqual(perguntadas, ["LOJA SOLTA", "REPRESENTANTE NA PADRAO"]);
});

test("H5: 429 duas vezes → linha sem sugestão e aviso, 200", async () => {
  const f = fetchJev({}, { status: 429 });
  const r = await comFetch(f, () => handleApi(postTri({ ids: [uuidT(1)] }), envJev, urlTri, dbTriagem([linhaT(1, "LOJA X")])));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(f.chamadas.length, 2);
  assert.equal(d.itens[0].sugestao, null);
  assert.equal(d.indisponivel, true);
  assert.equal(d.aviso, "classificação automática indisponível");
});

test("H5: fetch lançando erro ou resposta inválida → linha sem sugestão e aviso", async () => {
  for (const impl of [
    async () => { throw new Error("rede caiu"); },
    async () => new Response(JSON.stringify({ outra: 1 }), { status: 200 }),
  ]) {
    const r = await comFetch({ impl }, () => handleApi(postTri({ ids: [uuidT(1)] }), envJev, urlTri, dbTriagem([linhaT(1, "LOJA X")])));
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.itens[0].sugestao, null);
    assert.equal(d.aviso, "classificação automática indisponível");
  }
});

test("H5: sem TYPESAFE_API_KEY → linhas sem sugestão e aviso, sem chamada", async () => {
  const f = fetchTri();
  const linhas = [linhaT(1, "IFD*LANCHE"), linhaT(2, "LOJA X")];
  const r = await comFetch(f, () => handleApi(postTri({ ids: [uuidT(1), uuidT(2)] }), envApi, urlTri, dbTriagem(linhas)));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(f.chamadas.length, 0);
  assert.deepEqual(d.itens.map((i) => i.sugestao), [null, null]);
  assert.equal(d.aviso, "classificação automática indisponível");
});

test("H5: banco falhando na leitura → 200 com aviso (nunca 500)", async () => {
  const quebrado = {
    catalogo: async () => CATALOGO_JEV,
    transacoesParaTriagem: async () => { throw new Error("banco fora"); },
  };
  const r = await comFetch(fetchTri(), () => handleApi(postTri({ ids: [uuidT(1)] }), envJev, urlTri, quebrado));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.itens[0].sugestao, null);
  assert.equal(d.aviso, "classificação automática indisponível");
});

// ---- H6: a legenda do comprovante vira a categoria ----
// Catálogo e contraparte inventados. Casa não tem genérica (nem "Casa" nem "Outros") — por isso o
// JEV pode responder "sem subcategoria" ali; Compras tem a genérica Compras › Compras; Outros
// não tem sub ativa; Empresa tem esfera empresa (A1).
const catalogoH6 = {
  categorias: [
    { id: "cCasa", nome: "Casa", natureza: "despesa", esfera: "pessoal" },
    { id: "cAli", nome: "Alimentação", natureza: "despesa", esfera: "pessoal" },
    { id: "cCompras", nome: "Compras", natureza: "despesa", esfera: "pessoal" },
    { id: "cEmp", nome: "Empresa", natureza: "despesa", esfera: "empresa" },
    { id: "cOut", nome: "Outros", natureza: "despesa", esfera: "pessoal" },
    { id: "cNI", nome: "Não Identificado", natureza: "despesa", esfera: "pessoal", padrao: true },
    { id: "cRec", nome: "Receita", natureza: "receita", esfera: "pessoal" },
  ],
  subcategorias: [
    { id: "sAlug", categoria_id: "cCasa", nome: "Aluguel" },
    { id: "sLuz", categoria_id: "cCasa", nome: "Luz" },
    { id: "sMerc", categoria_id: "cAli", nome: "Mercado" },
    { id: "sAliOut", categoria_id: "cAli", nome: "Outros" },
    { id: "sCompras", categoria_id: "cCompras", nome: "Compras" },
    { id: "sRoupa", categoria_id: "cCompras", nome: "Roupa" },
    { id: "sCont", categoria_id: "cEmp", nome: "Contador" },
    { id: "sEmpOut", categoria_id: "cEmp", nome: "Outros" },   // "Outros" repetida: não casa no passo 2
    { id: "sSal", categoria_id: "cRec", nome: "Salário" },
  ],
};

const leituraH6 = { dataISO: "2026-10-10", valorCents: 12345, natureza: "despesa", macro: "Casa", sub: "Luz",
  descricao: "Pix enviado", contraparte_nome: "FULANA DE TESTE", contraparte_chave: "fulana@exemplo.com" };

// perguntar falso: responde pelo id da pergunta (categoria/subcategoria); Error → lança.
function perguntarFalso(respostas, chamadas) {
  return async (corpo) => {
    chamadas.push(corpo);
    const id = Object.keys(corpo.questions)[0];
    const r = respostas[id];
    if (r === undefined || r instanceof Error) throw r ?? new Error(`pergunta inesperada: ${id}`);
    return { answers: { [id]: { choice: r.choice, probabilities: { [r.choice]: r.prob ?? 0.99 } } } };
  };
}

function depsH6({ leitura = {}, respostas = {}, chave = "k-teste", associacao = null } = {}) {
  const db = dbFake();
  db.catalogo = async () => catalogoH6;
  db.buscarAssociacao = async () => associacao;
  const aprendidas = [];
  db.upsertAssociacao = async (a) => { aprendidas.push(a); };
  const enviados = [], chamadas = [];
  const deps = {
    db,
    baixar: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
    hashBytes: async () => "hH6",
    extrairImpl: async () => ({ ok: true, extraido_por: "gemini", confianca: 0.9, normalizado: { ...leituraH6, ...leitura } }),
    subir: async (e, caminho) => caminho,
    confirmar: async (c, texto) => enviados.push(texto),
    responderImpl: async () => {},
    jevChave: chave,
    perguntar: perguntarFalso(respostas, chamadas),
  };
  return { deps, db, aprendidas, enviados, chamadas };
}

const fotoH6 = (caption) => ({ message: { chat: { id: 7 }, message_id: 1, ...(caption === undefined ? {} : { caption }),
  photo: [{ file_id: "fH6", width: 800 }] } });
const pdfH6 = (caption) => ({ message: { chat: { id: 7 }, message_id: 1, caption,
  document: { file_id: "pH6", mime_type: "application/pdf" } } });

test("H6: legenda com nome de sub único ('aluguel') grava Casa › Aluguel, manual, aprende a regra e avisa '(da legenda)'", async () => {
  const t = depsH6();
  await tratarUpdate(fotoH6("aluguel"), { TELEGRAM_TOKEN: "t" }, t.deps);
  const ins = t.db.estado.inseridos[0];
  assert.equal(ins.categoria_id, "cCasa");
  assert.equal(ins.subcategoria_id, "sAlug");
  assert.equal(ins.origem_categoria, "manual");
  assert.equal(t.chamadas.length, 0);                    // casamento exato não gasta JEV
  assert.deepEqual(t.aprendidas, [{ chave: "fulana@exemplo.com", tipo: "pix_cpf", categoria_id: "cCasa", subcategoria_id: "sAlug" }]);
  assert.match(t.enviados[0], /Casa › Aluguel \(da legenda\)/);
});

test("H6: legenda 'Casa › Aluguel' casa o par (passo 1)", async () => {
  const t = depsH6();
  await tratarUpdate(fotoH6("Casa › Aluguel"), { TELEGRAM_TOKEN: "t" }, t.deps);
  assert.equal(t.db.estado.inseridos[0].subcategoria_id, "sAlug");
  assert.match(t.enviados[0], /Casa › Aluguel \(da legenda\)/);
});

test("H6: legenda com acento e maiúscula trocados ('ALIMENTACAO > mercado') casa", async () => {
  const t = depsH6();
  await tratarUpdate(fotoH6("ALIMENTACAO > mercado"), { TELEGRAM_TOKEN: "t" }, t.deps);
  assert.equal(t.db.estado.inseridos[0].categoria_id, "cAli");
  assert.equal(t.db.estado.inseridos[0].subcategoria_id, "sMerc");
});

test("H6: legenda 'Outros' vai à categoria Outros sem perguntar ao JEV (categoria sem sub ativa)", async () => {
  const t = depsH6();
  await tratarUpdate(fotoH6("Outros"), { TELEGRAM_TOKEN: "t" }, t.deps);
  const ins = t.db.estado.inseridos[0];
  assert.equal(ins.categoria_id, "cOut");
  assert.equal(ins.subcategoria_id, null);
  assert.equal(t.chamadas.length, 0);
  assert.doesNotMatch(t.enviados[0], /não consegui escolher/);   // sem sub para escolher não é falha
});

test("H6: legenda só com a categoria e sub do modelo dentro dela: usa a do modelo, sem JEV", async () => {
  const t = depsH6({ leitura: { macro: "Compras", sub: "Roupa" } });
  await tratarUpdate(fotoH6("Compras"), { TELEGRAM_TOKEN: "t" }, t.deps);
  assert.equal(t.db.estado.inseridos[0].categoria_id, "cCompras");   // "Compras" foi ao passo 3
  assert.equal(t.db.estado.inseridos[0].subcategoria_id, "sRoupa");
  assert.equal(t.chamadas.length, 0);
});

test("H6: legenda só com a categoria e o modelo em outra: o JEV falso escolhe a sub dentro dela", async () => {
  // o Exemplo do card: "Alimentação" com o modelo lendo Casa › Luz → Alimentação › Mercado
  const t = depsH6({ respostas: { subcategoria: { choice: "Mercado", prob: 0.6 } } });
  await tratarUpdate(fotoH6("Alimentação"), { TELEGRAM_TOKEN: "t" }, t.deps);
  const ins = t.db.estado.inseridos[0];
  assert.equal(ins.categoria_id, "cAli");
  assert.equal(ins.subcategoria_id, "sMerc");                       // sem limiar na sub
  assert.equal(ins.origem_categoria, "manual");
  assert.equal(t.chamadas.length, 1);
  const pergunta = t.chamadas[0].questions.subcategoria;
  assert.deepEqual(Object.keys(pergunta.criteria).sort(), ["Mercado", "Outros"]);   // só subs de Alimentação
  assert.equal(t.chamadas[0].state.legenda, "Alimentação");
  assert.equal(t.chamadas[0].state.fonte, "comprovante fotografado (Pix, boleto ou recibo)");
  // a categoria veio do casamento exato: a regra aprende o par final
  assert.deepEqual(t.aprendidas.map((a) => [a.categoria_id, a.subcategoria_id]), [["cAli", "sMerc"]]);
});

test("H6: 'Compras' com o modelo em outra categoria grava a genérica só porque o JEV a escolheu", async () => {
  const t = depsH6({ respostas: { subcategoria: { choice: "Compras" } } });
  await tratarUpdate(fotoH6("Compras"), { TELEGRAM_TOKEN: "t" }, t.deps);
  assert.equal(t.chamadas.length, 1);
  assert.equal(t.db.estado.inseridos[0].subcategoria_id, "sCompras");
});

test("H6: JEV respondendo 'sem subcategoria' grava a sub null, sem aviso", async () => {
  const t = depsH6({ leitura: { macro: "Alimentação", sub: "Mercado" }, respostas: { subcategoria: { choice: "sem subcategoria" } } });
  await tratarUpdate(fotoH6("Casa"), { TELEGRAM_TOKEN: "t" }, t.deps);
  assert.equal(t.db.estado.inseridos[0].categoria_id, "cCasa");
  assert.equal(t.db.estado.inseridos[0].subcategoria_id, null);
  assert.doesNotMatch(t.enviados[0], /não consegui escolher/);
});

for (const [nome, opts] of [
  ["sem chave", { chave: "" }],
  ["fetch lança", { respostas: { subcategoria: new Error("rede caiu") } }],
  ["resposta inválida (escolha fora das opções)", { respostas: { subcategoria: { choice: "Inventada" } } }],
]) {
  test(`H6: JEV sem resposta (${nome}) grava a categoria da legenda com sub null e avisa`, async () => {
    const t = depsH6(opts);
    await tratarUpdate(fotoH6("Alimentação"), { TELEGRAM_TOKEN: "t" }, t.deps);
    const ins = t.db.estado.inseridos[0];
    assert.equal(ins.categoria_id, "cAli");
    assert.equal(ins.subcategoria_id, null);
    assert.equal(ins.origem_categoria, "manual");
    assert.match(t.enviados[0], /não consegui escolher a subcategoria; ajuste no app/);
    assert.match(t.enviados[0], /\(da legenda\)/);
  });
}

test("H6: legenda sem casamento vai às duas perguntas do JEV; com 0,95 grava e NÃO aprende regra", async () => {
  const t = depsH6({ respostas: { categoria: { choice: "Alimentação", prob: 0.95 }, subcategoria: { choice: "Mercado", prob: 0.7 } } });
  await tratarUpdate(fotoH6("mercadinho"), { TELEGRAM_TOKEN: "t" }, t.deps);
  const ins = t.db.estado.inseridos[0];
  assert.equal(ins.categoria_id, "cAli");
  assert.equal(ins.subcategoria_id, "sMerc");
  assert.equal(ins.origem_categoria, "manual");
  assert.deepEqual(t.chamadas.map((c) => Object.keys(c.questions)[0]), ["categoria", "subcategoria"]);
  const opcoes = Object.keys(t.chamadas[0].questions.categoria.criteria);
  assert.ok(!opcoes.includes("Não Identificado"));   // a padrão nunca é opção
  assert.ok(!opcoes.includes("Receita"));            // filtrada pela natureza (despesa)
  assert.equal(t.chamadas[0].state.legenda, "mercadinho");
  assert.equal(t.aprendidas.length, 0);              // palpite do modelo não vira regra (como H3/H4)
  assert.match(t.enviados[0], /Alimentação › Mercado \(da legenda\)/);
});

test("H6: JEV abaixo de 0,90 é sem casamento: grava como hoje e avisa que não reconheceu", async () => {
  const t = depsH6({ respostas: { categoria: { choice: "Alimentação", prob: 0.3 } } });
  await tratarUpdate(fotoH6("xpto"), { TELEGRAM_TOKEN: "t" }, t.deps);
  const ins = t.db.estado.inseridos[0];
  assert.equal(ins.categoria_id, "cCasa");           // a leitura do modelo
  assert.equal(ins.subcategoria_id, "sLuz");
  assert.equal(ins.origem_categoria, "modelo");
  assert.equal(t.chamadas.length, 1);                // nem pergunta a sub
  assert.equal(t.aprendidas.length, 0);
  assert.match(t.enviados[0], /Não reconheci a categoria 'xpto'; gravei como Casa › Luz/);
  assert.match(t.enviados[0], /corrija no app/);
  assert.doesNotMatch(t.enviados[0], /da legenda/);
});

test("H6: JEV 'nenhuma serve', com erro ou sem chave, sem casamento exato: grava como hoje e avisa", async () => {
  for (const opts of [
    { respostas: { categoria: { choice: "nenhuma serve", prob: 0.99 } } },
    { respostas: { categoria: new Error("rede caiu") } },
    { chave: "" },
  ]) {
    const t = depsH6(opts);
    await tratarUpdate(fotoH6("xpto"), { TELEGRAM_TOKEN: "t" }, t.deps);
    assert.equal(t.db.estado.inseridos[0].origem_categoria, "modelo");
    assert.match(t.enviados[0], /Não reconheci a categoria 'xpto'/);
  }
});

test("H6: sem casamento, a regra aprendida segue valendo (origem regra) e o aviso cita o que gravou", async () => {
  const t = depsH6({ chave: "", associacao: { categoria_id: "cCompras", subcategoria_id: "sRoupa" } });
  await tratarUpdate(fotoH6("xpto"), { TELEGRAM_TOKEN: "t" }, t.deps);
  assert.equal(t.db.estado.inseridos[0].origem_categoria, "regra");
  assert.match(t.enviados[0], /gravei como Compras › Roupa/);
});

test("H6: a legenda vence a regra aprendida da contraparte", async () => {
  const t = depsH6({ associacao: { categoria_id: "cCompras", subcategoria_id: "sRoupa" } });
  await tratarUpdate(fotoH6("aluguel"), { TELEGRAM_TOKEN: "t" }, t.deps);
  const ins = t.db.estado.inseridos[0];
  assert.equal(ins.categoria_id, "cCasa");
  assert.equal(ins.subcategoria_id, "sAlug");
  assert.equal(ins.origem_categoria, "manual");
  assert.doesNotMatch(t.enviados[0], /✓ aprendido/);
});

test("H6: sem contraparte, a legenda grava a categoria mas não há regra a aprender", async () => {
  const t = depsH6({ leitura: { contraparte_nome: null, contraparte_chave: null } });
  await tratarUpdate(fotoH6("aluguel"), { TELEGRAM_TOKEN: "t" }, t.deps);
  assert.equal(t.db.estado.inseridos[0].subcategoria_id, "sAlug");
  assert.equal(t.aprendidas.length, 0);
});

test("H6: regra aprendida pelo nome quando o comprovante não tem chave Pix", async () => {
  const t = depsH6({ leitura: { contraparte_chave: null } });
  await tratarUpdate(fotoH6("aluguel"), { TELEGRAM_TOKEN: "t" }, t.deps);
  assert.deepEqual(t.aprendidas, [{ chave: "FULANA DE TESTE", tipo: "nome", categoria_id: "cCasa", subcategoria_id: "sAlug" }]);
});

test("H6: natureza e esfera seguem a categoria da legenda", async () => {
  const t1 = depsH6();
  await tratarUpdate(fotoH6("Salário"), { TELEGRAM_TOKEN: "t" }, t1.deps);
  assert.equal(t1.db.estado.inseridos[0].categoria_id, "cRec");
  assert.equal(t1.db.estado.inseridos[0].natureza, "receita");    // o modelo leu despesa
  const t2 = depsH6();
  await tratarUpdate(fotoH6("contador"), { TELEGRAM_TOKEN: "t" }, t2.deps);
  assert.equal(t2.db.estado.inseridos[0].esfera, "empresa");
});

test("H6: PDF com legenda também casa", async () => {
  const t = depsH6();
  await tratarUpdate(pdfH6("aluguel"), { TELEGRAM_TOKEN: "t" }, t.deps);
  assert.equal(t.db.estado.inseridos[0].subcategoria_id, "sAlug");
  assert.equal(t.db.estado.inseridos[0].origem_categoria, "manual");
  assert.match(t.enviados[0], /\(da legenda\)/);
});

test("H6: legenda vazia, só espaços ou '/comando' não muda nada do fluxo de hoje (foto e PDF)", async () => {
  const base = depsH6();
  await tratarUpdate(fotoH6(undefined), { TELEGRAM_TOKEN: "t" }, base.deps);
  for (const caption of ["", "   ", "/qualquer coisa"]) {
    for (const upd of [fotoH6(caption), pdfH6(caption)]) {
      const t = depsH6();
      await tratarUpdate(upd, { TELEGRAM_TOKEN: "t" }, t.deps);
      assert.equal(t.chamadas.length, 0);
      assert.equal(t.aprendidas.length, 0);
      assert.equal(t.enviados[0], base.enviados[0]);
      assert.deepEqual(t.db.estado.inseridos[0], base.db.estado.inseridos[0]);
      assert.equal(t.db.estado.inseridos[0].origem_categoria, "modelo");
    }
  }
});
