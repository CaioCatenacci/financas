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

// C4: onde fica o arquivo original de um import. Extrato (e o CSV da Wise) pelo período que o
// arquivo cobre; fatura pelo mês do vencimento. O nome não tem nada aleatório de propósito:
// reimportar o mesmo período cai no mesmo caminho e o upload (overwrite) substitui o arquivo.
// Devolve null quando o vocabulário ou o período não servem (a rota responde 400).
export const TIPOS_ARQUIVO_IMPORT = ["extrato", "fatura"];
export const BANCOS_ARQUIVO_IMPORT = ["itau", "c6", "wise"];
const DIA_ISO = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MES_ISO = /^\d{4}-(0[1-9]|1[0-2])$/;

export function caminhoArquivoImport({ tipo, banco, de, ate, mes } = {}) {
  if (!TIPOS_ARQUIVO_IMPORT.includes(tipo) || !BANCOS_ARQUIVO_IMPORT.includes(banco)) return null;
  // a Wise exporta CSV; os bancos, PDF
  const ext = banco === "wise" ? "csv" : "pdf";
  if (tipo === "fatura") {
    if (!MES_ISO.test(mes || "")) return null;
    return `/Finanças/Faturas/${banco}/${mes}_${banco}_fatura.${ext}`;
  }
  if (!DIA_ISO.test(de || "") || !DIA_ISO.test(ate || "") || de > ate) return null;
  return `/Finanças/Extratos/${banco}/${de}_a_${ate}_${banco}_extrato.${ext}`;
}
