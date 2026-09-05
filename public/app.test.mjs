import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agruparMensal, centavosBR, kf, deltaPct, periodoRange, construirWaterfall, subsDaCat,
  agruparPorPessoa, filtrarTransacoes, montarDecisao, podeAplicar, resumoTexto,
} from "./app.js";
import { reconstruirTexto } from "./pdf_extrair.js";
import { parseExtrato } from "../worker/extrato.js";
import { parseFatura } from "../worker/fatura.js";

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

// ---------- montarDecisao / podeAplicar / resumoTexto (Task 9: aba Importar) ----------
// catálogo fixture mínimo: "Outros" (fallback obrigatório), "Transferências" (não-gasto
// típico) e "Mercado" com uma sub, pra exercitar a resolução nome→id igual worker/categorias.js.
const CATALOGO_IMPORT = {
  categorias: [
    { id: "cOut", nome: "Outros" },
    { id: "cTransf", nome: "Transferências" },
    { id: "cMerc", nome: "Mercado" },
  ],
  subcategorias: [
    { id: "sHorti", categoria_id: "cMerc", nome: "Hortifruti" },
  ],
};

function previewFixture() {
  return {
    checksum: { ok: true, diferencaCents: 0 },
    resumo: { novos: 1, casados: 1, naoGasto: 1, ambiguos: 1, jaTem: 1 },
    itens: [
      { // novo — categoria vem de categoriaNome (regra aprendida), com sub
        status: "novo", data: "2026-08-01", descricao: "MERCADO XYZ", valorCents: 5000,
        natureza: "despesa", linhaHash: "h1", matchId: null, computaResumo: true,
        categoriaNome: "Mercado", subNome: "Hortifruti", categoriaOrg: null,
        contraparteNome: "Mercado Xyz Ltda",
      },
      { // naoGasto — categoria vem de categoriaOrg (fatura pagamento/transferência), sem regra
        status: "naoGasto", data: "2026-08-02", descricao: "TED PARA CONTA PROPRIA", valorCents: 100000,
        natureza: "despesa", linhaHash: "h2", matchId: null, computaResumo: false,
        categoriaNome: null, subNome: null, categoriaOrg: "Transferências",
        contraparteNome: null,
      },
      { // casado — só matchId+linhaHash importam
        status: "casado", data: "2026-08-03", descricao: "PIX RECEBIDO", valorCents: 2000,
        natureza: "receita", linhaHash: "h3", matchId: "m1", computaResumo: true,
        categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null,
      },
      { // ambiguo — não aplicado por padrão
        status: "ambiguo", data: "2026-08-04", descricao: "TALVEZ CASE", valorCents: 3000,
        natureza: "despesa", linhaHash: "h4", matchId: null, computaResumo: true,
        categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null,
      },
      { // jaTem — idempotência, nunca reaplica
        status: "jaTem", data: "2026-08-05", descricao: "JA IMPORTADO", valorCents: 900,
        natureza: "despesa", linhaHash: "h5", matchId: null, computaResumo: null,
        categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null,
      },
    ],
  };
}

test("montarDecisao: item novo resolve categoria/sub por nome, marca fonte/origem/computa_resumo/linha_hash", () => {
  const preview = previewFixture();
  const d = montarDecisao(preview, CATALOGO_IMPORT, "extrato");
  assert.equal(d.novos.length, 1);
  const n = d.novos[0];
  assert.equal(n.categoria_id, "cMerc");
  assert.equal(n.subcategoria_id, "sHorti");
  assert.equal(n.dataISO, "2026-08-01");
  assert.equal(n.natureza, "despesa");
  assert.equal(n.esfera, "pessoal");
  assert.equal(n.valorCents, 5000);
  assert.equal(n.reembolsoCents, 0);
  assert.equal(n.descricao, "MERCADO XYZ");
  assert.equal(n.fonte, "extrato");
  assert.equal(n.origem_categoria, "regra"); // categoriaNome presente = veio de associação aprendida
  assert.equal(n.contraparte_nome, "Mercado Xyz Ltda");
  assert.equal(n.computa_resumo, true);
  assert.equal(n.linha_hash, "h1");
});

test("montarDecisao: item naoGasto resolve categoriaOrg (sem sub) e computa_resumo:false", () => {
  const preview = previewFixture();
  const d = montarDecisao(preview, CATALOGO_IMPORT, "extrato");
  assert.equal(d.naoGasto.length, 1);
  const ng = d.naoGasto[0];
  assert.equal(ng.categoria_id, "cTransf");
  assert.equal(ng.subcategoria_id, null);
  assert.equal(ng.origem_categoria, "modelo"); // sem categoriaNome (não veio de regra)
  assert.equal(ng.computa_resumo, false);
  assert.equal(ng.linha_hash, "h2");
  assert.equal(ng.fonte, "extrato");
});

