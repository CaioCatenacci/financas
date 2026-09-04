import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpdate, downloadArquivo } from "./telegram.js";

test("parseUpdate reconhece foto (maior tamanho)", () => {
  const u = { message: { chat: { id: 7 }, message_id: 1, photo: [
    { file_id: "a", width: 90 }, { file_id: "b", width: 800 } ] } };
  const r = parseUpdate(u);
  assert.equal(r.tipo, "imagem");
  assert.equal(r.fileId, "b");
  assert.equal(r.chatId, 7);
});

test("parseUpdate reconhece documento-imagem", () => {
  const u = { message: { chat: { id: 7 }, document: { file_id: "d", mime_type: "image/png" } } };
  const r = parseUpdate(u);
  assert.equal(r.tipo, "imagem");
  assert.equal(r.mime, "image/png");
});

test("parseUpdate marca pdf e callback", () => {
  const pdf = parseUpdate({ message: { chat: { id: 7 }, message_id: 5, document: { file_id: "d", mime_type: "application/pdf" }, caption: "comprovante" } });
  assert.equal(pdf.tipo, "pdf");
  assert.equal(pdf.fileId, "d");
  assert.equal(pdf.mime, "application/pdf");
  assert.equal(pdf.messageId, 5);
  assert.equal(pdf.caption, "comprovante");
  const cb = parseUpdate({ callback_query: { message: { chat: { id: 7 }, message_id: 3 }, data: "del:xyz" } });
  assert.equal(cb.tipo, "callback");
  assert.equal(cb.data, "del:xyz");
});

test("parseUpdate captura caption da foto", () => {
  const u = { message: { chat: { id: 7 }, message_id: 1, caption: "/aprender Casa", photo: [{ file_id: "b", width: 800 }] } };
  const r = parseUpdate(u);
  assert.equal(r.caption, "/aprender Casa");
});

test("parseUpdate retorna null para caption ausente", () => {
  const u = { message: { chat: { id: 7 }, message_id: 1, photo: [{ file_id: "b", width: 800 }] } };
  const r = parseUpdate(u);
  assert.equal(r.caption, null);
});

test("downloadArquivo detecta mime por extensão: PDF", async () => {
  const fetchStub = async (url) => {
    if (url.includes("getFile")) {
      return { json: async () => ({ result: { file_path: "documents/x.pdf" } }) };
    }
    // file download
    return { arrayBuffer: async () => new ArrayBuffer(10) };
  };
  const result = await downloadArquivo("token", "fileId", fetchStub);
  assert.equal(result.mime, "application/pdf");
  assert.ok(result.bytes instanceof Uint8Array);
});

test("downloadArquivo detecta mime por extensão: PNG", async () => {
  const fetchStub = async (url) => {
    if (url.includes("getFile")) {
      return { json: async () => ({ result: { file_path: "photos/y.png" } }) };
    }
    return { arrayBuffer: async () => new ArrayBuffer(10) };
  };
  const result = await downloadArquivo("token", "fileId", fetchStub);
  assert.equal(result.mime, "image/png");
});

test("downloadArquivo detecta mime por extensão: JPEG (padrão)", async () => {
  const fetchStub = async (url) => {
    if (url.includes("getFile")) {
      return { json: async () => ({ result: { file_path: "photos/z.jpg" } }) };
    }
    return { arrayBuffer: async () => new ArrayBuffer(10) };
  };
  const result = await downloadArquivo("token", "fileId", fetchStub);
  assert.equal(result.mime, "image/jpeg");
});
