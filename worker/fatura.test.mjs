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
