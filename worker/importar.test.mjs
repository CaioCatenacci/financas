import { test } from "node:test";
import assert from "node:assert/strict";
import { montarPreviewExtrato, montarPreviewFatura, aplicar } from "./importar.js";
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

// ---- aplicar ----

test("aplicar: delega o lote inteiro p/ db.aplicarImportacao (uma transação, não linha a linha)", async () => {
  let recebido = null;
  const db = {
    async aplicarImportacao(d) {
      recebido = d;
      return { gravados: d.novos.length + d.naoGasto.length, conciliados: d.casados.length, naoGasto: d.naoGasto.length };
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
  assert.deepEqual(r, { gravados: 2, conciliados: 1, naoGasto: 1 });
});
