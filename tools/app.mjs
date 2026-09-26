// tools/app.mjs — GET no app no ar com o token que o próprio app usa.
//
// O app fica atrás de APP_TOKEN (cookie `token`, ver worker/auth.js). Os papéis da
// fila precisam chamar o app no ar — o PM apura uma queixa chamando a rota, a
// entrega confere o deploy — sem abrir rota sem token e sem que o token apareça
// numa linha de comando, num relatório ou numa PR. Este script lê o token de
// .dev.vars (nunca versionado), manda como cookie e imprime só status e corpo.
// Só GET, só /api/* e /app: é tudo que a apuração e a conferência precisam.
//
// Uso: node tools/app.mjs api/resumo?mes=2026-09   (sem a barra inicial: ver validarRota)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const URL_APP = "https://financas.caiocatenacci.workers.dev";
const MAX_CORPO = 4000;

export function lerDevVars(texto) {
  const campos = {};
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith("#")) continue;
    const k = linha.indexOf("=");
    if (k < 0) continue;
    campos[linha.slice(0, k).trim()] = linha.slice(k + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return campos;
}

// Sem espaço, sem "..": api/<qualquer coisa> ou app, com ou sem a barra inicial
// (o Git Bash do Windows converte "/api/x" em "C:/Program Files/Git/api/x";
// sem a barra ele não mexe, e é assim que os agentes chamam). Vem antes de ler
// o .dev.vars: rota errada é erro do pedido, não do ambiente. Devolve a rota
// canônica, com a barra.
export function validarRota(rota) {
  if (typeof rota !== "string" || /\s|\.\./.test(rota) || !/^\/?(api\/\S*|app)$/.test(rota))
    throw new Error(`rota tem que ser api/... ou app, não "${rota}"`);
  return rota.startsWith("/") ? rota : `/${rota}`;
}

export function montarPedido(rota, token, base = URL_APP) {
  const canonica = validarRota(rota);
  if (!token) throw new Error("APP_TOKEN vazio ou ausente em .dev.vars");
  return { url: `${base}${canonica}`, headers: { Cookie: `token=${token}` } };
}

export function resumir(status, corpo, max = MAX_CORPO) {
  return { status, corpo: corpo.length > max ? `${corpo.slice(0, max)}…[cortado, ${corpo.length} chars]` : corpo };
}

async function principal(argv) {
  let pedido;
  try {
    validarRota(argv[0]);
    let vars;
    try { vars = lerDevVars(readFileSync(".dev.vars", "utf8")); }
    catch { throw new Error("não achei .dev.vars na pasta atual (rode na raiz do repositório)"); }
    pedido = montarPedido(argv[0], vars.APP_TOKEN);
  } catch (e) { console.error(e.message); process.exit(1); }
  const r = await fetch(pedido.url, { method: "GET", headers: pedido.headers, redirect: "manual" });
  console.log(JSON.stringify(resumir(r.status, await r.text())));
  process.exit(r.status < 400 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) principal(process.argv.slice(2));
