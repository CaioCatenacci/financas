import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizar, caminhoDropbox, nomeArquivo, caminhoArquivoImport } from "./dropbox_nome.js";

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

// ---- C4: arquivo original do import ----
test("extrato Itaú vai para Extratos/itau com o período no nome (Exemplo do C4)", () => {
  assert.equal(
    caminhoArquivoImport({ tipo: "extrato", banco: "itau", de: "2026-09-03", ate: "2026-10-13" }),
    "/Finanças/Extratos/itau/2026-09-03_a_2026-10-13_itau_extrato.pdf"
  );
});

test("extrato C6 vai para Extratos/c6, mesmo formato do Itaú", () => {
  assert.equal(
    caminhoArquivoImport({ tipo: "extrato", banco: "c6", de: "2026-08-01", ate: "2026-08-31" }),
    "/Finanças/Extratos/c6/2026-08-01_a_2026-08-31_c6_extrato.pdf"
  );
});

test("fatura vai para Faturas/<banco> pelo mês do vencimento (Exemplo do C4)", () => {
  assert.equal(
    caminhoArquivoImport({ tipo: "fatura", banco: "itau", mes: "2026-10" }),
    "/Finanças/Faturas/itau/2026-10_itau_fatura.pdf"
  );
});

test("Wise é extrato em CSV: a extensão segue o arquivo que a Wise exporta", () => {
  assert.equal(
    caminhoArquivoImport({ tipo: "extrato", banco: "wise", de: "2026-07-01", ate: "2026-09-30" }),
    "/Finanças/Extratos/wise/2026-07-01_a_2026-09-30_wise_extrato.csv"
  );
});

test("o mesmo período dá sempre o mesmo caminho: é o que faz o overwrite substituir", () => {
  const a = { tipo: "extrato", banco: "itau", de: "2026-09-03", ate: "2026-10-13" };
  assert.equal(caminhoArquivoImport(a), caminhoArquivoImport({ ...a }));
});

test("vocabulário ou período inválido → null (a rota recusa em vez de inventar nome)", () => {
  assert.equal(caminhoArquivoImport({ tipo: "comprovante", banco: "itau", de: "2026-09-03", ate: "2026-10-13" }), null);
  assert.equal(caminhoArquivoImport({ tipo: "extrato", banco: "nubank", de: "2026-09-03", ate: "2026-10-13" }), null);
  assert.equal(caminhoArquivoImport({ tipo: "extrato", banco: "itau" }), null);
  assert.equal(caminhoArquivoImport({ tipo: "extrato", banco: "itau", de: "2026-10-13", ate: "2026-09-03" }), null);
  assert.equal(caminhoArquivoImport({ tipo: "extrato", banco: "itau", de: "03/09/2026", ate: "2026-10-13" }), null);
  assert.equal(caminhoArquivoImport({ tipo: "fatura", banco: "itau", mes: "2026-1" }), null);
  assert.equal(caminhoArquivoImport({ tipo: "fatura", banco: "itau" }), null);
  // path traversal pela query não passa: o período tem formato fixo
  assert.equal(caminhoArquivoImport({ tipo: "fatura", banco: "itau", mes: "../../x" }), null);
});
