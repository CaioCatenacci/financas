import { test } from "node:test";
import assert from "node:assert/strict";
import { montarPreviewExtrato, montarPreviewFatura, aplicar, conferirPreviaCasados } from "./importar.js";
import { linhaHash } from "./reconciliar.js";

const catalogo = { categorias: [{ id: "cO", nome: "Outros" }, { id: "cT", nome: "Transferências" }], subcategorias: [] };

const TXT = `10/12/2025 SALDO DO DIA 8.876,46
10/12/2025 PIX QRS LOJA X10/12 -100,00
09/12/2025 SALDO DO DIA 8.976,46`;

test("preview extrato: novo + checksum ok", () => {
  const p = montarPreviewExtrato(TXT, "c1", { catalogo, associacoes: {}, existentes: [], hashes: [] });
  assert.equal(p.checksum.ok, true);
  assert.equal(p.resumo.novos, 1);
});

test("preview extrato: casa existente (não duplica)", () => {
  const p = montarPreviewExtrato(TXT, "c1", {
    catalogo, associacoes: {},
    existentes: [{ id: "t9", data: "2025-12-10", valorCents: 10000 }], hashes: [],
  });
  assert.equal(p.resumo.casados, 1);
  assert.equal(p.resumo.novos, 0);
  assert.equal(p.itens.find(i => i.status === "casado").matchId, "t9");
});

test("preview extrato: checksum inválido sinaliza mas ainda devolve preview", () => {
  const txtQuebrado = `10/12/2025 SALDO DO DIA 8.876,46
10/12/2025 PIX QRS LOJA X10/12 -100,00
09/12/2025 SALDO DO DIA 8.000,00`; // diferença proposital
  const p = montarPreviewExtrato(txtQuebrado, "c1", { catalogo, associacoes: {}, existentes: [], hashes: [] });
  assert.equal(p.checksum.ok, false);
  assert.notEqual(p.checksum.diferencaCents, 0);
  // mesmo com checksum quebrado, o preview continua classificando os itens
  assert.equal(p.resumo.novos, 1);
});

test("preview extrato: linha não-gasto não computa resumo e não reconcilia", () => {
  const txtNaoGasto = `10/12/2025 SALDO DO DIA 8.876,46
10/12/2025 PIX TRANSF CAIO 10/12 -500,00
09/12/2025 SALDO DO DIA 9.376,46`;
  const p = montarPreviewExtrato(txtNaoGasto, "c1", {
    catalogo, associacoes: {},
    existentes: [{ id: "t1", data: "2025-12-10", valorCents: 50000 }], // mesmo valor, mas não-gasto não reconcilia
    hashes: [],
  });
  assert.equal(p.resumo.naoGasto, 1);
  assert.equal(p.resumo.casados, 0);
  const item = p.itens.find(i => i.status === "naoGasto");
  assert.equal(item.computaResumo, false);
  assert.equal(item.categoriaOrg, "Transferências");
  assert.equal(item.matchId, null);
});

test("preview extrato: ambíguo quando há mais de um candidato no mesmo valor/janela", () => {
  const p = montarPreviewExtrato(TXT, "c1", {
    catalogo, associacoes: {},
    existentes: [
      { id: "a", data: "2025-12-10", valorCents: 10000 },
      { id: "b", data: "2025-12-11", valorCents: 10000 },
    ],
    hashes: [],
  });
  assert.equal(p.resumo.ambiguos, 1);
  assert.equal(p.itens.find(i => i.status === "ambiguo").matchId, null);
});

test("preview extrato: idempotência — hash já em hashes vira jaTem", () => {
  const lh = linhaHash("c1", "2025-12-10", "PIX QRS LOJA X10/12", 10000, 0);
  const p = montarPreviewExtrato(TXT, "c1", { catalogo, associacoes: {}, existentes: [], hashes: [lh] });
  assert.equal(p.resumo.jaTem, 1);
  assert.equal(p.resumo.novos, 0);
  assert.equal(p.itens.find(i => i.status === "jaTem").linhaHash, lh);
});

test("montarPreviewExtrato: item casado carrega o matchGrupoId da candidata (null se ela está solta)", () => {
  const solta = montarPreviewExtrato(TXT, "c1", { catalogo, associacoes: {}, existentes: [{ id: "t9", data: "2025-12-10", valorCents: 10000 }], hashes: [] });
  const casado = solta.itens.find(i => i.status === "casado");
  assert.equal(casado.matchId, "t9");
  assert.equal(casado.matchGrupoId, null);
  assert.ok(solta.itens.filter(i => i.status !== "casado").every(i => i.matchGrupoId === null), "não-casados levam null");
  const agrupada = montarPreviewExtrato(TXT, "c1", { catalogo, associacoes: {}, existentes: [{ id: "t9", data: "2025-12-10", valorCents: 10000, grupo_id: "G0" }], hashes: [] });
  assert.equal(agrupada.itens.find(i => i.status === "casado").matchGrupoId, "G0");
});

