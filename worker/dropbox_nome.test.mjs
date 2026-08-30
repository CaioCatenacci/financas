import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizar, caminhoDropbox, nomeArquivo } from "./dropbox_nome.js";

test("sanitizar remove caracteres proibidos e espaços", () => {
  assert.equal(sanitizar("Padaria / Café"), "Padaria-Café");
  assert.equal(sanitizar("a:b*c?"), "abc");
});

test("caminhoDropbox agrupa por ano/mês", () => {
  assert.equal(caminhoDropbox("2026-08-29"), "/Finanças/Comprovantes/2026/2026-08");
});

test("nomeArquivo monta o padrão", () => {
  assert.equal(
    nomeArquivo({ dataISO: "2026-08-29", macro: "Casa", sub: "Limpeza", valorCents: 1550, descricao: "padaria", ext: "jpg" }),
    "2026-08-29_Casa_Limpeza_15.50_padaria.jpg"
  );
});

test("nomeArquivo lida com sub nulo e descrição vazia", () => {
  assert.equal(
    nomeArquivo({ dataISO: "2026-08-29", macro: "Outros", sub: null, valorCents: 900, descricao: null, ext: "png" }),
    "2026-08-29_Outros_9.00.png"
  );
});
