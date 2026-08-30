import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpdate } from "./telegram.js";

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
  assert.equal(parseUpdate({ message: { chat: { id: 7 }, document: { file_id: "d", mime_type: "application/pdf" } } }).tipo, "pdf");
  const cb = parseUpdate({ callback_query: { message: { chat: { id: 7 }, message_id: 3 }, data: "del:xyz" } });
  assert.equal(cb.tipo, "callback");
  assert.equal(cb.data, "del:xyz");
});
