import { test } from "node:test";
import assert from "node:assert/strict";
import {
  centavosBR, kf, deltaPct, rangeDoMes, construirCascata, subsDaCat,
  anelPessoaCategoria, filtrarTransacoes, montarDecisao, podeAplicar, resumoTexto, montarMudancas,
  acumularDiario, paceOrcamento, montarLinhas, filtrarLinhas, mascararChave, filtrarAssociacoes,
  escolherCandidato, rotuloCandidato, linhaEditavel, idsSelecionaveis, esc,
  TIPOS_IMPORT, fonteDoTipo, corpoPreview,
  rotuloEstadoFechamento, mesDoFechamento, mesesAte as mesesAteApp, calendarioRotinas, acaoCelula, ESTADOS_CELULA,
  markdownSimples, avisoMesParcial, htmlDiagnostico, AVISO_MES_PARCIAL, SEM_DIAGNOSTICO,
  montarTelaPatrimonio, htmlPatrimonio, reaisDeCents, rotuloRendimentoApp, SEM_PATRIMONIO,
  parseBRtoCents, corpoParamCasa, montarTelaCasa, htmlCasa, SEM_FOTO_CASA,
  lotesSugestao, aplicarSugestoes, jevPreenche, seloJev, celulaCategoriaImport, avisoJevHtml, AVISO_JEV,
  consultaArquivoImport, aplicarEGuardarArquivo, AVISO_ARQUIVO_NAO_GUARDADO,
  linhasAnoVsAnterior, subtituloAnoVsAnterior, htmlAnoVsAnterior, SEM_COMPARACAO,
  pendentesTriagem, consultaTriagem, lotesAoAbrirTriagem, loteSugerirMais, LOTE_TRIAGEM, parseLimiar,
  textoSugestao, celulaSugestao, resolverSugestao, guardarSugestoesTriagem, planoAceitarTodas,
} from "../public/app.js";
import { montarCasa } from "../worker/casa.js";
import { mesesAte } from "../worker/salario.js";
import { montarPreviewExtrato } from "../worker/importar.js";
import { reconstruirTexto, abrirPdf } from "../public/pdf_extrair.js";
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

// A3: o waterfall do Resumo é a cascata do mês (valores do Exemplo, inventados, em centavos):
// salário 40.000 − empresa 3.000 = disponível 37.000; + 1.000 de outras receitas − pessoais
// (20.000 + 5.000) = saldo 13.000, o mesmo do card "Saldo do mês".
const CASCATA_EX = {
  salario_cents: 4000000, despesa_empresa_cents: 300000, disponivel_cents: 3700000,
  outras_receitas_cents: 100000, despesa_pessoal_cents: 2500000, saldo_cents: 1300000, estimado: false,
  pessoais: [{ macro: "Casa", total_cents: 2000000 }, { macro: "Lazer", total_cents: 500000 }],
};

test("construirCascata monta salário → empresa → disponível → outras receitas → pessoais → saldo com lo/hi acumulados", () => {
  assert.deepEqual(construirCascata(CASCATA_EX), [
    { nm: "Salário (PJ)", tipo: "receita", lo: 0, hi: 4000000 },
    { nm: "− Empresa", tipo: "despesa", lo: 3700000, hi: 4000000 },
    { nm: "= Disponível para a casa", tipo: "subtotal", lo: 0, hi: 3700000 },
    { nm: "+ Outras receitas", tipo: "receita", lo: 3700000, hi: 3800000 },
    { nm: "Casa", tipo: "despesa", lo: 1800000, hi: 3800000 },
    { nm: "Lazer", tipo: "despesa", lo: 1300000, hi: 1800000 },
    { nm: "= Saldo do mês", tipo: "saldo", lo: 0, hi: 1300000 },
  ]);
});

test("construirCascata: o último degrau vale cascata.saldo_cents", () => {
  const steps = construirCascata(CASCATA_EX);
  assert.equal(steps.at(-1).hi - steps.at(-1).lo, CASCATA_EX.saldo_cents);
});

test("construirCascata: mês sem salário desenha 0 no primeiro degrau e o resto segue (negativo vira piso)", () => {
  const c = { ...CASCATA_EX, salario_cents: 0, disponivel_cents: -300000, saldo_cents: -2700000 };
  const steps = construirCascata(c);
  assert.deepEqual(steps[0], { nm: "Salário (PJ)", tipo: "receita", lo: 0, hi: 0 });
  assert.deepEqual(steps[1], { nm: "− Empresa", tipo: "despesa", lo: -300000, hi: 0 });
  assert.deepEqual(steps[2], { nm: "= Disponível para a casa", tipo: "subtotal", lo: -300000, hi: 0 });
  assert.deepEqual(steps.at(-1), { nm: "= Saldo do mês", tipo: "saldo", lo: -2700000, hi: 0 });
  assert.ok(steps.every(s => Number.isInteger(s.lo) && Number.isInteger(s.hi)), "centavos inteiros, nada de NaN");
});

test("construirCascata: se os grupos pessoais não fecham com despesa_pessoal_cents, a diferença vira degrau próprio (o saldo nunca mente)", () => {
  const c = { ...CASCATA_EX, pessoais: [{ macro: "Casa", total_cents: 2000000 }] };
  const steps = construirCascata(c);
  assert.deepEqual(steps.at(-2), { nm: "Outras despesas", tipo: "despesa", lo: 1300000, hi: 1800000 });
  assert.deepEqual(steps.at(-1), { nm: "= Saldo do mês", tipo: "saldo", lo: 0, hi: 1300000 });
});

test("construirCascata: sem cascata (resumo sem mes=) não há degraus", () => {
  assert.deepEqual(construirCascata(null), []);
});

test("anelPessoaCategoria dobra porPessoaCategoria em pessoa → categorias, e o anel interno fecha com a despesa do mês", () => {
  // Exemplo do D6 (números inventados): Lucca 250,00 + 50,00; despesa sem pessoa_id 700,00.
  // O anel interno precisa somar o mesmo que kpis.despesa — senão o gráfico mente sobre o mês.
  const rows = [
    { pessoa: "sem pessoa", categoria: "Alimentação", total_cents: 70000 },
    { pessoa: "Lucca", categoria: "Educação", total_cents: 25000 },
    { pessoa: "Lucca", categoria: "Lazer", total_cents: 5000 },
  ];
  const kpis = { despesa: "1000.00" }; // como a API devolve: reais, string
  const anel = anelPessoaCategoria(rows);
  const somaInterno = anel.reduce((a, p) => a + p.total_cents, 0);
  assert.equal(somaInterno, 100000);
  assert.equal(somaInterno, Math.round(parseFloat(kpis.despesa) * 100));
  // a fatia "sem pessoa" é visível (Decisão 2026-09-28), mesmo sendo a maior
  assert.ok(anel.some(p => p.pessoa === "sem pessoa"));
  assert.deepEqual(anel, [
    { pessoa: "sem pessoa", total_cents: 70000, categorias: [{ categoria: "Alimentação", total_cents: 70000 }] },
    { pessoa: "Lucca", total_cents: 30000, categorias: [
      { categoria: "Educação", total_cents: 25000 }, { categoria: "Lazer", total_cents: 5000 },
    ] },
  ]);
});

