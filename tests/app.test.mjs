import { test } from "node:test";
import assert from "node:assert/strict";
import {
  centavosBR, kf, deltaPct, rangeDoMes, construirWaterfall, subsDaCat,
  agruparPorPessoa, filtrarTransacoes, montarDecisao, podeAplicar, resumoTexto, montarMudancas,
  acumularDiario, paceOrcamento, montarLinhas, filtrarLinhas, mascararChave, filtrarAssociacoes,
  escolherCandidato, linhaEditavel, idsSelecionaveis,
} from "../public/app.js";
import { montarPreviewExtrato } from "../worker/importar.js";
import { reconstruirTexto } from "../public/pdf_extrair.js";
import { parseExtrato } from "../worker/extrato.js";
import { parseFatura } from "../worker/fatura.js";

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

test("rangeDoMes: de = dia 1, ateExcl = dia 1 do mês seguinte (vira o ano)", () => {
  assert.deepEqual(rangeDoMes("2026-09"), { de: "2026-09-01", ateExcl: "2026-10-01" });
  assert.deepEqual(rangeDoMes("2026-12"), { de: "2026-12-01", ateExcl: "2027-01-01" });
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
      { // casado — vira linha do extrato dentro do grupo do lançamento casado (Inc 4.6)
        status: "casado", data: "2026-08-03", descricao: "PIX RECEBIDO", valorCents: 2000,
        natureza: "receita", linhaHash: "h3", matchId: "m1", matchGrupoId: null, computaResumo: true,
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

test("montarDecisao: casado vira linha do extrato dentro do grupo (novo ou existente), nunca só um carimbo", () => {
  const preview = previewFixture();
  // o item "casado" da fixture é o de status "casado" (h3): com matchGrupoId null → grupo novo
  const d = montarDecisao(preview, CATALOGO_IMPORT, "extrato", () => "G-novo");
  assert.equal(d.casados.length, 1);
  const c = d.casados[0];
  assert.equal(c.matchId, "m1");
  assert.equal(c.grupoExistente, false);
  assert.equal(c.linha.grupo_id, "G-novo");
  assert.equal(c.linha.representante, false);
  assert.equal(c.linha.fonte, "extrato");
  assert.equal(c.linha.linha_hash, "h3");
  assert.equal(c.linha.computa_resumo, true);
  assert.ok(c.linha.categoria_id, "categoria resolvida como um novo (cai na padrão se não houver nome)");
  // com matchGrupoId → reutiliza o grupo e marca grupoExistente
  const p2 = previewFixture();
  p2.itens.find(i => i.status === "casado").matchGrupoId = "G0";
  const d2 = montarDecisao(p2, CATALOGO_IMPORT, "extrato", () => "ignorado");
  assert.equal(d2.casados[0].grupoExistente, true);
  assert.equal(d2.casados[0].linha.grupo_id, "G0");
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
  assert.match(txt, /a agrupar 1/i);
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

// ---------- escolherCandidato (C2: casar à mão um ambíguo com um dos candidatos) ----------
// Cenário do card: linha do extrato de 10/12 com dois lançamentos de mesmo valor (09/12 e 11/12).
// Dados inventados.
function previewAmbiguo() {
  return {
    checksum: { ok: true, diferencaCents: 0, bloqueiaAplicar: false },
    itens: [
      {
        status: "ambiguo", data: "2025-12-10", descricao: "PIX PADARIA", valorCents: 8000,
        natureza: "despesa", linhaHash: "hA", matchId: null, matchGrupoId: null, computaResumo: true,
        categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null,
        candidatos: [
          { id: "m09", data: "2025-12-09", descricao: "padaria", valorCents: 8000, grupo_id: null },
          { id: "m11", data: "2025-12-11", descricao: "padaria", valorCents: 8000, grupo_id: "G11" },
        ],
      },
    ],
  };
}

test("escolherCandidato: escolher um candidato solto transforma o ambíguo em casado, sem grupo ainda", () => {
  const p = previewAmbiguo();
  assert.equal(escolherCandidato(p, 0, "m09"), true);
  const it = p.itens[0];
  assert.equal(it.status, "casado");
  assert.equal(it.matchId, "m09");
  assert.equal(it.matchGrupoId, null); // solto: montarDecisao cria o grupo e ele vira representante
});

test("escolherCandidato: candidato que já está num grupo leva o grupo dele (a linha entra nesse grupo)", () => {
  const p = previewAmbiguo();
  assert.equal(escolherCandidato(p, 0, "m11"), true);
  assert.equal(p.itens[0].matchId, "m11");
  assert.equal(p.itens[0].matchGrupoId, "G11");
});

test("escolherCandidato: recusa candidato já casado com outra linha do lote (spec §6.2) e deixa o item como estava", () => {
  // Sem a recusa, o mesmo lançamento entraria duas vezes em casados com dois grupos novos: o segundo
  // update não pega (grupo_id is null) e a segunda linha do extrato fica num grupo sem representante,
  // sumindo do Resumo sem aviso.
  const p = previewAmbiguo();
  p.itens.push({
    status: "casado", data: "2025-12-09", descricao: "PIX PADARIA 2", valorCents: 8000,
    natureza: "despesa", linhaHash: "hB", matchId: "m09", matchGrupoId: null, computaResumo: true,
    categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null,
  });
  const antes = JSON.stringify(p.itens[0]);
  assert.equal(escolherCandidato(p, 0, "m09"), false);
  assert.equal(JSON.stringify(p.itens[0]), antes);
  // o outro candidato segue livre
  assert.equal(escolherCandidato(p, 0, "m11"), true);
});

test("escolherCandidato: recusa id que não está na lista do item, ou item que não é ambíguo", () => {
  const p = previewAmbiguo();
  assert.equal(escolherCandidato(p, 0, "qualquer"), false);
  assert.equal(p.itens[0].status, "ambiguo");
  escolherCandidato(p, 0, "m09");
  assert.equal(escolherCandidato(p, 0, "m11"), false); // já resolvido: não troca por baixo
  assert.equal(p.itens[0].matchId, "m09");
});

test("montarDecisao após escolherCandidato solto: grupo novo, candidato vira representante, o outro fica intocado", () => {
  const p = previewAmbiguo();
  escolherCandidato(p, 0, "m09");
  const d = montarDecisao(p, CATALOGO_IMPORT, "extrato", () => "G-novo");
  assert.equal(d.casados.length, 1);
  const c = d.casados[0];
  assert.equal(c.matchId, "m09");
  assert.equal(c.grupoExistente, false); // aplicarImportacao põe m09 como representante
  assert.equal(c.linha.grupo_id, "G-novo");
  assert.equal(c.linha.representante, false);
  assert.equal(c.linha.linha_hash, "hA");
  assert.equal(d.novos.length + d.naoGasto.length, 0);
  assert.ok(!JSON.stringify(d).includes("m11"), "o candidato não escolhido não aparece na decisão");
});

test("montarDecisao após escolherCandidato agrupado: entra no grupo existente do candidato", () => {
  const p = previewAmbiguo();
  escolherCandidato(p, 0, "m11");
  const d = montarDecisao(p, CATALOGO_IMPORT, "extrato", () => "nao-usar");
  assert.equal(d.casados[0].matchId, "m11");
  assert.equal(d.casados[0].grupoExistente, true);
  assert.equal(d.casados[0].linha.grupo_id, "G11");
  assert.ok(!JSON.stringify(d).includes("m09"));
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

// ---------- montarMudancas (edição em massa) ----------
test("montarMudancas: '— não mexer —' em tudo → objeto vazio (nada muda)", () => {
  assert.deepEqual(montarMudancas({ categoria: "__nao__", subcategoria: "", pessoa: "__nao__", computa: "__nao__" }), {});
});

test("montarMudancas: categoria seta categoria_id + subcategoria_id", () => {
  assert.deepEqual(
    montarMudancas({ categoria: "c1", subcategoria: "s1", pessoa: "__nao__", computa: "__nao__" }),
    { categoria_id: "c1", subcategoria_id: "s1" });
});

test("montarMudancas: categoria sem sub → subcategoria_id null", () => {
  assert.deepEqual(
    montarMudancas({ categoria: "c1", subcategoria: "", pessoa: "__nao__", computa: "__nao__" }),
    { categoria_id: "c1", subcategoria_id: null });
});

test("montarMudancas: pessoa vazia = limpar (null); id = setar; '__nao__' = não mexe", () => {
  assert.deepEqual(montarMudancas({ categoria: "__nao__", pessoa: "", computa: "__nao__" }), { pessoa_id: null });
  assert.deepEqual(montarMudancas({ categoria: "__nao__", pessoa: "p1", computa: "__nao__" }), { pessoa_id: "p1" });
  assert.deepEqual(montarMudancas({ categoria: "__nao__", pessoa: "__nao__", computa: "__nao__" }), {});
});

test("montarMudancas: fora do resumo mapeia p/ computa_resumo true/false", () => {
  assert.deepEqual(montarMudancas({ categoria: "__nao__", pessoa: "__nao__", computa: "fora" }), { computa_resumo: false });
  assert.deepEqual(montarMudancas({ categoria: "__nao__", pessoa: "__nao__", computa: "incluir" }), { computa_resumo: true });
});

test("montarMudancas: combina categoria + pessoa + fora do resumo", () => {
  assert.deepEqual(
    montarMudancas({ categoria: "c1", subcategoria: "s1", pessoa: "p1", computa: "fora" }),
    { categoria_id: "c1", subcategoria_id: "s1", pessoa_id: "p1", computa_resumo: false });
});

test("acumularDiario: acumula por dia e para em hoje no mês corrente", () => {
  const diario = [{ dia: "2026-09-01", total_cents: 1000 }, { dia: "2026-09-03", total_cents: 500 }];
  const r = acumularDiario(diario, 2026, 9, "2026-09-03");
  assert.equal(r.length, 3);                    // dias 1,2,3 (para em hoje)
  assert.equal(r[0].acum_cents, 1000);
  assert.equal(r[1].acum_cents, 1000);          // dia 2 sem gasto: mantém
  assert.equal(r[2].acum_cents, 1500);          // dia 3 acumula
});

test("acumularDiario: mês fechado (sem hoje) vai até o último dia", () => {
  const r = acumularDiario([{ dia: "2026-06-30", total_cents: 200 }], 2026, 6, null);
  assert.equal(r.length, 30);
  assert.equal(r[29].acum_cents, 200);
});

test("paceOrcamento: reta linear de 0 ao total no último dia", () => {
  const r = paceOrcamento(300000, 2026, 9); // set = 30 dias
  assert.equal(r.length, 30);
  assert.equal(r[29].alvo_cents, 300000);
  assert.equal(r[14].alvo_cents, Math.round(300000 * 15 / 30)); // dia 15
});

test("montarDecisao: item sem categoria cai na categoria padrão (flag), não em Outros", () => {
  // "Outros" agora é miscelânea deliberada; o que o import não classifica vai pra triagem (padrão).
  const catalogo = {
    categorias: [{ id: "cOut", nome: "Outros" }, { id: "cNI", nome: "Não Identificado", padrao: true }],
    subcategorias: [],
  };
  const preview = {
    checksum: { ok: true, diferencaCents: 0 }, resumo: { novos: 1 },
    itens: [{ status: "novo", data: "2026-03-01", natureza: "despesa", valorCents: 1000, descricao: "x",
              linhaHash: "h1", matchId: null, computaResumo: true, categoriaNome: null, subNome: null,
              categoriaOrg: null, contraparteNome: null }],
  };
  const d = montarDecisao(preview, catalogo, "extrato");
  assert.equal(d.novos[0].categoria_id, "cNI");
});

// ---------- Inc 4.6: montarLinhas / filtrarLinhas ----------
// rows já vêm ordenadas por data desc do servidor; o grupo aparece na posição do representante.
const R = [
  { id: "a", data: "2026-09-30", descricao: "PIX ALUGUEL", contraparte_nome: null, categoria: "Casa", pessoa: null, pessoa_id: null, origem_categoria: "regra", computa_resumo: true, grupo_id: "G1", representante: false, valor_final: "2500.00", fonte: "extrato" },
  { id: "b", data: "2026-09-15", descricao: "Cinema", contraparte_nome: null, categoria: "Lazer", pessoa: "Caio", pessoa_id: 1, origem_categoria: "manual", computa_resumo: true, grupo_id: null, representante: false, valor_final: "60.00", fonte: "manual" },
  { id: "c", data: "2026-09-02", descricao: "Aluguel", contraparte_nome: "Imobiliária X", categoria: "Casa", pessoa: "Casa", pessoa_id: 5, origem_categoria: "manual", computa_resumo: true, grupo_id: "G1", representante: true, valor_final: "2500.00", fonte: "manual" },
];

test("montarLinhas: grupo vira uma linha na posição do representante, com os membros dentro", () => {
  const L = montarLinhas(R);
  assert.deepEqual(L.map((l) => l.t.id), ["b", "c"]);       // "a" (membro) não vira linha própria
  const g = L.find((l) => l.grupo_id === "G1");
  assert.deepEqual(g.membros.map((m) => m.id), ["a"]);
  assert.equal(g.diferem, false);
  assert.equal(g.orfao, false);
});

test("montarLinhas: valores diferentes marcam diferem", () => {
  const rows = R.map((r) => (r.id === "a" ? { ...r, valor_final: "56200.00" } : r));
  assert.equal(montarLinhas(rows).find((l) => l.grupo_id === "G1").diferem, true);
});

test("montarLinhas: membros órfãos (representante fora do período carregado) viram linhas soltas", () => {
  const semRep = R.filter((r) => r.id !== "c"); // o representante ficou fora da janela
  const L = montarLinhas(semRep);
  assert.deepEqual(L.map((l) => l.t.id), ["a", "b"]); // nada some da tela
  assert.equal(L[0].orfao, true);
  assert.deepEqual(L[0].membros, []);
});

test("filtrarLinhas: dimensões pelo representante; texto acha o grupo por membro; 'agrupados' lista só grupos", () => {
  const L = montarLinhas(R);
  assert.deepEqual(filtrarLinhas(L, { categoria: "Casa" }).map((l) => l.t.id), ["c"]);
  assert.deepEqual(filtrarLinhas(L, { texto: "pix aluguel" }).map((l) => l.t.id), ["c"]); // bateu no membro "a"
  assert.deepEqual(filtrarLinhas(L, { texto: "cinema" }).map((l) => l.t.id), ["b"]);
  assert.deepEqual(filtrarLinhas(L, { computa: "agrupados" }).map((l) => l.t.id), ["c"]);
  assert.deepEqual(filtrarLinhas(L, { computa: "gasto" }).map((l) => l.t.id), ["b", "c"]);
});

// Fase B: grupo pode ligar transações de meses diferentes (ex.: lançamento manual em 29/09
// casado com a linha do extrato em 01/10). GET /api/transacoes só traz o mês selecionado — o
// representante chega sozinho, sem nenhum outro membro carregado. Antes desta correção isso
// virava uma linha "solta" (sem selo, sem ⛓ desagrupar) e sumia do filtro "Só agrupados".
const REP_SEM_MEMBROS = { id: "d", data: "2026-09-29", descricao: "Escola", contraparte_nome: null, categoria: "Educação", pessoa: null, pessoa_id: null, origem_categoria: "manual", computa_resumo: true, grupo_id: "G2", representante: true, valor_final: "500.00", fonte: "manual" };

test("montarLinhas: representante carregado sem seus membros (fora do período) ainda vira linha de grupo", () => {
  const L = montarLinhas([REP_SEM_MEMBROS, R[1]]); // R[1] = "b", transação solta
  const g = L.find((l) => l.t.id === "d");
  assert.equal(g.membrosFora, true);
  assert.deepEqual(g.membros, []);
  assert.equal(g.orfao, false);
  assert.equal(g.grupo_id, "G2");
  const solta = L.find((l) => l.t.id === "b");
  assert.equal(solta.membrosFora, false); // linha solta nunca tem membrosFora
});

test("filtrarLinhas: computa='agrupados' inclui grupo cujos membros estão fora do período (membrosFora)", () => {
  const L = montarLinhas([REP_SEM_MEMBROS, R[1]]);
  assert.deepEqual(filtrarLinhas(L, { computa: "agrupados" }).map((l) => l.t.id), ["d"]);
});

// ---- F4: membro órfão é só leitura ----
// Exemplo do card (valores inventados): grupo com um lançamento manual de 30/09 e a linha do
// extrato de 02/10; o representante passou a ser a do extrato. Em setembro o manual chega sem o
// representante (órfão); em outubro o representante chega sem o membro (membrosFora).
const MANUAL_30_09 = { id: "m1", data: "2026-09-30", descricao: "Mercado", categoria: "Casa", pessoa: null, pessoa_id: null, origem_categoria: "manual", computa_resumo: true, grupo_id: "G3", representante: false, valor_final: "120.00", fonte: "manual" };
const EXTRATO_02_10 = { ...MANUAL_30_09, id: "e1", data: "2026-10-02", descricao: "PIX MERCADO", representante: true, fonte: "extrato" };

test("linhaEditavel: membro órfão não é editável — editar não teria efeito (quem conta é o representante)", () => {
  const [orfao] = montarLinhas([MANUAL_30_09]); // setembro
  assert.equal(orfao.orfao, true);
  assert.equal(linhaEditavel(orfao), false);
});

test("linhaEditavel: linha solta e representante seguem editáveis, inclusive o de membrosFora", () => {
  const L = montarLinhas(R); // "b" solta, "c" representante com o membro "a"
  assert.equal(linhaEditavel(L.find((l) => l.t.id === "b")), true);
  assert.equal(linhaEditavel(L.find((l) => l.t.id === "c")), true);
  const [rep] = montarLinhas([EXTRATO_02_10]); // outubro: só o representante na janela
  assert.equal(rep.membrosFora, true);
  assert.equal(linhaEditavel(rep), true); // ele conta, então editar tem efeito
});

test("idsSelecionaveis: o 'selecionar todos' e a barra de massa não alcançam o órfão", () => {
  const rows = [R[1], R[2], R[0], MANUAL_30_09]; // solta "b", representante "c" com membro "a", órfão "m1"
  const L = montarLinhas(rows);
  assert.deepEqual(L.map((l) => l.t.id), ["b", "c", "m1"]);
  assert.deepEqual(idsSelecionaveis(L), ["b", "c"]);
});

// ---- B2: painel de regras aprendidas ----
test("mascararChave: pix_cpf mostra só os 4 últimos (a chave é Pix/CPF); nome aparece inteiro", () => {
  // 13 caracteres, o menor comprimento de pix_cpf visto no banco: a máscara ainda esconde 9
  assert.equal(mascararChave("5500000001234", "pix_cpf"), "••••1234");
  assert.equal(mascararChave("12345678901", "pix_cpf"), "••••8901");
  assert.equal(mascararChave("PADARIA EXEMPLO", "nome"), "PADARIA EXEMPLO");
});

test("filtrarAssociacoes: busca sem caixa nem acento na chave exibida, categoria e sub", () => {
  const lista = [
    { chave: "PADARIA EXEMPLO", tipo_chave: "nome", categoria: "Alimentação", subcategoria: "Padaria" },
    { chave: "5500000001234", tipo_chave: "pix_cpf", categoria: "Educação", subcategoria: "Inglês" },
    { chave: "LOJA TESTE", tipo_chave: "nome", categoria: "Compras", subcategoria: null },
  ];
  const chaves = (r) => r.map((a) => a.chave);
  assert.deepEqual(chaves(filtrarAssociacoes(lista, "padaria")), ["PADARIA EXEMPLO"]);
  assert.deepEqual(chaves(filtrarAssociacoes(lista, "ALIMENTACAO")), ["PADARIA EXEMPLO"]); // sem acento
  assert.deepEqual(chaves(filtrarAssociacoes(lista, "ingles")), ["5500000001234"]);      // pela sub
  assert.deepEqual(chaves(filtrarAssociacoes(lista, "compras")), ["LOJA TESTE"]);
  assert.deepEqual(chaves(filtrarAssociacoes(lista, "1234")), ["5500000001234"]);         // parte visível
  // o miolo mascarado da chave Pix não pode ser achado pela busca (não está na tela)
  assert.deepEqual(chaves(filtrarAssociacoes(lista, "550000")), []);
  assert.equal(filtrarAssociacoes(lista, "  ").length, 3);
  assert.equal(filtrarAssociacoes(lista, "").length, 3);
});

test("B2: associação removida → o import da linha cai na categoria padrão, com origem 'modelo'", () => {
  // montarPreviewExtrato devolve categoriaNome null; quem resolve para a padrão é montarDecisao
  const TXT = `10/12/2025 SALDO DO DIA 8.876,46
10/12/2025 PADARIA EXEMPLO -100,00
09/12/2025 SALDO DO DIA 8.976,46`;
  const catalogo = {
    categorias: [
      { id: "cAli", nome: "Alimentação" }, { id: "cComp", nome: "Compras" },
      { id: "cOut", nome: "Outros" }, { id: "cNI", nome: "Não Identificado", padrao: true },
    ],
    subcategorias: [],
  };
  const preview = montarPreviewExtrato(TXT, "c1", { catalogo, associacoes: {}, existentes: [], hashes: [] });
  const d = montarDecisao(preview, catalogo, "extrato");
  assert.equal(d.novos.length, 1);
  assert.equal(d.novos[0].categoria_id, "cNI");
  assert.equal(d.novos[0].origem_categoria, "modelo");
  // e com a regra trocada para Compras, o mesmo import entra em Compras (origem 'regra')
  const p2 = montarPreviewExtrato(TXT, "c1", {
    catalogo, associacoes: { "PADARIA EXEMPLO": { categoriaNome: "Compras" } }, existentes: [], hashes: [],
  });
  const d2 = montarDecisao(p2, catalogo, "extrato");
  assert.equal(d2.novos[0].categoria_id, "cComp");
  assert.equal(d2.novos[0].origem_categoria, "regra");
});
