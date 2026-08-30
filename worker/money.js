// Dinheiro em centavos inteiros: float acumula erro que aparece ao fechar margem.
export function parseBRtoCents(str) {
  if (typeof str !== "string") return null;
  let s = str.replace(/R\$\s*/i, "").trim();
  if (!s) return null;
  if (s.startsWith("-")) return null; // magnitude sempre positiva
  s = s.replace(/\./g, ""); // remove milhar
  if (s.includes(",")) s = s.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

export function centsToBR(cents) {
  const neg = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100).toLocaleString("pt-BR");
  const dec = String(abs % 100).padStart(2, "0");
  return `${neg}${reais},${dec}`;
}

export function centsToNumeric(cents) {
  const neg = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${neg}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