test("preview extrato: casamento consome a candidata do lote (2ª linha igual não recasa)", () => {
  const txtDuasIguais = `11/12/2025 SALDO DO DIA 9.176,46
10/12/2025 PIX QRS LOJA X10/12 -100,00
10/12/2025 PIX QRS LOJA Y10/12 -100,00
09/12/2025 SALDO DO DIA 9.376,46`;
  const p = montarPreviewExtrato(txtDuasIguais, "c1", {
    catalogo, associacoes: {},
    existentes: [{ id: "t9", data: "2025-12-10", valorCents: 10000 }],
    hashes: [],
  });
  assert.equal(p.resumo.casados, 1);
  assert.equal(p.resumo.novos, 1); // a segunda linha, mesmo valor, não encontra mais candidata -> novo
});

// ---- fatura ----

const TXT_FATURA = `                DATA       ESTABELECIMENTO                       VALOR EM R$
                29/05      PARK E CO ESTACIONAME                          17,00        Juros 10,50
                03/05      LOJA XPTO PARCELA 03/10                        150,00
                Lançamentos no cartão (final 7857)                       167,00
                Total dos lançamentos atuais                             167,00`;

test("preview fatura: itens novos, checksum ok (itens==total)", () => {
  const p = montarPreviewFatura(TXT_FATURA, 2025, "05", { catalogo, associacoes: {}, hashes: [] });
  assert.equal(p.checksum.ok, true);
  assert.equal(p.resumo.novos, 2);
  assert.equal(p.resumo.casados, 0); // fatura não reconcilia contra existentes
  assert.equal(p.totalCents, 16700); // total impresso exposto p/ marcar o pagamento no extrato
});

test("preview fatura: item que casaria padrão de não-gasto continua gasto (invariante 'sempre gasto')", () => {
  // "LOJA CDB MOVEIS" bate no padrão \bCDB\b de reconhecerNaoGasto; numa fatura, mesmo assim
  // é gasto de cartão — só o pagamento da fatura (no extrato) é não-gasto. Sem linha de total
  // → checksum trivialmente ok, o foco do teste é o status do item.
  const txt = `                DATA       ESTABELECIMENTO                       VALOR EM R$
                29/05      LOJA CDB MOVEIS                               200,00`;
  const p = montarPreviewFatura(txt, 2025, "05", { catalogo, associacoes: {}, hashes: [] });
  assert.equal(p.resumo.novos, 1);
  assert.equal(p.resumo.naoGasto, 0);
  const item = p.itens[0];
  assert.equal(item.status, "novo");
  assert.equal(item.computaResumo, true);
  assert.equal(item.categoriaOrg, null);
});

test("preview fatura: dedup por hash (jaTem)", () => {
  const lh0 = linhaHash("fatura-202505", "2025-05-29", "PARK E CO ESTACIONAME", 1700, 0);
  const p = montarPreviewFatura(TXT_FATURA, 2025, "05", { catalogo, associacoes: {}, hashes: [lh0] });
  assert.equal(p.resumo.jaTem, 1);
  assert.equal(p.resumo.novos, 1);
});

test("preview fatura: estorno (valor negativo) vira receita com valor POSITIVO (não viola check >= 0)", () => {
  const txt = `                DATA       ESTABELECIMENTO                       VALOR EM R$
                05/06      LOJA X                          100,00
                06/06      LOJA X ESTORNO                          - 30,00
                Total dos lançamentos atuais                             70,00`;
  const p = montarPreviewFatura(txt, 2025, "06", { catalogo, associacoes: {}, hashes: [] });
  assert.equal(p.checksum.ok, true);           // net 100 - 30 == total 70
  assert.equal(p.checksum.diferencaCents, 0);
  const compra = p.itens.find(i => i.descricao === "LOJA X");
  const estorno = p.itens.find(i => i.descricao.includes("ESTORNO"));
  assert.equal(compra.natureza, "despesa");
  assert.equal(compra.valorCents, 10000);
  assert.equal(estorno.natureza, "receita");   // crédito
  assert.equal(estorno.valorCents, 3000);      // POSITIVO — valor_total no banco é sempre >= 0
});

// ---- aplicar ----

