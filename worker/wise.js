// G1: parser do CSV da conta em USD da Wise (puro: sem banco, sem rede). O CSV é lido no
// navegador e só o texto chega aqui. Interessa uma linha só: a conversão USD → BRL
// (Transaction Details Type = CONVERSION, Exchange From = USD, Exchange To = BRL): Amount (negativo,
// em módulo) dá os dólares, Exchange To Amount os reais, Exchange Rate a taxa. DEPOSIT e TRANSFER
// (e qualquer outra moeda) são ignorados. linha_hash = sha256 do TransferWise ID — reimportar o
// mesmo CSV não duplica (unique em conversoes.linha_hash).
import { createHash } from "node:crypto";

// CSV com aspas (RFC 4180): campo entre aspas pode ter vírgula e aspas dobradas; aceita CRLF.
export function parseCsv(texto) {
  const linhas = [];
  let campo = "", linha = [], aspas = false;
  const s = String(texto || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (aspas) {
      if (c === '"') {
        if (s[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ",") { linha.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      linha.push(campo); campo = "";
      if (linha.some((x) => x !== "")) linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  linha.push(campo);
  if (linha.some((x) => x !== "")) linhas.push(linha);
  return linhas;
}

// "DD-MM-YYYY" (coluna Date da Wise) → "YYYY-MM-DD"; já ISO passa direto.
function dataISO(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(String(s || "").trim());
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || "").trim());
  return iso ? iso[1] : null;
}

// a Wise escreve os valores no formato americano ("8000.00": ponto decimal, sem milhar) — por
// isso NÃO passa por parseBRtoCents, que leria o ponto como milhar. Módulo: o Amount da conversão
// é negativo (saiu da conta em USD). Devolve null se não for número.
export function centsUS(s) {
  const t = String(s ?? "").trim().replace(/^-/, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [int, dec = ""] = t.split(".");
  return Number(int) * 100 + Math.round(Number((dec + "000").slice(0, 3)) / 10);
}
const cents = centsUS;

export function hashWise(id) {
  return createHash("sha256").update(String(id)).digest("hex");
}

/**
 * @param {string} texto - conteúdo do CSV
 * @returns {{conversoes: Array<{data, usd_cents, brl_cents, taxa, linhaHash, wiseId}>, ignoradas: number, erros: string[]}}
 */
export function parseWiseCsv(texto) {
  const linhas = parseCsv(texto);
  const erros = [];
  if (!linhas.length) return { conversoes: [], ignoradas: 0, erros: ["CSV vazio"] };
  const cab = linhas[0].map((h) => h.trim());
  const col = (nome) => cab.indexOf(nome);
  const obrig = ["TransferWise ID", "Date", "Amount", "Exchange From", "Exchange To", "Exchange Rate", "Exchange To Amount", "Transaction Details Type"];
  const faltam = obrig.filter((n) => col(n) < 0);
  if (faltam.length) return { conversoes: [], ignoradas: 0, erros: [`CSV sem as colunas: ${faltam.join(", ")}`] };

  const conversoes = [];
  let ignoradas = 0;
  for (const l of linhas.slice(1)) {
    const g = (nome) => (l[col(nome)] ?? "").trim();
    const ehConversao = g("Transaction Details Type").toUpperCase() === "CONVERSION"
      && g("Exchange From").toUpperCase() === "USD" && g("Exchange To").toUpperCase() === "BRL";
    if (!ehConversao) { ignoradas++; continue; }
    const id = g("TransferWise ID");
    const data = dataISO(g("Date"));
    const usd_cents = cents(g("Amount"));
    const brl_cents = cents(g("Exchange To Amount"));
    const taxa = Number(g("Exchange Rate"));
    if (!id || !data || !usd_cents || brl_cents === null) { erros.push(`linha ilegível: ${id || "(sem id)"}`); continue; }
    conversoes.push({ data, usd_cents, brl_cents, taxa: Number.isFinite(taxa) ? taxa : null, linhaHash: hashWise(id), wiseId: id });
  }
  conversoes.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  return { conversoes, ignoradas, erros };
}
