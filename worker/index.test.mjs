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
    resumoKPIs: async () => ({ receita: 1000, despesa: 500, reembolso: 0 }),
    resumoPorCategoria: async () => [{ macro: "Casa", sub: "Limpeza", natureza: "despesa", total: 500, n: 1 }],
    resumoPorPessoa: async () => [{ pessoa: "Alice", natureza: "despesa", total: 300 }],
    resumoPorPessoaCategoria: async (de, ate) => { estado.ppc = { de, ate }; return [{ pessoa: "Alice", categoria: "Casa", total_cents: 30000 }]; },
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

test("/api/resumo?mes= devolve porPessoaCategoria do db, no intervalo do mês", async () => {
  // o sunburst pessoa → categoria (D6) lê este corte; o intervalo é o mesmo dos kpis
  const db = dbResumoFake();
  const env = { APP_TOKEN: "token123", DATABASE_URL: "" };
  const req = new Request("http://localhost/api/resumo?mes=2026-09", { headers: { "Cookie": "token=token123" } });
  const data = await (await handleApi(req, env, new URL(req.url), db)).json();
  assert.deepEqual(data.porPessoaCategoria, [{ pessoa: "Alice", categoria: "Casa", total_cents: 30000 }]);
  assert.deepEqual(db.estado.ppc, { de: "2026-09-01", ate: "2026-09-30" });
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
  assert.deepEqual(db.chamadas, ["aplicarImportacao", "marcarPagamentoFaturaNaoGasto"]);
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
