// Inc 3: parser determinístico do lançamento por texto. Puro (sem rede/banco/IA).
// Formato: <descrição> <valor> <data> [pessoa=] [categoria=] [subcategoria=] [natureza=]
// Obrigatórios: descrição, valor, data. Opcionais: os pares chave=valor.
import { parseBRtoCents } from "./money.js";

const CHAVES = ["pessoa", "categoria", "subcategoria", "natureza"];
const reData = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/;

const pad = (n) => String(n).padStart(2, "0");

// token de data dd/mm[/aaaa] → ISO; ano omitido = ano atual; aaaa de 2 dígitos → 20aa.
// Valida dias no mês, incluindo ano bissexto.
function parseData(tok) {
  const m = tok.match(reData);
  if (!m) return null;
  const dd = +m[1], mm = +m[2];
  let yyyy = m[3] ? +m[3] : new Date().getUTCFullYear();
  if (m[3] && m[3].length === 2) yyyy = 2000 + yyyy;
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;

  // Validar dias no mês, incluindo ano bissexto
  const diasNoMes = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const bissexto = (yyyy % 4 === 0 && yyyy % 100 !== 0) || yyyy % 400 === 0;
  if (mm === 2 && bissexto) diasNoMes[1] = 29;
  if (dd > diasNoMes[mm - 1]) return null;

  return `${yyyy}-${pad(mm)}-${pad(dd)}`;
}

export function parseLancamentoTexto(texto) {
  const t = String(texto ?? "").trim();
  if (!t) return { ok: false, erro: "texto vazio" };

  // 1) separa a parte livre dos pares chave=valor (1ª chave conhecida marca o corte)
  const reCorte = new RegExp(`(?:^|\\s)(?:${CHAVES.join("|")})\\s*=`, "i");
  const corte = t.search(reCorte);
  const livre = (corte >= 0 ? t.slice(0, corte) : t).trim();
  const paresStr = corte >= 0 ? t.slice(corte) : "";

  // 2) pares: cada valor vai até o próximo chave= conhecido (permite espaço no valor)
  const pares = {};
  if (paresStr) {
    const re = new RegExp(`(${CHAVES.join("|")})\\s*=\\s*(.*?)(?=\\s+(?:${CHAVES.join("|")})\\s*=|$)`, "gi");
    let m;
    while ((m = re.exec(paresStr))) pares[m[1].toLowerCase()] = m[2].trim();
  }

  // 3) parte livre → data (por forma), valor (formato BR), descrição (o resto)
  const tokens = livre.split(/\s+/).filter(Boolean);
  let dataISO = null;
  const semData = [];
  for (const tok of tokens) {
    if (dataISO === null && reData.test(tok)) { const d = parseData(tok); if (d) { dataISO = d; continue; } }
    semData.push(tok);
  }
  // valor: prefere token com centavos (vírgula); senão inteiro puro
  let valorCents = null, idxValor = -1;
  for (let i = 0; i < semData.length; i++) {
    if (/,\d{2}$/.test(semData[i])) { const c = parseBRtoCents(semData[i]); if (c !== null) { valorCents = c; idxValor = i; break; } }
  }
  if (valorCents === null) {
    for (let i = 0; i < semData.length; i++) {
      if (/^\d+$/.test(semData[i])) { valorCents = parseBRtoCents(semData[i]); idxValor = i; break; }
    }
  }
  const descricao = semData.filter((_, i) => i !== idxValor).join(" ").trim();

  if (!descricao || valorCents === null || dataISO === null)
    return { ok: false, erro: "faltam obrigatórios (descrição, valor e data)" };

  const natureza = (pares.natureza || "").toLowerCase() === "receita" ? "receita" : "despesa";
  return { ok: true, dados: {
    valorCents, dataISO, descricao, natureza,
    pessoa: pares.pessoa || null, categoria: pares.categoria || null, subcategoria: pares.subcategoria || null,
  } };
}
