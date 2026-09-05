import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFatura } from "./fatura.js";

const TXT = `                DATA       ESTABELECIMENTO                       VALOR EM R$
                29/05      PARK E CO ESTACIONAME                          17,00        Juros 10,50
                03/05      LOJA XPTO PARCELA 03/10                        150,00
                Lançamentos no cartão (final 7857)                       167,00
                Total dos lançamentos atuais                             167,00`;

test("parseia itens com ano do período; ignora subtotal/header/total", () => {
  const r = parseFatura(TXT, 2025);
  assert.equal(r.itens.length, 2);
  assert.equal(r.itens[0].data, "2025-05-29");
  assert.equal(r.itens[0].valorCents, 1700); // 1º money após a data (não o 10,50 do juros)
});

test("captura parcela e não confunde x/y com dinheiro", () => {
  const p = parseFatura(TXT, 2025).itens.find(i => i.descricao.includes("XPTO"));
  assert.equal(p.parcela, "03/10");
  assert.equal(p.valorCents, 15000);
});

test("total e checksum itens==total", () => {
  const r = parseFatura(TXT, 2025);
  assert.equal(r.totalCents, 16700);
  assert.equal(r.itens.reduce((a, i) => a + i.valorCents, 0), r.totalCents);
});

// ---- fatura densa real: 2 colunas, estorno, subtotal+item na mesma linha, parcelas futuras ----
// Modela os padrões de uma fatura Itaú real (sem dados reais no repo).
const TXT_DENSA = `Postagem: 29/06/2025
Pagamento efetuado em 06/06/2025                    - 17,00
DATA     ESTABELECIMENTO                    VALOR EM R$
16/06     LOJA A                    100,00          05/06     LOJA B                    50,00
17/06     LOJA C REEMBOLSO                    - 10,00
ALIMENTAÇÃO .X
Lançamentos no cartão (final 1234)                    140,00           18/06     LOJA D                    30,00
04/06     LOJA E PARC 01/03                    25,00
L  Total dos lançamentos atuais                    195,00
Compras parceladas - próximas faturas
04/06     LOJA E PARC 02/03                    25,00
19/06     LOJA FUTURA                    999,00`;

test("fatura densa: captura os DOIS lançamentos de uma linha de 2 colunas", () => {
  const r = parseFatura(TXT_DENSA, 2025);
  const a = r.itens.find(i => i.descricao === "LOJA A");
  const b = r.itens.find(i => i.descricao === "LOJA B");
  assert.ok(a && b, "deve pegar o item da esquerda E o da direita");
  assert.equal(a.valorCents, 10000);
  assert.equal(b.valorCents, 5000);
});

test("fatura densa: estorno vira valor NEGATIVO", () => {
  const c = parseFatura(TXT_DENSA, 2025).itens.find(i => i.descricao.includes("REEMBOLSO"));
  assert.equal(c.valorCents, -1000);
});

test("fatura densa: item grudado numa linha de subtotal é capturado", () => {
  const d = parseFatura(TXT_DENSA, 2025).itens.find(i => i.descricao === "LOJA D");
  assert.ok(d, "o 18/06 LOJA D estava na mesma linha do subtotal e não pode se perder");
  assert.equal(d.valorCents, 3000);
});

test("fatura densa: PARA no total — não conta parcelas de próximas faturas nem itens após o total", () => {
  const r = parseFatura(TXT_DENSA, 2025);
  assert.equal(r.totalCents, 19500);
  assert.ok(!r.itens.some(i => i.valorCents === 99900), "LOJA FUTURA (após o total) não entra");
  assert.equal(r.itens.filter(i => i.valorCents === 2500).length, 1, "só a parcela 01/03 do período, não a 02/03 futura");
});

test("fatura densa: exclui 'Pagamento efetuado' (data DD/MM/AAAA, não DD/MM)", () => {
  const r = parseFatura(TXT_DENSA, 2025);
  assert.ok(!r.itens.some(i => i.valorCents === -1700), "o pagamento -17,00 do cabeçalho não é lançamento");
});

test("fatura densa: soma dos itens == total (checksum fecha neste caso sem IOF)", () => {
  const r = parseFatura(TXT_DENSA, 2025);
  assert.equal(r.itens.length, 5);
  assert.equal(r.itens.reduce((a, i) => a + i.valorCents, 0), 19500);
});

test("fatura densa: extrai a parcela do fim do estabelecimento", () => {
  const e = parseFatura(TXT_DENSA, 2025).itens.find(i => i.descricao.includes("LOJA E"));
  assert.equal(e.parcela, "01/03");
  assert.ok(!/\d{2}\/\d{2}$/.test(e.descricao), "a descrição não termina com a parcela");
});