test("anelPessoaCategoria soma em centavos inteiros mesmo quando o driver devolve string", () => {
  // ::bigint chega como string do Neon; somar string concatenaria ("100" + "50" = "10050").
  const anel = anelPessoaCategoria([
    { pessoa: "Ana", categoria: "Casa", total_cents: "100" },
    { pessoa: "Ana", categoria: "Casa", total_cents: "50" },
  ]);
  assert.deepEqual(anel, [{ pessoa: "Ana", total_cents: 150, categorias: [{ categoria: "Casa", total_cents: 150 }] }]);
  assert.deepEqual(anelPessoaCategoria([]), []);
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

// ---------- F1: candidato-grupo (foto + manual agrupados contam como um só) ----------
// Caso misto do card, com dados inventados: grupo "padaria" (2 lançamentos) + "mercado" solto.
function previewMisto() {
  return {
    checksum: { ok: true, diferencaCents: 0, bloqueiaAplicar: false },
    itens: [
      {
        status: "ambiguo", data: "2025-12-11", descricao: "PIX PADARIA", valorCents: 8000,
        natureza: "despesa", linhaHash: "hA", matchId: null, matchGrupoId: null, computaResumo: true,
        categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null,
        candidatos: [
          { id: "foto", data: "2025-12-09", descricao: "padaria", valorCents: 8000, grupo_id: "G1", membros: 2 },
          { id: "mercado", data: "2025-12-10", descricao: "mercado", valorCents: 8000, grupo_id: null },
        ],
      },
    ],
  };
}

test("rotuloCandidato: o grupo aparece como 'grupo: <descrição> (N lançamentos)'; o solto, como antes", () => {
  const [g, s] = previewMisto().itens[0].candidatos;
  assert.equal(rotuloCandidato(g), "grupo: padaria (2 lançamentos)");
  assert.equal(rotuloCandidato(s), "10/12/2025 · mercado · R$ 80,00");
});

test("escolherCandidato no candidato-grupo casa a linha nesse grupo e a decisão não troca o representante", () => {
  const p = previewMisto();
  assert.equal(escolherCandidato(p, 0, "foto"), true);
  assert.equal(p.itens[0].status, "casado");
  assert.equal(p.itens[0].matchGrupoId, "G1");
  const d = montarDecisao(p, CATALOGO_IMPORT, "extrato", () => "nao-usar");
  // grupoExistente: aplicarImportacao só insere a linha do extrato no grupo; quem conta segue quem era
  assert.equal(d.casados[0].grupoExistente, true);
  assert.equal(d.casados[0].linha.grupo_id, "G1");
  assert.equal(d.casados[0].linha.representante, false);
});

test("escolherCandidato recusa o grupo (por qualquer membro) quando outra linha do lote já casou nele", () => {
  // Sem a recusa, duas linhas do extrato entrariam no mesmo grupo e a segunda despesa sumiria do Resumo.
  const p = previewMisto();
  p.itens.push({
    status: "casado", data: "2025-12-10", descricao: "PIX PADARIA 2", valorCents: 8000,
    natureza: "despesa", linhaHash: "hB", matchId: "manual", matchGrupoId: "G1", computaResumo: true,
    categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null,
  });
  const antes = JSON.stringify(p.itens[0]);
  assert.equal(escolherCandidato(p, 0, "foto"), false);
  assert.equal(JSON.stringify(p.itens[0]), antes);
  assert.equal(escolherCandidato(p, 0, "mercado"), true); // o solto segue livre
});

test("F1 ponta a ponta: preview do Exemplo → o grupo vem uma vez e o botão diz 'grupo: padaria (2 lançamentos)'", () => {
  const txt = `12/12/2025 SALDO DO DIA 920,00
11/12/2025 PIX PADARIA -80,00
10/12/2025 SALDO DO DIA 1.000,00`;
  const existentes = [
    { id: "foto", data: "2025-12-09", descricao: "padaria", valorCents: 8000, grupo_id: "G1", representante: true },
    { id: "manual", data: "2025-12-09", descricao: "padaria", valorCents: 8000, grupo_id: "G1", representante: false },
  ];
  const so = montarPreviewExtrato(txt, "c1", { catalogo: CATALOGO_IMPORT, associacoes: {}, existentes, hashes: [] });
  const casado = so.itens.find(i => i.status === "casado");
  assert.equal(casado.matchGrupoId, "G1"); // sem ambíguo
  const misto = montarPreviewExtrato(txt, "c1", {
    catalogo: CATALOGO_IMPORT, associacoes: {},
    existentes: [...existentes, { id: "mercado", data: "2025-12-10", descricao: "mercado", valorCents: 8000, grupo_id: null }],
    hashes: [],
  });
  const amb = misto.itens.find(i => i.status === "ambiguo");
  assert.deepEqual(amb.candidatos.map(rotuloCandidato), ["grupo: padaria (2 lançamentos)", "10/12/2025 · mercado · R$ 80,00"]);
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

// esc() é a única barreira entre texto vindo do banco/modelo e o innerHTML da tela:
// se ela deixar passar < ou >, uma descrição maliciosa vira script rodando no app.
test("esc neutraliza tag de script", () => {
  assert.equal(esc("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("esc neutraliza img com onerror", () => {
  assert.equal(esc("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
});

test("esc escapa & e aspas (atributos entre aspas não podem ser fechados)", () => {
  assert.equal(esc(`a & "b" 'c'`), "a &amp; &quot;b&quot; &#39;c&#39;");
});

test("esc devolve string vazia para null/undefined (campo opcional não vira 'null' na tela)", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

test("esc no exemplo do card: descrição de padaria com img injetada", () => {
  assert.equal(esc("Padaria <img src=x onerror=alert(1)>"), "Padaria &lt;img src=x onerror=alert(1)&gt;");
});

// ---- C1: extrato do C6 Bank na aba Importar ----
test("C1: a aba Importar oferece 'Extrato C6 Bank', que manda tipo e conta 'c6' ao preview", () => {
  const c6 = TIPOS_IMPORT.find((t) => t.valor === "c6");
  assert.equal(c6.rotulo, "Extrato C6 Bank");
  assert.deepEqual(corpoPreview("c6", "txt", { conta: "itau" }), { tipo: "c6", texto: "txt", conta: "c6" });
  // os outros tipos seguem como antes
  assert.deepEqual(corpoPreview("extrato", "txt", { conta: "itau" }), { tipo: "extrato", texto: "txt", conta: "itau" });
  assert.deepEqual(corpoPreview("fatura", "txt", { ano: 2031, mes: 9 }), { tipo: "fatura", texto: "txt", ano: 2031, mes: 9 });
});

test("C1: a linha do C6 grava fonte 'extrato' (vocabulário fechado: não existe fonte 'c6')", () => {
  assert.equal(fonteDoTipo("c6"), "extrato");
  assert.equal(fonteDoTipo("extrato"), "extrato");
  assert.equal(fonteDoTipo("fatura"), "fatura");
  const preview = { itens: [{ status: "novo", data: "2031-09-10", natureza: "receita", valorCents: 100, descricao: "x", computaResumo: true, linhaHash: "h" }] };
  const d = montarDecisao(preview, { categorias: [{ id: "p", nome: "Não Identificado", padrao: true }], subcategorias: [] }, fonteDoTipo("c6"));
  assert.equal(d.novos[0].fonte, "extrato");
});

// pdf.js falso: só abre com a senha certa; lança PasswordException como o de verdade.
const SENHA_PDF = "senha-ficticia";
function pdfjsFalso() {
  const chamadas = [];
  return {
    chamadas,
    getDocument(opts) {
      chamadas.push(opts);
      if (opts.password === SENHA_PDF) return { promise: Promise.resolve({ numPages: 1 }) };
      const err = new Error(opts.password ? "Incorrect Password" : "No password given");
      err.name = "PasswordException";
      err.code = opts.password ? 2 : 1;
      return { promise: Promise.reject(err) };
    },
  };
}
// localStorage/cookie "armados": qualquer tentativa de guardar a senha estoura o teste.
function semPersistencia(fn) {
  const antes = { ls: globalThis.localStorage };
  globalThis.localStorage = { setItem: () => { throw new Error("guardou em localStorage"); } };
  return fn().finally(() => { globalThis.localStorage = antes.ls; });
}

test("C1: abrirPdf abre com a senha do secret, passando {data, password} ao getDocument", async () => {
  const lib = pdfjsFalso();
  const pdf = await semPersistencia(() => abrirPdf(lib, new Uint8Array([1, 2, 3]), { senha: SENHA_PDF }));
  assert.equal(pdf.numPages, 1);
  assert.equal(lib.chamadas.length, 1);
  assert.equal(lib.chamadas[0].password, SENHA_PDF);
  assert.deepEqual([...lib.chamadas[0].data], [1, 2, 3]);
});

test("C1: senha do secret errada → pede no campo e abre com a digitada (cada tentativa com cópia dos bytes)", async () => {
  const lib = pdfjsFalso();
  const motivos = [];
  const pdf = await semPersistencia(() => abrirPdf(lib, new Uint8Array([9]), {
    senha: "errada", pedirSenha: async (m) => { motivos.push(m); return SENHA_PDF; },
  }));
  assert.equal(pdf.numPages, 1);
  assert.equal(motivos.length, 1);
  assert.match(motivos[0], /não abriu/);
  assert.notEqual(lib.chamadas[0].data, lib.chamadas[1].data, "o pdf.js transfere o buffer; a 2ª tentativa precisa de outro");
});

test("C1: sem senha do secret → pede no campo; desistir dá erro que não contém a senha tentada", async () => {
  const lib = pdfjsFalso();
  let pedidos = 0;
  const pdfSemSecret = await abrirPdf(lib, new Uint8Array([1]), { senha: null, pedirSenha: async () => { pedidos++; return SENHA_PDF; } });
  assert.equal(pdfSemSecret.numPages, 1);
  assert.equal(pedidos, 1);
  assert.equal(lib.chamadas[0].password, undefined, "sem secret, a 1ª tentativa vai sem senha");

  const lib2 = pdfjsFalso();
  await assert.rejects(
    () => semPersistencia(() => abrirPdf(lib2, new Uint8Array([1]), { senha: "errada-do-secret", pedirSenha: async () => null })),
    (err) => !err.message.includes("errada-do-secret") && /Não abriu o PDF/.test(err.message),
  );
});

test("C1: erro do pdf.js que não é de senha sobe como está (não vira pedido de senha)", async () => {
  const lib = { getDocument: () => ({ promise: Promise.reject(new Error("PDF corrompido")) }) };
  let pediu = false;
  await assert.rejects(() => abrirPdf(lib, new Uint8Array([1]), { pedirSenha: async () => { pediu = true; return "x"; } }), /corrompido/);
  assert.equal(pediu, false);
});

// ---- G1: saldo do mês (salário por competência) e Wise na aba Importar ----
import { leituraDoTipo, montarSaldoMes } from "../public/app.js";

test("G1: a aba Importar oferece 'Wise (CSV da conta em USD)', lido como texto (sem pdf.js), e manda só {tipo, texto}", () => {
  const w = TIPOS_IMPORT.find((t) => t.valor === "wise");
  assert.equal(w.rotulo, "Wise (CSV da conta em USD)");
  assert.equal(leituraDoTipo("wise"), "csv");
  assert.equal(leituraDoTipo("extrato"), "pdf");
  assert.equal(leituraDoTipo("c6"), "pdf");
  assert.equal(leituraDoTipo("fatura"), "pdf");
  assert.deepEqual(corpoPreview("wise", "id,x\n1,2", { conta: "itau" }), { tipo: "wise", texto: "id,x\n1,2" });
});

test("G1 montarSaldoMes: Exemplo do card — receita 40.600 (salário já somado em kpis.receita), despesa 38.000 → saldo +2.600 em centavos", () => {
  const s = montarSaldoMes({ receita: "40600.00", despesa: "38000.00" }, { brl_cents: 4060000, estimado: false });
  assert.deepEqual(s, { receita_cents: 4060000, despesa_cents: 3800000, saldo_cents: 260000, estimado: false });
});

test("G1 montarSaldoMes: o selo 'estimado' segue salario.estimado; sem salário (antes do parâmetro) não há selo", () => {
  assert.equal(montarSaldoMes({ receita: "41600.00", despesa: "0.00" }, { brl_cents: 4160000, estimado: true }).estimado, true);
  assert.equal(montarSaldoMes({ receita: "100.00", despesa: "0.00" }, null).estimado, false);
  assert.equal(montarSaldoMes({}, { estimado: false }).saldo_cents, 0);
});

// ---------- G2: fechamento do mês (bloco no topo do Resumo) ----------
// Formato de um mês como /api/fechamento devolve (datas inventadas).
const mesFech = (over = {}) => ({
  mes: "2031-09", estado: "parcial", sem_categoria: 3,
  fontes: {
    itau: { ate: "2031-09-30", cobertura: "cheia" },
    c6: { ate: "2031-09-28", cobertura: "parcial" },
    fatura: { existe: false, cobertura: "faltando" },
    salario: { ate: "2031-08-20", estimado: true },
  },
  ...over,
});

test("G2 rotuloEstadoFechamento: os três estados com rótulo legível; desconhecido não quebra", () => {
  assert.equal(rotuloEstadoFechamento("fechado"), "fechado");
  assert.equal(rotuloEstadoFechamento("parcial"), "parcial");
  assert.equal(rotuloEstadoFechamento("faltando"), "faltando");
  assert.equal(rotuloEstadoFechamento("x"), "—");
});

test("G2 mesDoFechamento acha o mês selecionado na resposta (o último dos 12)", () => {
  const r = { meses: [mesFech({ mes: "2031-08" }), mesFech()] };
  assert.equal(mesDoFechamento(r, "2031-09").mes, "2031-09");
  assert.equal(mesDoFechamento(r, "2030-01"), null);
  assert.equal(mesDoFechamento(null, "2031-09"), null);
});

// ---------- G6: calendário das rotinas (grade sempre aberta no topo do Resumo) ----------
// Resposta inventada de /api/fechamento no formato do G6: o mês corrente é outubro/2031.
const mesRot = (mes, over = {}) => ({
  mes, estado: "fechado", sem_categoria: 0, transacoes: 50, diagnostico: false, salario_brl_cents: 100,
  fontes: {
    itau: { ate: `${mes}-30`, cobertura: "cheia" }, c6: { ate: `${mes}-30`, cobertura: "cheia" },
    fatura: { existe: true, cobertura: "cheia" }, salario: { ate: null, estimado: false },
  },
  patrimonio: [
    { conta: "itau", pessoa: "Bia", tem_print: false }, { conta: "c6", pessoa: "Ana", tem_print: false },
  ],
  ...over,
});
const respRot = (meses, over = {}) => ({ ate: meses[meses.length - 1].mes, mes_corrente: "2031-10", primeiro_print: "2031-10", meses, ...over });
const linhaRot = (cal, id) => cal.linhas.find((l) => l.id === id);
const celRot = (cal, id, mes) => linhaRot(cal, id).celulas.find((c) => c.mes === mes);

test("G6 mesesAte do app: 12 meses terminando no mês pedido, atravessando o ano", () => {
  const ms = mesesAteApp("2031-02");
  assert.equal(ms.length, 12);
  assert.equal(ms[0], "2030-03");
  assert.equal(ms[11], "2031-02");
});

test("G6 calendarioRotinas: 12 colunas terminando no mês pedido, mesmo com a resposta mais curta", () => {
  const cal = calendarioRotinas(respRot([mesRot("2031-09"), mesRot("2031-10")]), "2031-10");
  assert.equal(cal.colunas.length, 12);
  assert.equal(cal.colunas[11], "2031-10");
  assert.equal(cal.colunas[0], "2030-11");
  // mês sem dado na resposta: cinza, não vira "falta" inventado
  assert.equal(celRot(cal, "itau", "2030-11").estado, "nao_se_aplica");
  assert.ok(cal.linhas.every((l) => l.celulas.length === 12));
});

test("G6 linhas na ordem: Itaú extrato, Itaú fatura, C6 extrato, Salário, um print por conta, Triagem, Diagnóstico", () => {
  const patrimonio = ["itau/Bia", "c6/Ana", "nubank/Ana", "mercadopago/Ana", "fgts/Bia"]
    .map((x) => ({ conta: x.split("/")[0], pessoa: x.split("/")[1], tem_print: false }));
  const cal = calendarioRotinas(respRot([mesRot("2031-10", { patrimonio })]), "2031-10");
  assert.deepEqual(cal.linhas.map((l) => l.rotulo), [
    "Itaú extrato", "Itaú fatura", "C6 extrato", "Salário (Wise)",
    "Print Itaú/Bia", "Print C6/Ana", "Print Nubank/Ana", "Print Mercado Pago/Ana", "Print FGTS/Bia",
    "Triagem", "Diagnóstico",
  ]);
  assert.equal(cal.linhas.filter((l) => l.id.startsWith("print:")).length, 5);
});

test("G6 contas só com print fora da janela continuam sendo linha (a API manda a lista do histórico inteiro)", () => {
  // nenhuma conta tem print nos meses da janela; primeiro print bem antes dela
  const cal = calendarioRotinas(respRot([mesRot("2031-09"), mesRot("2031-10")], { primeiro_print: "2029-01" }), "2031-10");
  assert.deepEqual(cal.linhas.filter((l) => l.id.startsWith("print:")).map((l) => l.rotulo), ["Print Itaú/Bia", "Print C6/Ana"]);
  // e o mês sem print, depois do primeiro, é falta (não cinza)
  assert.equal(celRot(cal, "print:itau/Bia", "2031-09").estado, "falta");
});

test("G6 quatro estados fixos, cada célula com title não vazio", () => {
  assert.deepEqual(ESTADOS_CELULA, ["feito", "parcial", "falta", "nao_se_aplica"]);
  const cal = calendarioRotinas(respRot([mesRot("2031-09"), mesRot("2031-10", { estado: "parcial" })]), "2031-10");
  for (const l of cal.linhas) for (const c of l.celulas) {
    assert.ok(ESTADOS_CELULA.includes(c.estado), `${l.id} ${c.mes}`);
    assert.ok(c.title && c.title.trim(), `${l.id} ${c.mes}`);
  }
});

test("G6 extrato: cheia → feito, parcial → parcial, faltando → falta; o mês corrente nunca passa de parcial", () => {
  const f = (itau, c6) => ({ ...mesRot("x").fontes, itau, c6 });
  const cal = calendarioRotinas(respRot([
    mesRot("2031-07", { fontes: f({ ate: "2031-07-31", cobertura: "cheia" }, { ate: null, cobertura: "faltando" }) }),
    mesRot("2031-08", { fontes: f({ ate: "2031-08-13", cobertura: "parcial" }, { ate: "2031-08-31", cobertura: "cheia" }) }),
    mesRot("2031-10", { fontes: f({ ate: "2031-10-31", cobertura: "cheia" }, { ate: "2031-10-13", cobertura: "parcial" }) }),
  ]), "2031-10");
  assert.equal(celRot(cal, "itau", "2031-07").estado, "feito");
  assert.equal(celRot(cal, "c6", "2031-07").estado, "falta");
  assert.equal(celRot(cal, "itau", "2031-08").estado, "parcial");
  assert.equal(celRot(cal, "c6", "2031-08").estado, "feito");
  assert.equal(celRot(cal, "itau", "2031-10").estado, "parcial"); // cheia, mas outubro não acabou
  assert.equal(celRot(cal, "c6", "2031-10").estado, "parcial");
});

test("G6 fatura: existe → feito, senão falta", () => {
  const sem = { ...mesRot("x").fontes, fatura: { existe: false, cobertura: "faltando" } };
  const cal = calendarioRotinas(respRot([mesRot("2031-09"), mesRot("2031-10", { fontes: sem })]), "2031-10");
  assert.equal(celRot(cal, "fatura", "2031-09").estado, "feito");
  assert.equal(celRot(cal, "fatura", "2031-10").estado, "falta");
});

test("G6 salário: conversão real → feito, estimado → parcial, sem nem estimativa → falta", () => {
  const sal = (estimado) => ({ ...mesRot("x").fontes, salario: { ate: null, estimado } });
  const cal = calendarioRotinas(respRot([
    mesRot("2031-07", { fontes: sal(false), salario_brl_cents: 500 }),
    mesRot("2031-08", { fontes: sal(true), salario_brl_cents: 500 }),
    mesRot("2031-09", { fontes: sal(true), salario_brl_cents: null }),
  ]), "2031-09");
  assert.equal(celRot(cal, "salario", "2031-07").estado, "feito");
  assert.equal(celRot(cal, "salario", "2031-08").estado, "parcial");
  assert.equal(celRot(cal, "salario", "2031-09").estado, "falta");
});

test("G6 print: com foto → feito, sem foto → falta, antes do primeiro print de qualquer conta → não se aplica", () => {
  const p = (itau, c6) => [{ conta: "itau", pessoa: "Bia", tem_print: itau }, { conta: "c6", pessoa: "Ana", tem_print: c6 }];
  const cal = calendarioRotinas(respRot([
    mesRot("2031-08", { patrimonio: p(false, false) }),
    mesRot("2031-09", { patrimonio: p(true, false) }),
    mesRot("2031-10", { patrimonio: p(false, true) }),
  ], { primeiro_print: "2031-09" }), "2031-10");
  // Exemplo do card: C6/Ana antes do primeiro print = não se aplica; no mês do print = feito
  assert.equal(celRot(cal, "print:c6/Ana", "2031-08").estado, "nao_se_aplica");
  assert.equal(celRot(cal, "print:itau/Bia", "2031-08").estado, "nao_se_aplica");
  assert.equal(celRot(cal, "print:itau/Bia", "2031-09").estado, "feito");
  assert.equal(celRot(cal, "print:c6/Ana", "2031-09").estado, "falta"); // o corte é global, não por conta
  assert.equal(celRot(cal, "print:c6/Ana", "2031-10").estado, "feito");
  assert.equal(celRot(cal, "print:itau/Bia", "2031-10").estado, "falta");
});

test("G6 triagem: mês sem transação → não se aplica, 0 sem categoria → feito, 1 ou mais → parcial com o número", () => {
  const cal = calendarioRotinas(respRot([
    mesRot("2031-07", { transacoes: 0, sem_categoria: 0 }),
    mesRot("2031-08", { sem_categoria: 0 }),
    mesRot("2031-09", { sem_categoria: 26 }),
    mesRot("2031-10", { sem_categoria: 2 }),
  ]), "2031-10");
  assert.equal(celRot(cal, "triagem", "2031-07").estado, "nao_se_aplica");
  assert.equal(celRot(cal, "triagem", "2031-08").estado, "feito");
  assert.equal(celRot(cal, "triagem", "2031-09").estado, "parcial");
  assert.equal(celRot(cal, "triagem", "2031-09").texto, "26");
  assert.equal(celRot(cal, "triagem", "2031-10").texto, "2");
});

test("G6 diagnóstico: salvo → feito; mês fechado sem ele → falta; mês ainda não fechado → não se aplica", () => {
  const cal = calendarioRotinas(respRot([
    mesRot("2031-08", { diagnostico: true }),
    mesRot("2031-09", { diagnostico: false, estado: "fechado" }),
    mesRot("2031-10", { diagnostico: false, estado: "faltando" }),
  ]), "2031-10");
  assert.equal(celRot(cal, "diagnostico", "2031-08").estado, "feito");
  assert.equal(celRot(cal, "diagnostico", "2031-09").estado, "falta");
  assert.equal(celRot(cal, "diagnostico", "2031-10").estado, "nao_se_aplica");
});

const catalogoG6 = { categorias: [
  { id: "c1", nome: "Outros", padrao: false }, { id: "c2", nome: "Pendentes", padrao: true }, { id: "c3", nome: "Casa", padrao: false },
] };

test("G6 clique: extrato, fatura e salário em falta ou parcial levam à aba Importar com o tipo certo; feito não é botão", () => {
  const sem = { ...mesRot("x").fontes,
    itau: { ate: null, cobertura: "faltando" }, c6: { ate: "2031-10-13", cobertura: "parcial" },
    fatura: { existe: false, cobertura: "faltando" }, salario: { ate: null, estimado: true } };
  const cal = calendarioRotinas(respRot([mesRot("2031-09"), mesRot("2031-10", { fontes: sem })]), "2031-10");
  const acao = (id, mes) => acaoCelula(linhaRot(cal, id), celRot(cal, id, mes), catalogoG6);
  assert.deepEqual(acao("itau", "2031-10"), { aba: "importar", tipo: "extrato" });
  assert.deepEqual(acao("c6", "2031-10"), { aba: "importar", tipo: "c6" });
  assert.deepEqual(acao("fatura", "2031-10"), { aba: "importar", tipo: "fatura" });
  assert.deepEqual(acao("salario", "2031-10"), { aba: "importar", tipo: "wise" });
  assert.equal(acao("fatura", "2031-09"), null);
  assert.equal(acao("salario", "2031-09"), null);
});

test("G6 clique na triagem: Lançamentos no mês da célula, filtrada na categoria padrão pela flag (não pelo nome)", () => {
  const cal = calendarioRotinas(respRot([mesRot("2031-08", { sem_categoria: 0 }), mesRot("2031-09", { sem_categoria: 26 })]), "2031-10");
  // a padrão foi renomeada para "Pendentes" e existe uma "Outros" comum: vale a flag
  assert.deepEqual(acaoCelula(linhaRot(cal, "triagem"), celRot(cal, "triagem", "2031-09"), catalogoG6),
    { aba: "lanc", mes: "2031-09", categoria: "Pendentes" });
  assert.equal(acaoCelula(linhaRot(cal, "triagem"), celRot(cal, "triagem", "2031-08"), catalogoG6), null);
  // sem padrão no catálogo, não há para onde levar
  assert.equal(acaoCelula(linhaRot(cal, "triagem"), celRot(cal, "triagem", "2031-09"), { categorias: [] }), null);
});

test("G6 clique: print e diagnóstico nunca são botão, só mostram o texto", () => {
  const cal = calendarioRotinas(respRot([mesRot("2031-09"), mesRot("2031-10")], { primeiro_print: "2031-01" }), "2031-10");
  assert.equal(celRot(cal, "print:itau/Bia", "2031-09").estado, "falta");
  assert.equal(acaoCelula(linhaRot(cal, "print:itau/Bia"), celRot(cal, "print:itau/Bia", "2031-09"), catalogoG6), null);
  assert.equal(celRot(cal, "diagnostico", "2031-09").estado, "falta");
  assert.equal(acaoCelula(linhaRot(cal, "diagnostico"), celRot(cal, "diagnostico", "2031-09"), catalogoG6), null);
});

// ---------- G3: diagnóstico mensal ----------
// O texto vem do assistente pela API; o renderizador é deliberadamente pequeno (o roteiro só usa
// títulos, parágrafos, listas e negrito) e escapa tudo antes de montar tag: nada do texto vira HTML.
test("markdownSimples: '## ' vira título h2", () => {
  assert.equal(markdownSimples("## 1. Fechou no azul?"), "<h2>1. Fechou no azul?</h2>");
});

test("markdownSimples: linhas seguidas formam um parágrafo; linha em branco separa parágrafos", () => {
  assert.equal(markdownSimples("primeira linha\ncontinua\n\noutro"), "<p>primeira linha<br>continua</p><p>outro</p>");
});

test("markdownSimples: linhas '- ' viram uma lista ul", () => {
  assert.equal(markdownSimples("- mercado\n- escola"), "<ul><li>mercado</li><li>escola</li></ul>");
});

test("markdownSimples: **negrito** vira strong, também em título e item de lista", () => {
  assert.equal(markdownSimples("gastou **R$ 100** a mais"), "<p>gastou <strong>R$ 100</strong> a mais</p>");
  assert.equal(markdownSimples("## **Sim**"), "<h2><strong>Sim</strong></h2>");
  assert.equal(markdownSimples("- **Casa**: alta"), "<ul><li><strong>Casa</strong>: alta</li></ul>");
});

test("markdownSimples: o exemplo do item (título, parágrafo e lista; \r\n tolerado)", () => {
  assert.equal(
    markdownSimples("## 1. Fechou no azul?\r\nSim: +R$ 2,5 mil, contra -R$ 2 mil de média\n- item"),
    "<h2>1. Fechou no azul?</h2><p>Sim: +R$ 2,5 mil, contra -R$ 2 mil de média</p><ul><li>item</li></ul>",
  );
});

test("markdownSimples: <script> e aspas saem escapados (esc antes das tags)", () => {
  const html = markdownSimples("<script>alert('x')</script>\n- <b>\n## <img onerror=1>");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
  assert.ok(html.includes("<li>&lt;b&gt;</li>"));
  assert.ok(html.includes("<h2>&lt;img onerror=1&gt;</h2>"));
});

test("markdownSimples: vazio ou null não monta nada", () => {
  assert.equal(markdownSimples(""), "");
  assert.equal(markdownSimples(null), "");
});

test("avisoMesParcial: só o mês 'fechado' fica sem aviso; faltando e parcial avisam", () => {
  const resp = { meses: [
    { mes: "2026-08", estado: "fechado" },
    { mes: "2026-09", estado: "faltando" },
    { mes: "2026-10", estado: "parcial" },
  ] };
  assert.equal(avisoMesParcial(resp, "2026-08"), false);
  assert.equal(avisoMesParcial(resp, "2026-09"), true);
  assert.equal(avisoMesParcial(resp, "2026-10"), true);
});

test("avisoMesParcial: sem resposta do fechamento (rota falhou) não avisa — o aviso é informativo", () => {
  assert.equal(avisoMesParcial(null, "2026-09"), false);
  assert.equal(avisoMesParcial({ meses: [] }, "2026-09"), false);
});

test("htmlDiagnostico: sem texto mostra a frase exata do vazio, e o aviso vem acima do texto", () => {
  assert.equal(SEM_DIAGNOSTICO, "ainda não há diagnóstico deste mês");
  assert.equal(AVISO_MES_PARCIAL, "mês parcial: o diagnóstico pode mudar");
  const fech = { meses: [{ mes: "2026-09", estado: "faltando" }, { mes: "2026-08", estado: "fechado" }] };
  const vazio = htmlDiagnostico({ mes: "2026-10", texto: null }, fech, "2026-10");
  assert.ok(vazio.includes(SEM_DIAGNOSTICO));
  // mês sem texto e sem fechar: o aviso aparece mesmo assim (o mês ainda vai mudar)
  assert.ok(htmlDiagnostico({ mes: "2026-09", texto: null }, fech, "2026-09").includes(AVISO_MES_PARCIAL));
  const set = htmlDiagnostico({ mes: "2026-09", texto: "## 1. Fechou no azul?\nSim." }, fech, "2026-09");
  assert.ok(set.includes(AVISO_MES_PARCIAL));
  assert.ok(set.indexOf(AVISO_MES_PARCIAL) < set.indexOf("<h2>1. Fechou no azul?</h2>"));
  const ago = htmlDiagnostico({ mes: "2026-08", texto: "texto" }, fech, "2026-08");
  assert.ok(!ago.includes(AVISO_MES_PARCIAL));
  assert.ok(ago.includes("<p>texto</p>"));
});

// ---------- A2: aba Patrimônio ----------
// resposta inventada de /api/patrimonio (forma de montarPatrimonio): Exemplo do card em outubro
const mesVazio = (mes) => ({ mes, total_cents: null, porPessoa: [], porConta: [] });
const respPatrimonio = {
  ate: "2026-10",
  meses: [
    ...["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"].map(mesVazio),
    { mes: "2026-09", total_cents: 95000000, porPessoa: [{ pessoa: "Caio", total_cents: 75000000 }, { pessoa: "Paola", total_cents: 20000000 }],
      porConta: [] },
    { mes: "2026-10", total_cents: 97000000,
      porPessoa: [{ pessoa: "Paola", total_cents: 20000000 }, { pessoa: "Caio", total_cents: 77000000 }],
      porConta: [
        { conta: "c6", pessoa: "Paola", data: "2026-10-09", total_cents: 20000000, rendimento_cents: 150000, origem: "print", motivo: null },
        { conta: "itau", pessoa: "Caio", data: "2026-10-09", total_cents: 77000000, rendimento_cents: null, origem: "sem", motivo: "extrato pendente" },
      ] },
  ],
};

test("A2 montarTelaPatrimonio: total da família, por pessoa e por conta do último mês, mais a série de 12 meses", () => {
  const t = montarTelaPatrimonio(respPatrimonio);
  assert.equal(t.mes, "2026-10");
  assert.equal(t.total_cents, 97000000);
  assert.deepEqual(t.porPessoa.map((p) => p.pessoa), ["Caio", "Paola"]); // maior primeiro
  assert.deepEqual(t.porConta.map((c) => [c.conta, c.total_cents, c.rendimento]), [
    ["itau", 77000000, "sem rendimento (extrato pendente)"],
    ["c6", 20000000, "print"],
  ]);
  assert.equal(t.serie.length, 12);
  assert.equal(t.serie[0].total_cents, null); // mês sem print: null, não zero
  assert.equal(t.serie[10].total_cents, 95000000);
  assert.equal(t.vazio, false);
});

test("A2 htmlPatrimonio: mostra os totais formatados e a origem do rendimento; escapa o que vem da API", () => {
  const h = htmlPatrimonio(respPatrimonio);
  assert.match(h, /R\$ 970\.000,00/);
  assert.match(h, /R\$ 770\.000,00/);
  assert.match(h, /R\$ 200\.000,00/);
  assert.match(h, /sem rendimento \(extrato pendente\)/);
  assert.match(h, /R\$ 1\.500,00/);
  const sujo = { ...respPatrimonio, meses: [{ ...respPatrimonio.meses[11], porPessoa: [{ pessoa: "<b>x</b>", total_cents: 1 }] }] };
  assert.doesNotMatch(htmlPatrimonio(sujo), /<b>x<\/b>/);
});

test("A2 htmlPatrimonio: 12 meses sem print mostram o vazio", () => {
  const h = htmlPatrimonio({ ate: "2026-10", meses: [mesVazio("2026-10")] });
  assert.match(h, new RegExp(SEM_PATRIMONIO));
});

test("A2 reaisDeCents e rotuloRendimentoApp: null é traço/sem rendimento, nunca zero", () => {
  assert.equal(reaisDeCents(null), "—");
  assert.equal(reaisDeCents(12345), "R$ 123,45");
  assert.equal(reaisDeCents(-500), "-R$ 5,00");
  assert.equal(rotuloRendimentoApp({ origem: "calculado" }), "calculado");
  assert.equal(rotuloRendimentoApp({ origem: "sem", motivo: "sem print anterior" }), "sem rendimento (sem print anterior)");
});

// ---------- G4: aba Casa ----------
// Respostas montadas pela própria função pura do worker (worker/casa.js), com números inventados:
// o Exemplo do card (custo 1.000.000, reserva 300.000, patrimônio 900.000, ritmo 8.000, 20.000 já
// gastos, data alvo em 36 meses).
const casaMeses = mesesAte("2026-09", 12);
const casaParam = { vigente_desde: "2026-01-01", custo_total_cents: 100000000, reserva_cents: 30000000, data_alvo: "2029-09-01" };
const casaLinha = (mes) => ({ mes, data: `${mes}-28`, conta: "nubank", pessoa: "Paola", familia: "caixa", nivel: "agregado", saldo_cents: 90000000, rend_mes_cents: 600000, n_rend_mes: 1 });
const casaResp = (extra = {}) => montarCasa(casaMeses, "2026-10", {
  param: casaParam, linhasPatrimonio: ["2025-09", ...casaMeses].map(casaLinha),
  estados: casaMeses.map((mes) => ({ mes, estado: "fechado" })),
  saldos: casaMeses.map((mes) => ({ mes, saldo_cents: 200000 })), jaGastoCents: 2000000, ...extra,
});

test("G4 htmlCasa: barra disponível × custo, falta, ritmo com 'rendimento em N de 6 meses', projeção, ritmo necessário, já gasto, foto mais antiga e a série de 12 meses", () => {
  const h = htmlCasa(casaResp(), casaParam);
  assert.match(h, /casa-barra" style="width:60%"/);
  assert.match(h, /R\$ 600\.000,00/);           // disponível
  assert.match(h, /R\$ 1\.000\.000,00/);         // custo
  assert.match(h, /Falta <strong>R\$ 380\.000,00/);
  assert.match(h, /Ritmo mensal <strong>R\$ 8\.000,00/);
  assert.match(h, /rendimento em 6 de 6 meses/);
  assert.match(h, /48 meses \(set\/2030\)/);
  assert.match(h, /Ritmo necessário <strong>R\$ 10\.555,56\/mês/);
  assert.match(h, /Já gasto em Projeto Casa <strong>R\$ 20\.000,00/);
  assert.match(h, /fotos desde 28\/09\/2026/);
  assert.equal((h.match(/class="pat-mes"/g) || []).length, 12);
});

test("G4 htmlCasa: sem data alvo, a linha de ritmo necessário não aparece", () => {
  const p = { ...casaParam, data_alvo: null };
  assert.doesNotMatch(htmlCasa(casaResp({ param: p }), p), /Ritmo necessário/);
});

test("G4 htmlCasa: ritmo ≤ 0 mostra o aviso no lugar da projeção", () => {
  const h = htmlCasa(casaResp({ saldos: casaMeses.map((mes) => ({ mes, saldo_cents: -5000000 })) }), casaParam);
  assert.match(h, /Projeção <strong>ritmo ≤ 0/);
});

test("G4 htmlCasa: sem foto de patrimônio, mostra 'mande o primeiro print' no lugar dos números (null não vira R$ 0)", () => {
  const resp = casaResp({ linhasPatrimonio: [] });
  const t = montarTelaCasa(resp, casaParam);
  assert.equal(t.estado, "sem_foto");
  const h = htmlCasa(resp, casaParam);
  assert.ok(h.includes(SEM_FOTO_CASA));
  assert.ok(SEM_FOTO_CASA.includes("mande o primeiro print (/patrimonio …)"));
  assert.doesNotMatch(h, /Falta|Ritmo mensal|casa-barra/);
});

test("G4 htmlCasa: com GET api/casa/param vazio (null), a aba é o formulário de custo, reserva e data alvo em vez dos números", () => {
  const h = htmlCasa(casaResp({ param: null }), null);
  assert.equal(montarTelaCasa(casaResp({ param: null }), null).estado, "param");
  assert.doesNotMatch(h, /Falta|Ritmo mensal/);
  // dinheiro em campo texto decimal (teclado BR), data alvo por mês
  assert.match(h, /id="casaCusto" type="text" inputmode="decimal"/);
  assert.match(h, /id="casaReserva" type="text" inputmode="decimal"/);
  assert.match(h, /id="casaAlvo" type="month"/);
  assert.match(h, /id="casaSalvar"/);
});

test("G4 corpoParamCasa: converte com parseBRtoCents (vírgula/ponto do teclado BR) e monta o PUT", () => {
  assert.equal(parseBRtoCents("1.000.000,50"), 100000050);
  assert.deepEqual(corpoParamCasa({ mes: "2026-10", custo: "1.000.000,00", reserva: "300.000", alvo: "2029-10" }).corpo,
    { vigente_desde: "2026-10", custo_total_cents: 100000000, reserva_cents: 30000000, data_alvo: "2029-10-01" });
  // reserva vazia é zero; data alvo vazia é sem data alvo
  assert.deepEqual(corpoParamCasa({ mes: "2026-10", custo: "10", reserva: "", alvo: "" }).corpo,
    { vigente_desde: "2026-10", custo_total_cents: 1000, reserva_cents: 0, data_alvo: null });
  assert.match(corpoParamCasa({ mes: "2026-10", custo: "", reserva: "1", alvo: "" }).erro, /custo/);
  assert.match(corpoParamCasa({ mes: "2026-10", custo: "0", reserva: "1", alvo: "" }).erro, /custo/);
  assert.match(corpoParamCasa({ mes: "2026-10", custo: "10", reserva: "abc", alvo: "" }).erro, /reserva/);
});

test("G4 htmlCasa: o formulário vem preenchido com os parâmetros vigentes, em reais", () => {
  const h = htmlCasa(casaResp(), casaParam);
  assert.match(h, /id="casaCusto"[^>]*value="1\.000\.000,00"/);
  assert.match(h, /id="casaAlvo"[^>]*value="2029-09"/);
});

// ---------- H4: JEV no import (sugestão depois da prévia) ----------
// Catálogo e descrições inventados (repositório público). "Não Identificado" é a padrão.
const CATALOGO_JEV_APP = {
  categorias: [
    { id: "kA", nome: "Alimentação", natureza: "despesa" },
    { id: "kC", nome: "Compras", natureza: "despesa" },
    { id: "kT", nome: "Transferências", natureza: "despesa" },
    { id: "kN", nome: "Não Identificado", natureza: "despesa", padrao: true },
  ],
  subcategorias: [
    { id: "a1", categoria_id: "kA", nome: "Ifood" },
    { id: "c1", categoria_id: "kC", nome: "Amazon" },
    { id: "c2", categoria_id: "kC", nome: "Compras" },
  ],
};
const itemJev = (descricao, extra = {}) => ({
  status: "novo", data: "2026-10-01", descricao, valorCents: 4990, natureza: "despesa",
  linhaHash: "h-" + descricao, matchId: null, computaResumo: true,
  categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null, ...extra,
});
function previewJev() {
  return {
    checksum: { ok: true },
    itens: [
      itemJev("IFD*LANCHONETE EXEMPLO"),                                          // 0 vai
      itemJev("LOJA EXEMPLO LTDA", { descricaoFinal: "LOJA EXEMPLO LTDA (parc 01/02)" }), // 1 vai
      itemJev("FULANO DE TAL"),                                                   // 2 vai
      itemJev("LOJA COM REGRA", { categoriaNome: "Compras", subNome: "Amazon" }), // 3 regra
      itemJev("PIX TRANSF CONTA PROPRIA", { status: "naoGasto", categoriaOrg: "Transferências", computaResumo: false }), // 4 repasse
      itemJev("TALVEZ CASE", { status: "ambiguo" }),                              // 5
      itemJev("JA CASADA", { status: "casado", matchId: "m1" }),                  // 6
      itemJev("JA IMPORTADA", { status: "jaTem" }),                               // 7
    ],
  };
}
const respostaExemplo = {
  indisponivel: false,
  itens: [
    { indice: 0, preenche: true, sugestao: { categoria: "Alimentação", subcategoria: "Ifood", prob_categoria: 1, prob_subcategoria: 1 } },
    { indice: 1, preenche: true, sugestao: { categoria: "Compras", subcategoria: "Compras", prob_categoria: 0.96, prob_subcategoria: 0.8 } },
    { indice: 2, preenche: false, sugestao: { categoria: "Compras", subcategoria: null, prob_categoria: 0.46, prob_subcategoria: null } },
  ],
};

test("H4: só a linha nova que caiu na padrão vai à rota de sugestões (casada, repetida, ambígua, repasse e regra não vão)", () => {
  const lotes = lotesSugestao(previewJev(), "fatura");
  assert.equal(lotes.length, 1);
  assert.equal(lotes[0].fonte, "fatura");
  assert.deepEqual(lotes[0].itens.map(i => i.indice), [0, 1, 2]);
  // o estado do JEV usa a descrição gravada (descricaoFinal); a original vai para conferir a regra
  assert.equal(lotes[0].itens[1].descricaoFinal, "LOJA EXEMPLO LTDA (parc 01/02)");
  assert.equal(lotes[0].itens[1].descricao, "LOJA EXEMPLO LTDA");
});

test("H4: lotes de no máximo 20 linhas (teto de subrequests do Worker)", () => {
  const p = { itens: Array.from({ length: 45 }, (_, i) => itemJev(`LOJA ${i}`)) };
  const lotes = lotesSugestao(p, "extrato");
  assert.deepEqual(lotes.map(l => l.itens.length), [20, 20, 5]);
  assert.deepEqual(lotes[2].itens.map(i => i.indice), [40, 41, 42, 43, 44]);
});

test("H4: a ambígua que vira 'novo' por 'tratar como novo' depois da prévia não é enviada e grava como hoje", () => {
  const p = previewJev();
  const lotes = lotesSugestao(p, "extrato"); // pedido feito logo depois da prévia
  p.itens[5].status = "novo"; p.itens[5].matchId = null; // o Caio trata como novo
  assert.ok(lotes.every(l => l.itens.every(i => i.indice !== 5)));
  aplicarSugestoes(p, respostaExemplo, CATALOGO_JEV_APP);
  assert.equal(p.itens[5].jev, undefined);
  const d = montarDecisao(p, CATALOGO_JEV_APP, "extrato");
  const amb = d.novos.find(n => n.descricao === "TALVEZ CASE");
  assert.equal(amb.categoria_id, "kN"); // padrão, porque a prévia não deu regra
  assert.equal(amb.origem_categoria, "modelo");
});

test("H4: limiar 0,90 na tela — 0,90 preenche, 0,89 e 'nenhuma serve' não", () => {
  assert.equal(jevPreenche({ categoria: "Compras", prob_categoria: 0.9 }), true);
  assert.equal(jevPreenche({ categoria: "Compras", prob_categoria: 0.89 }), false);
  assert.equal(jevPreenche({ categoria: "nenhuma serve", prob_categoria: 0.99 }), false);
  assert.equal(jevPreenche(null), false);
});

test("H4: Exemplo do card — IFD* e 0,96 trocam categoria e sub; 0,46 fica na padrão", () => {
  const p = previewJev();
  aplicarSugestoes(p, respostaExemplo, CATALOGO_JEV_APP);
  assert.deepEqual(p.itens[0].jev, { categoria: "Alimentação", subcategoria: "Ifood", prob: 1 });
  assert.deepEqual(p.itens[1].jev, { categoria: "Compras", subcategoria: "Compras", prob: 0.96 });
  assert.equal(p.itens[2].jev, undefined);
  // a sugestão fica registrada mesmo abaixo do limiar, mas a categoria não muda
  assert.equal(p.itens[2].sugestao.prob_categoria, 0.46);
  // o campo próprio não mexe no categoriaNome, que marca regra aprendida
  assert.equal(p.itens[1].categoriaNome, null);

  const d = montarDecisao(p, CATALOGO_JEV_APP, "fatura");
  const por = Object.fromEntries(d.novos.map(n => [n.descricao, n]));
  assert.equal(por["IFD*LANCHONETE EXEMPLO"].categoria_id, "kA");
  assert.equal(por["IFD*LANCHONETE EXEMPLO"].subcategoria_id, "a1");
  assert.equal(por["LOJA EXEMPLO LTDA (parc 01/02)"].categoria_id, "kC");
  assert.equal(por["LOJA EXEMPLO LTDA (parc 01/02)"].subcategoria_id, "c2");
  assert.equal(por["FULANO DE TAL"].categoria_id, "kN");
  assert.equal(por["FULANO DE TAL"].subcategoria_id, null);
});

test("H4: montarDecisao — a linha do JEV grava origem 'modelo'; a de regra aprendida segue 'regra'", () => {
  const p = previewJev();
  aplicarSugestoes(p, respostaExemplo, CATALOGO_JEV_APP);
  const d = montarDecisao(p, CATALOGO_JEV_APP, "fatura");
  const por = Object.fromEntries(d.novos.map(n => [n.descricao, n]));
  assert.equal(por["LOJA EXEMPLO LTDA (parc 01/02)"].origem_categoria, "modelo");
  assert.equal(por["IFD*LANCHONETE EXEMPLO"].origem_categoria, "modelo");
  assert.equal(por["LOJA COM REGRA"].origem_categoria, "regra");
  assert.equal(por["LOJA COM REGRA"].categoria_id, "kC");
  assert.equal(por["LOJA COM REGRA"].subcategoria_id, "c1");
});

test("H4: sub respondida que não existe na categoria fica nula; categoria fora do catálogo não preenche", () => {
  const p = previewJev();
  aplicarSugestoes(p, { itens: [
    { indice: 1, sugestao: { categoria: "Compras", subcategoria: "Inexistente", prob_categoria: 0.95, prob_subcategoria: 0.9 } },
    { indice: 2, sugestao: { categoria: "Sumiu", subcategoria: null, prob_categoria: 0.99, prob_subcategoria: null } },
  ] }, CATALOGO_JEV_APP);
  assert.equal(p.itens[2].jev, undefined);
  const d = montarDecisao(p, CATALOGO_JEV_APP, "fatura");
  const loja = d.novos.find(n => n.descricao.startsWith("LOJA EXEMPLO"));
  assert.equal(loja.categoria_id, "kC");
  assert.equal(loja.subcategoria_id, null);
});

test("H4: sugestão para linha que não é mais nova ou que tem regra é ignorada", () => {
  const p = previewJev();
  aplicarSugestoes(p, { itens: [
    { indice: 3, sugestao: { categoria: "Alimentação", subcategoria: "Ifood", prob_categoria: 0.99 } },
    { indice: 6, sugestao: { categoria: "Alimentação", subcategoria: "Ifood", prob_categoria: 0.99 } },
  ] }, CATALOGO_JEV_APP);
  assert.equal(p.itens[3].jev, undefined);
  assert.equal(p.itens[6].jev, undefined);
});

test("H4: na prévia, a linha preenchida mostra a categoria em texto seguida do selo 'JEV 0,97'; abaixo do limiar, sem selo", () => {
  assert.equal(seloJev(0.97), "JEV 0,97");
  assert.equal(seloJev(1), "JEV 1,00");
  const p = previewJev();
  aplicarSugestoes(p, { itens: [
    { indice: 1, sugestao: { categoria: "Compras", subcategoria: "Compras", prob_categoria: 0.97, prob_subcategoria: 0.8 } },
    { indice: 2, sugestao: { categoria: "Compras", subcategoria: null, prob_categoria: 0.46, prob_subcategoria: null } },
  ] }, CATALOGO_JEV_APP);
  const cel = celulaCategoriaImport(p.itens[1], CATALOGO_JEV_APP);
  assert.match(cel, /^Compras › Compras <span class="selo-jev"[^>]*>JEV 0,97<\/span>$/);
  assert.doesNotMatch(cel, /<select/);
  const baixa = celulaCategoriaImport(p.itens[2], CATALOGO_JEV_APP);
  assert.equal(baixa, "Não Identificado");
  assert.equal(celulaCategoriaImport(p.itens[3], CATALOGO_JEV_APP), "Compras › Amazon");
});

test("H4: a tabela da prévia não ganha <select> (correção é na aba Lançamentos)", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const ini = fonte.indexOf("function tabelaItens(");
  const fim = fonte.indexOf("function tabelaConversoes(");
  assert.ok(ini > 0 && fim > ini);
  assert.doesNotMatch(fonte.slice(ini, fim), /<select/);
});

test("H4: aviso de indisponibilidade e de lotes pendentes na prévia", () => {
  assert.equal(AVISO_JEV, "classificação automática indisponível");
  assert.match(avisoJevHtml({ indisponivel: true, pendentes: 0 }), /classificação automática indisponível/);
  assert.match(avisoJevHtml({ indisponivel: false, pendentes: 2 }), /2 lote/);
  assert.equal(avisoJevHtml({ indisponivel: false, pendentes: 0 }), "");
});

test("H4: nenhum caminho do JEV no app escreve em associações", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const ini = fonte.indexOf("// ---------- H4: JEV no import");
  const fim = fonte.indexOf("// ---------- fim H4");
  assert.ok(ini > 0 && fim > ini);
  assert.doesNotMatch(fonte.slice(ini, fim), /associac|aprender/i);
});

// ---- C4: guardar o arquivo original depois do aplicar ----
// apiPost e o envio do arquivo são falsos e registram a ordem das chamadas
function fluxoFalso({ aplicarFalha = false, envio = async () => ({ ok: true, status: 200 }) } = {}) {
  const chamadas = [];
  return {
    chamadas,
    apiPost: async (p, body) => {
      chamadas.push({ rota: p, body });
      if (aplicarFalha) throw new Error("aplicar falhou: 500");
      return { gravados: 2, naoGasto: 0, agrupados: 0 };
    },
    enviarArquivo: async (p, arquivo) => { chamadas.push({ rota: p, arquivo }); return envio(p, arquivo); },
  };
}
const arquivoFalso = { nome: "extrato-de-mentira.pdf" };

test("C4: extrato Itaú — aplica e só depois faz UM POST do File em /api/importar/arquivo com tipo, banco e período", async () => {
  const f = fluxoFalso();
  const st = { tipo: "extrato", preview: { cobertura: { de: "2026-09-03", ate: "2026-10-13" } }, arquivo: arquivoFalso };
  const r = await aplicarEGuardarArquivo(st, { tipo: "extrato" }, f);
  assert.deepEqual(f.chamadas.map((c) => c.rota), [
    "/api/importar/aplicar",
    "/api/importar/arquivo?tipo=extrato&banco=itau&de=2026-09-03&ate=2026-10-13",
  ]);
  assert.equal(f.chamadas[1].arquivo, arquivoFalso); // o próprio File, bytes como vieram
  assert.equal(r.gravados, 2);
  assert.equal(r.avisoArquivo, undefined);
});

test("C4: se o aplicar falha, a rota do arquivo não é chamada (nada de guardar o que não entrou)", async () => {
  const f = fluxoFalso({ aplicarFalha: true });
  const st = { tipo: "extrato", preview: { cobertura: { de: "2026-09-03", ate: "2026-10-13" } }, arquivo: arquivoFalso };
  await assert.rejects(() => aplicarEGuardarArquivo(st, {}, f));
  assert.deepEqual(f.chamadas.map((c) => c.rota), ["/api/importar/aplicar"]);
});

test("C4: envio com status fora de 2xx não desfaz o import — o resultado volta com o aviso exato", async () => {
  const f = fluxoFalso({ envio: async () => ({ ok: false, status: 502 }) });
  const st = { tipo: "c6", preview: { cobertura: { de: "2026-08-01", ate: "2026-08-31" } }, arquivo: arquivoFalso };
  const r = await aplicarEGuardarArquivo(st, {}, f);
  assert.equal(r.gravados, 2);
  assert.equal(r.avisoArquivo, "o import entrou, mas o arquivo original não foi guardado");
  assert.equal(AVISO_ARQUIVO_NAO_GUARDADO, "o import entrou, mas o arquivo original não foi guardado");
});

test("C4: erro de rede no envio também vira só o aviso", async () => {
  const f = fluxoFalso({ envio: async () => { throw new TypeError("Failed to fetch"); } });
  const st = { tipo: "fatura", ano: 2026, mes: 10, preview: {}, arquivo: arquivoFalso };
  const r = await aplicarEGuardarArquivo(st, {}, f);
  assert.equal(r.gravados, 2);
  assert.equal(r.avisoArquivo, AVISO_ARQUIVO_NAO_GUARDADO);
});

test("C4: sem período (extrato sem 'Saldo do dia') não envia nada e avisa", async () => {
  const f = fluxoFalso();
  const st = { tipo: "extrato", preview: { cobertura: null }, arquivo: arquivoFalso };
  const r = await aplicarEGuardarArquivo(st, {}, f);
  assert.deepEqual(f.chamadas.map((c) => c.rota), ["/api/importar/aplicar"]);
  assert.equal(r.avisoArquivo, AVISO_ARQUIVO_NAO_GUARDADO);
});

test("C4: a Wise passa pelo mesmo fluxo, como extrato do banco wise", async () => {
  const f = fluxoFalso();
  const st = { tipo: "wise", preview: { cobertura: { de: "2026-07-01", ate: "2026-09-30" } }, arquivo: arquivoFalso };
  await aplicarEGuardarArquivo(st, { tipo: "wise", conversoes: [] }, f);
  assert.equal(f.chamadas[1].rota, "/api/importar/arquivo?tipo=extrato&banco=wise&de=2026-07-01&ate=2026-09-30");
});

test("C4: consultaArquivoImport traduz os tipos da tela para tipo/banco da rota", () => {
  const cob = { cobertura: { de: "2026-09-03", ate: "2026-10-13" } };
  assert.equal(consultaArquivoImport({ tipo: "extrato", preview: cob }), "tipo=extrato&banco=itau&de=2026-09-03&ate=2026-10-13");
  assert.equal(consultaArquivoImport({ tipo: "c6", preview: cob }), "tipo=extrato&banco=c6&de=2026-09-03&ate=2026-10-13");
  // fatura: mês do vencimento digitado, com 2 dígitos (o nome no Dropbox é AAAA-MM)
  assert.equal(consultaArquivoImport({ tipo: "fatura", ano: 2026, mes: 3, preview: {} }), "tipo=fatura&banco=itau&mes=2026-03");
  assert.equal(consultaArquivoImport({ tipo: "fatura", ano: null, mes: null, preview: {} }), null);
  assert.equal(consultaArquivoImport({ tipo: "extrato", preview: {} }), null);
});

// ---- A1: no import, a linha herda a esfera da categoria resolvida (antes: 'pessoal' fixo) ----
test("montarDecisao: item resolvido p/ categoria empresa grava esfera empresa; o resto segue pessoal", () => {
  const catalogo = {
    categorias: [
      { id: "cNI", nome: "Não Identificado", padrao: true, esfera: "pessoal" },
      { id: "cEmp", nome: "Empresa", esfera: "empresa" },
    ],
    subcategorias: [{ id: "sContab", categoria_id: "cEmp", nome: "Contabilidade" }],
  };
  const preview = { itens: [
    { status: "novo", data: "2026-09-10", descricao: "CONTADOR", valorCents: 35000, natureza: "despesa",
      linhaHash: "hA", computaResumo: true, categoriaNome: "Empresa", subNome: "Contabilidade", categoriaOrg: null },
    { status: "novo", data: "2026-09-11", descricao: "PADARIA", valorCents: 1200, natureza: "despesa",
      linhaHash: "hB", computaResumo: true, categoriaNome: null, subNome: null, categoriaOrg: null },
  ] };
  const d = montarDecisao(preview, catalogo, "extrato");
  assert.equal(d.novos[0].categoria_id, "cEmp");
  assert.equal(d.novos[0].esfera, "empresa");
  assert.equal(d.novos[1].categoria_id, "cNI");
  assert.equal(d.novos[1].esfera, "pessoal");
});

test("montarDecisao: catálogo sem esfera (fixture antiga) cai em pessoal, o default da coluna", () => {
  const d = montarDecisao(previewFixture(), CATALOGO_IMPORT, "extrato");
  assert.equal(d.novos[0].esfera, "pessoal");
});

test("opcoesEsfera: seletor da aba Ajustes só oferece pessoal/empresa e marca a esfera da categoria", async () => {
  const { opcoesEsfera } = await import("../public/app.js");
  const html = opcoesEsfera("empresa");
  assert.deepEqual([...html.matchAll(/value="(\w+)"/g)].map((m) => m[1]), ["pessoal", "empresa"]);
  assert.match(html, /value="empresa" selected/);
  assert.match(opcoesEsfera(undefined), /value="pessoal" selected/, "catálogo sem esfera mostra o default da coluna");
});

// ---- D5: este ano × ano passado (valores inventados, os do Exemplo) ----
const AV_EXEMPLO = {
  de: "2026-06-01", ate: "2026-09-30", de_anterior: "2025-06-01", ate_anterior: "2025-09-30",
  categorias: [
    { categoria: "Mercado", atual_cents: 300000, anterior_cents: 320000 },
    { categoria: "Escola", atual_cents: 440000, anterior_cents: 400000 },
  ],
};

test("D5 linhasAnoVsAnterior ordena pela maior alta em reais: escola (+400) antes de mercado (−200)", () => {
  const l = linhasAnoVsAnterior(AV_EXEMPLO.categorias);
  assert.deepEqual(l.map((x) => x.categoria), ["Escola", "Mercado"]);
  assert.equal(l[0].diff_cents, 40000);
  assert.equal(l[0].pct, 10);
  assert.equal(l[1].diff_cents, -20000);
  assert.equal(l[1].pct, -6); // −6,25% → inteiro, como no Exemplo
});

test("D5 a ordem é pela diferença em reais, não pelo %: alta grande em base grande vem antes de alta pequena em base pequena", () => {
  const l = linhasAnoVsAnterior([
    { categoria: "Lazer", atual_cents: 2000, anterior_cents: 1000 },       // +10, +100%
    { categoria: "Saúde", atual_cents: 1100000, anterior_cents: 1000000 }, // +1.000, +10%
  ]);
  assert.deepEqual(l.map((x) => x.categoria), ["Saúde", "Lazer"]);
});

test("D5 categoria sem gasto no ano anterior mostra 'novo' no lugar do %", () => {
  const [l] = linhasAnoVsAnterior([{ categoria: "Pet", atual_cents: 5000, anterior_cents: 0 }]);
  assert.equal(l.pct, null);
  assert.equal(l.novo, true);
  const html = htmlAnoVsAnterior({ ...AV_EXEMPLO, categorias: [{ categoria: "Pet", atual_cents: 5000, anterior_cents: 0 }] }, "2026-09");
  assert.match(html, />novo</);
  assert.doesNotMatch(html, /Infinity|NaN/);
});

test("D5 subtítulo do card: o intervalo usado nos dois anos", () => {
  assert.equal(subtituloAnoVsAnterior(AV_EXEMPLO), "jun–set 2026 × jun–set 2025");
  assert.equal(subtituloAnoVsAnterior({ de: "2026-06-01", ate: "2026-10-31", de_anterior: "2025-06-01", ate_anterior: "2025-10-31" }),
    "jun–out 2026 × jun–out 2025");
});

test("D5 card com o título, o subtítulo e uma linha por categoria com totais, diferença em R$ e %", () => {
  const html = htmlAnoVsAnterior(AV_EXEMPLO, "2026-09");
  assert.match(html, /Este ano × ano passado/);
  assert.match(html, /jun–set 2026 × jun–set 2025/);
  assert.ok(html.indexOf("Escola") < html.indexOf("Mercado"), "escola antes do mercado");
  assert.match(html, /R\$ 4\.400,00/);
  assert.match(html, /R\$ 4\.000,00/);
  assert.match(html, /\+R\$ 400,00/);
  assert.match(html, /\+10%/);
  assert.match(html, /-R\$ 200,00/);
  assert.match(html, /-6%/);
});

test("D5 mês selecionado antes do início: o card diz 'sem comparação para este mês'", () => {
  const html = htmlAnoVsAnterior({ de: "2026-06-01", ate: "2026-03-31", de_anterior: "2025-06-01", ate_anterior: "2025-03-31", categorias: [] }, "2026-03");
  assert.equal(SEM_COMPARACAO, "sem comparação para este mês");
  assert.match(html, /Este ano × ano passado/);
  assert.match(html, /sem comparação para este mês/);
});

test("D5 anoVsAnterior null (sem fatura no ano anterior): o card não é renderizado", () => {
  assert.equal(htmlAnoVsAnterior(null, "2026-09"), "");
  assert.equal(htmlAnoVsAnterior(undefined, "2026-09"), "");
});

test("D5 o texto da categoria vai escapado (nome vem do banco)", () => {
  const html = htmlAnoVsAnterior({ ...AV_EXEMPLO, categorias: [{ categoria: "<b>x</b>", atual_cents: 100, anterior_cents: 100 }] }, "2026-09");
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

// ---- H5: triagem assistida pelo JEV (aba Lançamentos) ----
// Valores e descrições inventados. A padrão é achada pela flag `padrao` (nunca pelo nome).
const CAT_TRI = {
  categorias: [
    { id: "kA", nome: "Alimentação", natureza: "despesa", padrao: false },
    { id: "kC", nome: "Compras", natureza: "despesa", padrao: false },
    { id: "kO", nome: "Outros", natureza: "despesa", padrao: false },
    { id: "kN", nome: "Não Identificado", natureza: "despesa", padrao: true },
  ],
  subcategorias: [
    { id: "a1", categoria_id: "kA", nome: "Ifood" },
    { id: "c1", categoria_id: "kC", nome: "Compras" },
    { id: "c2", categoria_id: "kC", nome: "Amazon" },
  ],
};
const txTri = (id, extra = {}) => ({ id, descricao: "X", categoria_id: "kN", grupo_id: null, representante: false, ...extra });

test("H5: pendentesTriagem — só a padrão (pela flag), sem membro não-representante de grupo", () => {
  const rows = [
    txTri("t1"), txTri("t2", { categoria_id: "kC" }),
    txTri("t3", { grupo_id: "g", representante: false }), txTri("t4", { grupo_id: "g", representante: true }),
    txTri("t5", { categoria_id: "kO" }), // "Outros" não é a padrão (miscelânea deliberada)
  ];
  assert.deepEqual(pendentesTriagem(rows, CAT_TRI).map((t) => t.id), ["t1", "t4"]);
  assert.deepEqual(pendentesTriagem(rows, { categorias: [], subcategorias: [] }), []);
});

test("H5: consultaTriagem pede a padrão pela API (o 'Todos os meses' não pode passar pelo limit sem filtro)", () => {
  assert.equal(consultaTriagem(CAT_TRI, { de: "1900-01-01", ate: "2999-12-31" }),
    "/api/transacoes?categoria_id=kN&de=1900-01-01&ate=2999-12-31");
  assert.equal(consultaTriagem(CAT_TRI, { de: "2026-09-01", ate: "2026-09-30" }),
    "/api/transacoes?categoria_id=kN&de=2026-09-01&ate=2026-09-30");
  assert.equal(consultaTriagem({ categorias: [{ id: "kO", nome: "Outros" }] }, { de: "a", ate: "b" }), null);
});

test("H5: no mês, N pendentes geram ceil(N/10) lotes ao abrir o chip; com 'Todos os meses', nenhum", () => {
  for (const n of [0, 1, 10, 11, 58]) {
    const ids = Array.from({ length: n }, (_, i) => `t${i}`);
    const lotes = lotesAoAbrirTriagem(ids, false);
    assert.equal(lotes.length, Math.ceil(n / 10), `n=${n}`);
    assert.ok(lotes.every((l) => l.length <= LOTE_TRIAGEM));
    assert.deepEqual(lotes.flat(), ids); // ninguém fica de fora nem repete
    assert.deepEqual(lotesAoAbrirTriagem(ids, true), []);
  }
  assert.equal(LOTE_TRIAGEM, 10);
});

test("H5: 'sugerir mais' (Todos os meses) manda 1 lote de até 10 ainda não pedidos por clique", () => {
  const ids = Array.from({ length: 25 }, (_, i) => `t${i}`);
  const pedidos = new Set();
  const l1 = loteSugerirMais(ids, pedidos);
  assert.equal(l1.length, 10);
  l1.forEach((id) => pedidos.add(id));
  const l2 = loteSugerirMais(ids, pedidos);
  assert.deepEqual(l2, ids.slice(10, 20));
  l2.forEach((id) => pedidos.add(id));
  assert.deepEqual(loteSugerirMais(ids, pedidos), ids.slice(20));
  ids.forEach((id) => pedidos.add(id));
  assert.deepEqual(loteSugerirMais(ids, pedidos), []);
});

test("H5: parseLimiar aceita vírgula ou ponto ('0,7' e '0.7' valem igual) e recusa fora de 0..1", () => {
  assert.equal(parseLimiar("0,7"), 0.7);
  assert.equal(parseLimiar("0.7"), 0.7);
  assert.equal(parseLimiar(" 0,70 "), 0.7);
  assert.equal(parseLimiar("1"), 1);
  assert.equal(parseLimiar("1,5"), null);
  assert.equal(parseLimiar("-0,1"), null);
  assert.equal(parseLimiar("abc"), null);
  assert.equal(parseLimiar(""), null);
});

test("H5: textoSugestao no formato 'Categoria › Sub · 0,74', só categoria sem sub, '—' no 'nenhuma serve'", () => {
  assert.equal(textoSugestao({ categoria: "Compras", subcategoria: "Compras", prob_categoria: 0.82 }), "Compras › Compras · 0,82");
  assert.equal(textoSugestao({ categoria: "Compras", subcategoria: null, prob_categoria: 0.4 }), "Compras · 0,40");
  assert.equal(textoSugestao({ categoria: "Alimentação", subcategoria: "Ifood", prob_categoria: 1 }), "Alimentação › Ifood · 1,00");
  assert.equal(textoSugestao({ categoria: "nenhuma serve", subcategoria: null, prob_categoria: 0.9 }), "—");
});

test("H5: celulaSugestao — 'nenhuma serve' mostra '—' sem botão aceitar; abaixo do limiar, sem botão", () => {
  const nenhuma = celulaSugestao({ categoria: "nenhuma serve", subcategoria: null, prob_categoria: 0.95, limiar: 0.7 }, CAT_TRI);
  assert.match(nenhuma, /—/);
  assert.doesNotMatch(nenhuma, /aceitar/);
  const baixa = celulaSugestao({ categoria: "Compras", subcategoria: null, prob_categoria: 0.4, limiar: 0.7 }, CAT_TRI);
  assert.match(baixa, /Compras · 0,40/);
  assert.doesNotMatch(baixa, /aceitar/);
  const alta = celulaSugestao({ categoria: "Compras", subcategoria: "Compras", prob_categoria: 0.82, limiar: 0.7 }, CAT_TRI);
  assert.match(alta, /Compras › Compras · 0,82/);
  assert.match(alta, /class="[^"]*traceitar[^"]*"[^>]*>aceitar</);
  // categoria que não existe (ou é a padrão) não tem como ser aceita
  assert.doesNotMatch(celulaSugestao({ categoria: "Sumida", subcategoria: null, prob_categoria: 0.99, limiar: 0.7 }, CAT_TRI), /aceitar/);
  assert.doesNotMatch(celulaSugestao({ categoria: "Não Identificado", subcategoria: null, prob_categoria: 0.99, limiar: 0.7 }, CAT_TRI), /aceitar/);
  // ainda sem sugestão: pedido em andamento x não pedido
  assert.match(celulaSugestao(undefined, CAT_TRI, { pedido: true }), /…/);
  assert.equal(celulaSugestao(undefined, CAT_TRI, { pedido: false }), "");
});

test("H5: resolverSugestao vai de nome a id pelo catálogo (sub fora da categoria → null)", () => {
  assert.deepEqual(resolverSugestao({ categoria: "Compras", subcategoria: "Amazon" }, CAT_TRI), { categoria_id: "kC", subcategoria_id: "c2" });
  assert.deepEqual(resolverSugestao({ categoria: "Compras", subcategoria: "Ifood" }, CAT_TRI), { categoria_id: "kC", subcategoria_id: null });
  assert.deepEqual(resolverSugestao({ categoria: "Outros", subcategoria: null }, CAT_TRI), { categoria_id: "kO", subcategoria_id: null });
  assert.equal(resolverSugestao({ categoria: "Não Identificado", subcategoria: null }, CAT_TRI), null);
  assert.equal(resolverSugestao({ categoria: "nenhuma serve", subcategoria: null }, CAT_TRI), null);
});

test("H5: guardarSugestoesTriagem grava a sugestão com o limiar pedido e devolve os ignorados", () => {
  const sug = {};
  const r = guardarSugestoesTriagem(sug, { itens: [
    { id: "t1", ignorado: false, sugestao: { categoria: "Compras", subcategoria: null, prob_categoria: 0.5, prob_subcategoria: null } },
    { id: "t2", ignorado: true, sugestao: null },
    { id: "t3", ignorado: false, sugestao: null },
  ], indisponivel: true }, 0.7);
  assert.deepEqual(sug, { t1: { categoria: "Compras", subcategoria: null, prob_categoria: 0.5, prob_subcategoria: null, limiar: 0.7 } });
  assert.deepEqual(r, { ignorados: ["t2"], indisponivel: true });
});

test("H5: Exemplo do card — 'aceitar todas ≥ 0,70' pega LOJA e IFD e deixa o FULANO", () => {
  const linhas = [txTri("loja"), txTri("fulano"), txTri("ifd")];
  const sug = {
    loja: { categoria: "Compras", subcategoria: "Compras", prob_categoria: 0.82, limiar: 0.7 },
    fulano: { categoria: "Compras", subcategoria: null, prob_categoria: 0.4, limiar: 0.7 },
    ifd: { categoria: "Alimentação", subcategoria: "Ifood", prob_categoria: 1, limiar: 0.7 },
  };
  const p = planoAceitarTodas(linhas, sug, CAT_TRI, parseLimiar("0,70"));
  assert.equal(p.n, 2);
  assert.deepEqual(p.lotes, [
    { ids: ["loja"], mudancas: { categoria_id: "kC", subcategoria_id: "c1" } },
    { ids: ["ifd"], mudancas: { categoria_id: "kA", subcategoria_id: "a1" } },
  ]);
});

test("H5: 'aceitar todas ≥ X' — limiar, pendentes de fora, 'nenhuma serve' de fora, agrupado por par", () => {
  const linhas = ["a", "b", "c", "d", "e", "f", "g"].map((id) => txTri(id));
  const sug = {
    a: { categoria: "Compras", subcategoria: "Amazon", prob_categoria: 0.9, limiar: 0.7 },
    b: { categoria: "Compras", subcategoria: "Amazon", prob_categoria: 0.75, limiar: 0.7 },
    c: { categoria: "Compras", subcategoria: "Compras", prob_categoria: 0.95, limiar: 0.7 },
    d: { categoria: "Compras", subcategoria: "Amazon", prob_categoria: 0.69, limiar: 0.7 }, // abaixo de X
    e: { categoria: "nenhuma serve", subcategoria: null, prob_categoria: 0.99, limiar: 0.7 }, // nunca entra
    // f: lote pendente (sem sugestão ainda) — não entra
    g: { categoria: "Outros", subcategoria: null, prob_categoria: 0.8, limiar: 0.7 },
  };
  const p = planoAceitarTodas(linhas, sug, CAT_TRI, 0.7);
  assert.equal(p.n, 4);
  assert.deepEqual(p.lotes, [
    { ids: ["a", "b"], mudancas: { categoria_id: "kC", subcategoria_id: "c2" } },
    { ids: ["c"], mudancas: { categoria_id: "kC", subcategoria_id: "c1" } },
    { ids: ["g"], mudancas: { categoria_id: "kO", subcategoria_id: null } },
  ]);
  // X mais alto corta mais; o 'nenhuma serve' segue fora até com X = 0
  assert.equal(planoAceitarTodas(linhas, sug, CAT_TRI, 0.9).n, 2);
  assert.ok(!planoAceitarTodas(linhas, sug, CAT_TRI, 0).lotes.some((l) => l.ids.includes("e")));
  // só linhas visíveis: a que já saiu da lista não volta pelo mapa de sugestões
  assert.equal(planoAceitarTodas(linhas.filter((l) => l.id !== "a"), sug, CAT_TRI, 0.7).n, 3);
});
