// tools/app.mjs é a única porta dos agentes para o app no ar. O que se prova aqui:
// o token sai do .dev.vars e vai só no cookie; só GET em /api/* e /app; a saída é
// curta. O fetch de verdade não roda em teste.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lerDevVars, montarPedido, resumir, URL_APP } from "./app.mjs";

test("lerDevVars: CRLF, comentário, aspas e '=' dentro do valor", () => {
  assert.deepEqual(lerDevVars("# x\r\nAPP_TOKEN=abc==\r\n\r\nDATABASE_URL='postgresql://u:p=1@h/db'\r\nX = \"y\"\r\n"),
    { APP_TOKEN: "abc==", DATABASE_URL: "postgresql://u:p=1@h/db", X: "y" });
});

test("montarPedido: rota de API ou /app, token só no cookie", () => {
  const p = montarPedido("/api/resumo?mes=2026-09", "tok123");
  assert.equal(p.url, `${URL_APP}/api/resumo?mes=2026-09`);
  assert.deepEqual(p.headers, { Cookie: "token=tok123" });
  assert.equal(montarPedido("/app", "t").url, `${URL_APP}/app`);
  assert.equal(montarPedido("/api/x", "t", "http://localhost:8787").url, "http://localhost:8787/api/x");
});

// O Git Bash do Windows converte um argumento que começa com "/" em caminho do
// sistema ("C:/Program Files/Git/api/x"). Sem a barra inicial ele não mexe: é a
// forma que os agentes usam.
test("montarPedido: aceita a rota sem a barra inicial (Git Bash não a converte em caminho)", () => {
  assert.equal(montarPedido("api/catalogo", "t").url, `${URL_APP}/api/catalogo`);
  assert.equal(montarPedido("app", "t").url, `${URL_APP}/app`);
});

test("montarPedido: recusa o que não é /api/* nem /app, e token vazio", () => {
  for (const rota of ["/telegram", "telegram", "https://outro.site/api/x", "/app/../telegram", "/api/x y", "", undefined])
    assert.throws(() => montarPedido(rota, "t"), /rota/, String(rota));
  assert.throws(() => montarPedido("/api/x", ""), /APP_TOKEN/);
});

test("resumir: corta o corpo e diz que cortou", () => {
  assert.deepEqual(resumir(200, "abc", 10), { status: 200, corpo: "abc" });
  const r = resumir(200, "x".repeat(50), 10);
  assert.equal(r.status, 200);
  assert.match(r.corpo, /^x{10}…\[cortado, 50 chars\]$/);
});

// Review Focus 1: sem .dev.vars o script para com mensagem, sem stack e sem vazar nada.
test("CLI sem .dev.vars sai 1 com mensagem em português", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-"));
  const r = spawnSync(process.execPath, [join(process.cwd(), "tools/app.mjs"), "/api/catalogo"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.dev\.vars/);
  assert.doesNotMatch(r.stderr, /at .*app\.mjs/);
});

test("CLI com rota proibida sai 1 antes de qualquer rede", () => {
  const r = spawnSync(process.execPath, ["tools/app.mjs", "/telegram"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rota/);
});