test("montarDecisao: item casado vira {matchId,linhaHash}", () => {
  const preview = previewFixture();
  const d = montarDecisao(preview, CATALOGO_IMPORT, "extrato");
  assert.deepEqual(d.casados, [{ matchId: "m1", linhaHash: "h3" }]);
});

test("montarDecisao: ambíguo e jáTem não são aplicados (fora de novos/naoGasto/casados)", () => {
  const preview = previewFixture();
  const d = montarDecisao(preview, CATALOGO_IMPORT, "extrato");
  const todasDescricoes = [...d.novos, ...d.naoGasto].map(x => x.descricao);
  assert.ok(!todasDescricoes.includes("TALVEZ CASE"));
  assert.ok(!todasDescricoes.includes("JA IMPORTADO"));
  assert.equal(d.casados.length, 1); // só o "casado" de verdade
});

test("montarDecisao: fatura usa descricaoFinal quando presente", () => {
  const preview = {
    checksum: { ok: true, diferencaCents: 0 },
    resumo: { novos: 1, casados: 0, naoGasto: 0, ambiguos: 0, jaTem: 0 },
    itens: [{
      status: "novo", data: "2026-08-01", descricao: "LOJA X PARCELA 01/03", descricaoFinal: "LOJA X (parc 01/03)",
      valorCents: 1000, natureza: "despesa", linhaHash: "hf1", matchId: null, computaResumo: true,
      categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: "Loja X",
    }],
  };
  const d = montarDecisao(preview, CATALOGO_IMPORT, "fatura");
  assert.equal(d.novos[0].descricao, "LOJA X (parc 01/03)");
  assert.equal(d.novos[0].fonte, "fatura");
  assert.equal(d.novos[0].categoria_id, "cOut"); // sem categoriaNome/categoriaOrg -> fallback Outros
});

test("podeAplicar: bloqueia só quando checksum.bloqueiaAplicar===true (extrato); fatura é aviso", () => {
  assert.equal(podeAplicar({ checksum: { ok: true, bloqueiaAplicar: false } }), true);   // extrato ok
  assert.equal(podeAplicar({ checksum: { ok: false, bloqueiaAplicar: true } }), false);  // extrato não bate → bloqueia
  assert.equal(podeAplicar({ checksum: { ok: false, bloqueiaAplicar: false } }), true);  // fatura c/ diferença (IOF) → aplica
});

test("resumoTexto: conta cada grupo (inclui 'fora do resumo') a partir dos itens", () => {
  const preview = previewFixture();
  const txt = resumoTexto(preview);
  assert.match(txt, /novos 1/i);
  assert.match(txt, /conciliad\w* 1/i);
  assert.match(txt, /fora do resumo 1/i); // naoGasto — o grupo que faltava cobrir
  assert.match(txt, /ambígu\w* 1/i);
  assert.match(txt, /já tinha 1/i);
});

test("resumoTexto: recontagem AO VIVO acompanha a resolução de ambíguo (não fica preso no resumo do servidor)", () => {
  const preview = previewFixture();
  // resolve o ambíguo virando novo (mesma mutação que o handler 'tratar como novo' faz)
  const amb = preview.itens.find(i => i.status === "ambiguo");
  amb.status = "novo";
  const txt = resumoTexto(preview);
  assert.match(txt, /novos 2/i);      // 1 original + o ambíguo promovido
  assert.match(txt, /ambígu\w* 0/i);  // não sobrou ambíguo
});

// ---------- reconstruirTexto (Task 8: pdf.js -> texto compatível com parseExtrato/parseFatura) ----------
// Fixtures sintéticas: como os PDFs reais (Fatura_Itau, itau_extrato) não estão em disco
// nessa sessão, os `itens` abaixo modelam a geometria descrita no plano (fatura Itaú:
// coluna do item à esquerda, coluna de juros/ruído à direita, mesma linha/y). A ponte
// de confiança real é rodar parseExtrato/parseFatura direto no texto reconstruído.

