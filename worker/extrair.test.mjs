import { test } from "node:test";
import assert from "node:assert/strict";
import { extrair, blocoConteudoClaude } from "./extrair.js";

const CATS = [{ macro: "Casa", sub: "Limpeza" }, { macro: "Saúde", sub: null }];
const bom = { data: "2026-08-29", valor: "15,50", descricao: "x", natureza: "despesa", macro: "Casa", sub: "Limpeza" };

test("usa Gemini quando confiança >= limiar", async () => {
  const deps = {
    limiar: 0.6,
    callGemini: async () => ({ campos: bom, confianca: 0.9 }),
    callClaude: async () => { throw new Error("não devia chamar"); },
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", CATS, deps);
  assert.equal(r.ok, true);
  assert.equal(r.extraido_por, "gemini");
  assert.equal(r.normalizado.valorCents, 1550);
});

test("cai pro Claude quando Gemini lança", async () => {
  const deps = {
    limiar: 0.6,
    callGemini: async () => { throw new Error("boom"); },
    callClaude: async () => ({ campos: bom, confianca: 0.8 }),
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", CATS, deps);
  assert.equal(r.ok, true);
  assert.equal(r.extraido_por, "claude");
});

test("cai pro Claude quando Gemini vem com confiança baixa", async () => {
  const deps = {
    limiar: 0.6,
    callGemini: async () => ({ campos: bom, confianca: 0.3 }),
    callClaude: async () => ({ campos: bom, confianca: 0.95 }),
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", CATS, deps);
  assert.equal(r.extraido_por, "claude");
});

test("último recurso: Gemini válido de baixa confiança quando Claude falha", async () => {
  const deps = {
    limiar: 0.6,
    callGemini: async () => ({ campos: bom, confianca: 0.3 }), // válido, mas baixo
    callClaude: async () => { throw new Error("claude fora"); },
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", CATS, deps);
  assert.equal(r.ok, true);
  assert.equal(r.extraido_por, "gemini");
  assert.equal(r.confianca, 0.3);
});

test("falha quando ambos inválidos", async () => {
  const ruim = { ...bom, valor: "xx" };
  const deps = {
    limiar: 0.6,
    callGemini: async () => ({ campos: ruim, confianca: 0.9 }),
    callClaude: async () => ({ campos: ruim, confianca: 0.9 }),
  };
  const r = await extrair(new Uint8Array(), "image/jpeg", CATS, deps);
  assert.equal(r.ok, false);
  assert.ok(r.erros.length > 0);
});

test("blocoConteudoClaude: imagem usa bloco image", () => {
  const b = blocoConteudoClaude("image/jpeg", "AAAA");
  assert.equal(b.type, "image");
  assert.equal(b.source.media_type, "image/jpeg");
  assert.equal(b.source.data, "AAAA");
});

test("blocoConteudoClaude: pdf usa bloco document", () => {
  const b = blocoConteudoClaude("application/pdf", "AAAA");
  assert.equal(b.type, "document");
  assert.equal(b.source.type, "base64");
  assert.equal(b.source.media_type, "application/pdf");
  assert.equal(b.source.data, "AAAA");
});
