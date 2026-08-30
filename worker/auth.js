export function chatPermitido(chatId, allowlistCsv) {
  if (!allowlistCsv) return false; // falha fechada
  const ids = allowlistCsv.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(String(chatId));
}

export function segredoTelegramValido(request, segredo) {
  // Falha fechada: segredo indefinido/vazio rejeita.
  // A Telegram API espera uma comparação exata do header;
  // ausência de segredo = vulnerabilidade de autenticação.
  if (!segredo) return false;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === segredo;
}

function lerCookie(request, nome) {
  // Parse manual do header Cookie, defensivo contra valores com "=".
  // Tokens em base64 (ex. "ab==") são truncados por split("=").
  // Usar indexOf garante que só o primeiro "=" separa chave/valor.
  const raw = request.headers.get("Cookie") || "";
  for (const parte of raw.split(";")) {
    const p = parte.trim();
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    const k = p.slice(0, idx);
    const v = p.slice(idx + 1);
    if (k === nome) return v;
  }
  return null;
}

export function tokenValido(request, tokenEsperado) {
  if (!tokenEsperado) return false; // falha fechada
  const url = new URL(request.url);
  const q = url.searchParams.get("token");
  const c = lerCookie(request, "token");
  return q === tokenEsperado || c === tokenEsperado;
}
