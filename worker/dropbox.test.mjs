import { test } from "node:test";
import assert from "node:assert/strict";
import { subirDropbox, argUpload } from "./dropbox.js";

// Dropbox falso: responde o token e o upload, e guarda o Dropbox-API-Arg de cada upload.
function fetchFalso() {
  const uploads = [];
  const f = async (url, init) => {
    if (String(url).includes("oauth2/token")) return { ok: true, json: async () => ({ access_token: "tok" }) };
    uploads.push({ arg: JSON.parse(init.headers["Dropbox-API-Arg"]), body: init.body });
    return { ok: true, json: async () => ({ path_display: "/x" }) };
  };
  f.uploads = uploads;
  return f;
}

test("subirDropbox sem modo segue com add + autorename: comprovantes e /patrimonio não podem sobrescrever", async () => {
  const f = fetchFalso();
  await subirDropbox({}, "/Finanças/Comprovantes/2026/2026-08/a.jpg", new Uint8Array([1]), f);
  assert.deepEqual(f.uploads[0].arg, { path: "/Finanças/Comprovantes/2026/2026-08/a.jpg", mode: "add", autorename: true });
});

test("subirDropbox com overwrite substitui sem autorename (reimportar o mesmo período não cria '(1)')", async () => {
  const f = fetchFalso();
  await subirDropbox({}, "/Finanças/Faturas/itau/2026-10_itau_fatura.pdf", new Uint8Array([1]), f, "overwrite");
  assert.deepEqual(f.uploads[0].arg, { path: "/Finanças/Faturas/itau/2026-10_itau_fatura.pdf", mode: "overwrite" });
  assert.notEqual(f.uploads[0].arg.autorename, true);
});

test("argUpload: modo desconhecido cai no add (o padrão seguro nunca apaga arquivo)", () => {
  assert.equal(argUpload("/a", "qualquer").mode, "add");
});