test("aplicar: delega o lote inteiro p/ db.aplicarImportacao (uma transação, não linha a linha)", async () => {
  let recebido = null;
  const db = {
    async aplicarImportacao(d) {
      recebido = d;
      return { gravados: d.novos.length + d.naoGasto.length, agrupados: d.casados.length, naoGasto: d.naoGasto.length };
    },
    // se aplicar voltasse a chamar linha a linha, estes explodiriam o teste
    async inserirTransacao() { throw new Error("não deve inserir linha a linha"); },
    async carimbarLinhaHash() { throw new Error("não deve carimbar linha a linha"); },
  };
  const decisao = {
    novos: [{ descricao: "a", categoria_id: "cO" }],
    naoGasto: [{ descricao: "b", categoria_id: "cT" }],
    casados: [{ matchId: "t9", linhaHash: "abc123" }],
  };
  const r = await aplicar(db, decisao);
  assert.deepEqual(recebido, decisao);                 // passou a decisão inteira
  assert.deepEqual(r, { gravados: 2, agrupados: 1, naoGasto: 1 });
});

// ---- F2: prévia velha ----
// Entre a prévia e o aplicar o Caio pode desagrupar, reagrupar ou apagar o lançamento casado. Se
// o aplicar gravasse assim mesmo, a linha do extrato entraria num grupo sem representante (e
// deixaria de contar no Resumo). A regra é pura: recebe os casados e o que foi lido do banco agora.
const RECUSA = { ok: false, erro: "a prévia ficou velha, gere de novo" };
const casadoEm = (grupo_id, grupoExistente, matchId = "L1") =>
  ({ matchId, grupoExistente, linha: { descricao: "x", grupo_id, representante: false } });
const L = (grupo_id, representante = false) =>
  ({ id: "L1", fonte: "manual", criado_em: "2026-09-01", grupo_id, representante, valor_final: "10.00" });

test("conferirPreviaCasados: grupo da prévia sumiu (sem membros no banco) → recusa", () => {
  // L apagado junto: o único jeito do caso 'grupo não existe' não cair também no 'L mudou de grupo'
  assert.deepEqual(conferirPreviaCasados([casadoEm("G0", true)], { linhas: [], membros: [] }), RECUSA);
  // e com L ainda lá, mas solto (grupo desfeito): também recusa
  assert.deepEqual(conferirPreviaCasados([casadoEm("G0", true)], { linhas: [L(null)], membros: [] }), RECUSA);
});

test("conferirPreviaCasados: grupo existe mas ninguém é representante → recusa", () => {
  const membros = [L("G0", false), { ...L("G0", false), id: "L2" }];
  assert.deepEqual(conferirPreviaCasados([casadoEm("G0", true)], { linhas: [L("G0", false)], membros }), RECUSA);
});

test("conferirPreviaCasados: lançamento casado mudou de grupo (ou saiu dele, ou entrou num) → recusa", () => {
  // prévia viu G0, agora L está em G9
  assert.deepEqual(conferirPreviaCasados([casadoEm("G0", true)],
    { linhas: [L("G9", true)], membros: [L("G9", true)] }), RECUSA);
  // prévia viu G0, agora L está solto
  assert.deepEqual(conferirPreviaCasados([casadoEm("G0", true)],
    { linhas: [L(null)], membros: [] }), RECUSA);
  // prévia viu L solto (grupo novo), agora L está em G9
  assert.deepEqual(conferirPreviaCasados([casadoEm("Gnovo", false)],
    { linhas: [L("G9", true)], membros: [L("G9", true)] }), RECUSA);
});

test("conferirPreviaCasados: lançamento casado foi apagado → recusa", () => {
  assert.deepEqual(conferirPreviaCasados([casadoEm("Gnovo", false)], { linhas: [], membros: [] }), RECUSA);
});

test("conferirPreviaCasados: grupo existe com representante → aceita", () => {
  const membros = [L("G0", true), { ...L("G0", false), id: "L2" }];
  assert.deepEqual(conferirPreviaCasados([casadoEm("G0", true)], { linhas: [L("G0", true)], membros }), { ok: true });
  // o representante pode ser outro membro que não o casado
  assert.deepEqual(conferirPreviaCasados([casadoEm("G0", true)],
    { linhas: [L("G0", false)], membros: [L("G0", false), { ...L("G0", true), id: "L2" }] }), { ok: true });
});

test("conferirPreviaCasados: L segue solto com grupoExistente=false → aceita", () => {
  assert.deepEqual(conferirPreviaCasados([casadoEm("Gnovo", false)], { linhas: [L(null)], membros: [] }), { ok: true });
});

test("conferirPreviaCasados: um casado velho num lote bom recusa o lote inteiro", () => {
  const casados = [casadoEm("Gnovo", false), casadoEm("Gnovo2", false, "L-apagado")];
  assert.deepEqual(conferirPreviaCasados(casados, { linhas: [L(null)], membros: [] }), RECUSA);
});

test("conferirPreviaCasados: sem casados → aceita", () => {
  assert.deepEqual(conferirPreviaCasados([], { linhas: [], membros: [] }), { ok: true });
});