test("reconstruirTexto modo layout: 2 colunas na mesma linha -> data, estabelecimento, valor do item antes do ruído da direita", () => {
  const itens = [
    // linha 1 (y=700): estabelecimento partido em 2 tokens (comum no pdf.js), valor do item
    // em x=300 (coluna esquerda) e "Juros 10,50" em x=430/460 (coluna direita, deve vir depois)
    { str: "29/05", x: 60, y: 700 },
    { str: "PARK E CO", x: 100, y: 700 },
    { str: "ESTACIONAME", x: 180, y: 700 },
    { str: "17,00", x: 300, y: 700 },
    { str: "Juros", x: 430, y: 700 },
    { str: "10,50", x: 460, y: 700 },
    // linha 2 (y=680, abaixo da linha 1) — sem coluna direita
    { str: "30/05", x: 60, y: 680 },
    { str: "OUTRO ESTABELECIMENTO", x: 100, y: 680 },
    { str: "25,90", x: 300, y: 680 },
  ];

  const texto = reconstruirTexto(itens, "layout");
  const linhas = texto.split("\n");
  assert.equal(linhas.length, 2);
  // linha 1 primeiro (y maior = mais alto na página = vem antes)
  assert.match(linhas[0], /^29\/05\s+PARK E CO\s+ESTACIONAME\s+17,00\s+Juros\s+10,50$/);
  assert.match(linhas[1], /^30\/05\s+OUTRO ESTABELECIMENTO\s+25,90$/);

  // a prova real de compatibilidade: parseFatura tem que ler o texto reconstruído certo
  const { itens: parsed, totalCents } = parseFatura(texto, 2025);
  assert.deepEqual(parsed, [
    { data: "2025-05-29", descricao: "PARK E CO ESTACIONAME", valorCents: 1700, parcela: null },
    { data: "2025-05-30", descricao: "OUTRO ESTABELECIMENTO", valorCents: 2590, parcela: null },
  ]);
  assert.equal(totalCents, 0);
});

test("reconstruirTexto modo simples: uma coluna, itens da linha juntam com espaço único", () => {
  const itens = [
    { str: "10/12/2025", x: 60, y: 500 },
    { str: "SALDO", x: 150, y: 500 },
    { str: "DO", x: 190, y: 500 },
    { str: "DIA", x: 220, y: 500 },
    { str: "8.876,46", x: 400, y: 500 },
  ];

  const texto = reconstruirTexto(itens, "simples");
  assert.equal(texto, "10/12/2025 SALDO DO DIA 8.876,46");

  const { linhas, saldos } = parseExtrato(texto);
  assert.deepEqual(linhas, []);
  assert.deepEqual(saldos, [{ data: "2025-12-10", saldoCents: 887646 }]);
});

test("reconstruirTexto modo simples: duas linhas (y diferente) viram duas linhas de texto, compatíveis com parseExtrato", () => {
  const itens = [
    { str: "10/12/2025", x: 60, y: 500 },
    { str: "SALDO", x: 150, y: 500 },
    { str: "DO", x: 190, y: 500 },
    { str: "DIA", x: 220, y: 500 },
    { str: "8.876,46", x: 400, y: 500 },
    // linha de lançamento, y menor (abaixo) — mesma data, descrição com barra e negativo
    { str: "10/12/2025", x: 60, y: 480 },
    { str: "PIX", x: 150, y: 480 },
    { str: "QRS", x: 190, y: 480 },
    { str: "LOJA", x: 230, y: 480 },
    { str: "X10/12", x: 280, y: 480 },
    { str: "-100,00", x: 400, y: 480 },
  ];

  const texto = reconstruirTexto(itens, "simples");
  const { linhas, saldos } = parseExtrato(texto);
  assert.deepEqual(saldos, [{ data: "2025-12-10", saldoCents: 887646 }]);
  assert.deepEqual(linhas, [
    { data: "2025-12-10", descricao: "PIX QRS LOJA X10/12", valorCents: 10000, natureza: "despesa", ordinal: 0 },
  ]);
});

test("reconstruirTexto agrupa por y com tolerância (rounding sub-pixel do pdf.js) e ordena por x mesmo com itens fora de ordem", () => {
  // y varia por rounding (699.6 vs 700.3) e os itens chegam fora de ordem — ambos comuns
  // na saída real do pdf.js getTextContent().
  const itens = [
    { str: "17,00", x: 300, y: 699.6 },
    { str: "29/05", x: 60, y: 700.3 },
    { str: "LOJA X", x: 100, y: 700 },
  ];
  const texto = reconstruirTexto(itens, "layout");
  assert.equal(texto.split("\n").length, 1);
  assert.match(texto, /^29\/05\s+LOJA X\s+17,00$/);
});

test("reconstruirTexto ignora itens com string vazia/só espaço (comuns no pdf.js)", () => {
  const itens = [
    { str: "29/05", x: 60, y: 700 },
    { str: "  ", x: 90, y: 700 },
    { str: "", x: 95, y: 700 },
    { str: "LOJA", x: 100, y: 700 },
    { str: "17,00", x: 300, y: 700 },
  ];
  const texto = reconstruirTexto(itens, "layout");
  assert.match(texto, /^29\/05\s+LOJA\s+17,00$/);
});
