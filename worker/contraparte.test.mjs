import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizarNome, normalizarChave, derivarChave } from "./contraparte.js";

test("normalizarNome: maiúsculas, sem acento, espaços colapsados", () => {
  assert.equal(normalizarNome("  Viviane   Ferrer  Borgato "), "VIVIANE FERRER BORGATO");
  assert.equal(normalizarNome("Educação"), "EDUCACAO");
  assert.equal(normalizarNome(""), null);
  assert.equal(normalizarNome(null), null);
});

test("normalizarChave: telefone/CPF viram só dígitos; e-mail minúsculo; chave aleatória preservada", () => {
  assert.equal(normalizarChave("+55 (19) 99578-3408"), "5519995783408");
  assert.equal(normalizarChave("***.923.318-**"), "923318");
  assert.equal(normalizarChave("  Fulano@Email.COM "), "fulano@email.com");
  assert.equal(normalizarChave("3FA85F64-5717-4562-B3FC-2C963F66AFA6"), "3fa85f64-5717-4562-b3fc-2c963f66afa6");
  assert.equal(normalizarChave(""), null);
});

test("derivarChave prioriza chave pix/cpf; cai pro nome", () => {
  assert.deepEqual(derivarChave({ contraparte_chave: "+5519995783408", contraparte_nome: "X" }),
    { chave: "5519995783408", tipo: "pix_cpf" });
  assert.deepEqual(derivarChave({ contraparte_chave: null, contraparte_nome: "Viviane Ferrer" }),
    { chave: "VIVIANE FERRER", tipo: "nome" });
  assert.equal(derivarChave({ contraparte_chave: null, contraparte_nome: null }), null);
});
