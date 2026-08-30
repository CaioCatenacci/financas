import { test } from "node:test";
import assert from "node:assert/strict";
import { chatPermitido, segredoTelegramValido, tokenValido } from "./auth.js";

test("chatPermitido falha fechada com lista vazia", () => {
  assert.equal(chatPermitido(123, ""), false);
  assert.equal(chatPermitido(123, undefined), false);
});

test("chatPermitido aceita id na lista", () => {
  assert.equal(chatPermitido(123, "123,456"), true);
  assert.equal(chatPermitido(999, "123,456"), false);
});

test("segredoTelegramValido compara header", () => {
  const req = new Request("https://x", { headers: { "X-Telegram-Bot-Api-Secret-Token": "s3" } });
  assert.equal(segredoTelegramValido(req, "s3"), true);
  assert.equal(segredoTelegramValido(req, "outro"), false);
});

test("segredoTelegramValido falha fechada com segredo vazio ou ausente", () => {
  const req = new Request("https://x", { headers: { "X-Telegram-Bot-Api-Secret-Token": "s3" } });
  assert.equal(segredoTelegramValido(req, ""), false);
  assert.equal(segredoTelegramValido(req, undefined), false);
});

test("tokenValido aceita query e cookie, recusa vazio", () => {
  const q = new Request("https://x/app?token=abc");
  assert.equal(tokenValido(q, "abc"), true);
  const c = new Request("https://x/app", { headers: { Cookie: "token=abc" } });
  assert.equal(tokenValido(c, "abc"), true);
  assert.equal(tokenValido(q, ""), false);
  assert.equal(tokenValido(q, undefined), false);
});

test("tokenValido preserva tokens com '=' (base64)", () => {
  const c = new Request("https://x/app", { headers: { Cookie: "token=ab==" } });
  assert.equal(tokenValido(c, "ab=="), true);
});
