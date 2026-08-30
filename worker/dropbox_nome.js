import { centsToNumeric } from "./money.js";

export function sanitizar(s) {
  if (!s) return "";
  return String(s)
    .replace(/[/\\:*?"<>|]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
}

export function caminhoDropbox(dataISO) {
  const [ano, mes] = dataISO.split("-");
  return `/Finanças/Comprovantes/${ano}/${ano}-${mes}`;
}

export function nomeArquivo({ dataISO, macro, sub, valorCents, descricao, ext }) {
  const partes = [dataISO, sanitizar(macro)];
  if (sub) partes.push(sanitizar(sub));
  partes.push(centsToNumeric(valorCents));
  const desc = sanitizar(descricao);
  if (desc) partes.push(desc);
  return `${partes.join("_")}.${ext}`;
}
