// H5 — regras puras da triagem (quem entra, o que o lote aceita). A rota com fetch falso mora em
// index.test.mjs; aqui só o que não precisa de rede nem de banco. Valores inventados.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validarLoteTriagem, vaiATriagem, TRIAGEM_LOTE_MAX, LIMIAR_TRIAGEM } from "./triagem.js";
import { LOTE_MAX } from "./jev.js";

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// a padrão foi renomeada de propósito: a triagem acha a padrão pela flag, nunca pelo nome
const CAT = {
  categorias: [
    { id: "kP", nome: "Pendentes", natureza: "despesa", padrao: true },
    { id: "kN", nome: "Não Identificado", natureza: "despesa", padrao: false },
    { id: "kC", nome: "Compras", natureza: "despesa", padrao: false },
  ],
  subcategorias: [],
};
const linha = (extra = {}) => ({ id: U(1), descricao: "LOJA X", natureza: "despesa", fonte: "fatura",
  categoria_id: "kP", grupo_id: null, representante: false, valor_cents: "1234", ...extra });

test("o teto do lote da triagem é 10 e o do import segue 20", () => {
  assert.equal(TRIAGEM_LOTE_MAX, 10);
  assert.equal(LOTE_MAX, 20);
  assert.equal(LIMIAR_TRIAGEM, 0.7);
});

test("validarLoteTriagem: 10 passa, 11 não; limiar ausente vira 0,70; ids repetidos colapsam", () => {
  const dez = Array.from({ length: 10 }, (_, i) => U(i));
  assert.deepEqual(validarLoteTriagem({ ids: dez }), { ids: dez, limiar: 0.7 });
  assert.ok(validarLoteTriagem({ ids: [...dez, U(10)] }).erro);
  assert.deepEqual(validarLoteTriagem({ ids: [U(1), U(1)], limiar: 0.5 }), { ids: [U(1)], limiar: 0.5 });
  assert.ok(validarLoteTriagem({ ids: [U(1)], limiar: "0,7" }).erro); // a tela já manda número
  assert.ok(validarLoteTriagem({ ids: [U(1)], limiar: -0.1 }).erro);
  assert.ok(validarLoteTriagem({ ids: ["1; drop"] }).erro);
  assert.ok(validarLoteTriagem(null).erro);
});

test("vaiATriagem: só a padrão (pela flag), solta ou representante", () => {
  assert.equal(vaiATriagem(linha(), CAT), true);
  assert.equal(vaiATriagem(linha({ categoria_id: "kN" }), CAT), false); // nome antigo da padrão não conta
  assert.equal(vaiATriagem(linha({ categoria_id: "kC" }), CAT), false);
  assert.equal(vaiATriagem(linha({ grupo_id: U(9), representante: false }), CAT), false);
  assert.equal(vaiATriagem(linha({ grupo_id: U(9), representante: true }), CAT), true);
  assert.equal(vaiATriagem(linha({ descricao: "  " }), CAT), false);
  assert.equal(vaiATriagem(linha({ fonte: "outra" }), CAT), false);
  assert.equal(vaiATriagem(undefined, CAT), false);
  assert.equal(vaiATriagem(linha(), { categorias: [], subcategorias: [] }), false);
});
