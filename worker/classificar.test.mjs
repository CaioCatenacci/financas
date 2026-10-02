import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizarDescritor, reconhecerNaoGasto, classificar } from "./classificar.js";
import { normalizarNome } from "./contraparte.js";

test("normalizarDescritor colapsa o mesmo estabelecimento entre meses", () => {
  assert.equal(normalizarDescritor("PIX QRS AMAZON.COM.30/12"), normalizarDescritor("PIX QRS AMAZON.COM.28/11"));
});

test("reconhece não-gasto", () => {
  assert.equal(reconhecerNaoGasto("PIX TRANSF PAOLA 10/12"), "Transferências");
  assert.equal(reconhecerNaoGasto("APLICACAO PERSONDIF INT"), "Investimentos");
  assert.equal(reconhecerNaoGasto("PIX QRS MAGALUPAY10/12"), null);
});

test("classificar não-gasto marca flag+categoria org (PIX TRANSF PAOLA segue conta própria)", () => {
  const r = classificar("PIX TRANSF PAOLA 10/12", {});
  assert.equal(r.computaResumo, false);
  assert.equal(r.categoriaOrg, "Transferências");
});

test("C1: 'PIX TRANSF CAIO …' no Itaú é a chegada da Wise — receita que conta por padrão, não conta própria", () => {
  // o nome vem cortado no Itaú; só o pareamento com um repasse do C6 tira essa linha do resumo
  // (db.marcarRepassesEntreContas), não o padrão fixo.
  const r = classificar("PIX TRANSF CAIO CA10/12", {});
  assert.equal(r.computaResumo, true);
  assert.equal(r.categoriaOrg, null);
  assert.equal(reconhecerNaoGasto("PIX TRANSF CAIO CA10/12"), null);
});

test("C1: descrição do C6 tira o prefixo 'Pix recebido de'/'Pix enviado para' (a regra aprendida casa pelo nome)", () => {
  assert.equal(normalizarDescritor("Pix recebido de LOJA FICTICIA"), "loja ficticia");
  assert.equal(normalizarDescritor("Pix enviado para LOJA FICTICIA"), "loja ficticia");
});

test("classificar gasto usa associação por normalizarNome(descritor)", () => {
  const chave = normalizarNome(normalizarDescritor("PIX QRS MAGALUPAY10/12"));
  const r = classificar("PIX QRS MAGALUPAY10/12", { [chave]: { categoriaNome: "Casa", subNome: "Mercado" } });
  assert.equal(r.categoriaNome, "Casa");
  assert.equal(r.subNome, "Mercado");
  assert.equal(r.computaResumo, true);
});

test("gasto sem associação → categoria null", () => {
  assert.equal(classificar("PIX QRS DESCONHECIDO01/01", {}).categoriaNome, null);
});
