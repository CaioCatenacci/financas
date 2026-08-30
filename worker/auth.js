export function chatPermitido(chatId, allowlistCsv) {
  if (!allowlistCsv) return false; // falha fechada
  const ids = allowlistCsv.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(String(chatId));
}

export function segredoTelegramValido(request, segredo) {
  if (!segredo) return false;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === segredo;
}

function lerCookie(request, nome) {
  const raw = request.headers.get("Cookie") || "";
  for (const parte of raw.split(";")) {
    const [k, v] = parte.trim().split("=");
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
