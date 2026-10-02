/**
 * Parser determinístico do extrato do C6 Bank (texto do PDF que o C6 exporta). Puro: entra
 * texto (e a lista de contas próprias), sai estrutura — sem banco, sem rede.
 *
 * Layout (o PDF que o C6 exporta, lido pelo pdf.js no modo "simples"):
 *   - cabeçalho de mês: "<Mês> <AAAA>" (ex.: "Setembro 2031") — a linha só traz DD/MM, então o
 *     ano vem daqui (ou de uma data completa DD/MM/AAAA, se a linha trouxer);
 *   - lançamento: "DD/MM [DD/MM] <Tipo> <Descrição> <valor>", com Tipo ∈ Entrada PIX / Saída PIX /
 *     Pagamento (a 2ª data é a contábil; vale a de lançamento, a primeira);
 *   - "DD/MM Saldo do dia <valor>": marcador de saldo (alimenta o checksum, não é lançamento);
 *   - "Sem lançamentos no mês": não gera linha.
 * O PDF separa os dígitos das datas com espaço ("1 0 / 1 0"): juntamos antes de ler.
 *
 * A natureza vem do TIPO, não do sinal: Entrada = receita; Saída e Pagamento = despesa. O sinal
 * só decide quando o tipo não é um dos conhecidos (aí o checksum é quem pega leitura errada).
 */
import { normalizarNome } from "./contraparte.js";

const _MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto",
  "setembro", "outubro", "novembro", "dezembro"];

// "1 0 / 1 0" → "10/10" e "1 0 / 1 0 / 2 0 3 1" → "10/10/2031". Só mexe em datas: juntar todo
// dígito separado por espaço colaria a data no valor ou duas datas uma na outra.
const _DATA_ESPACADA = /(?<!\d)(\d)\s*(\d)\s*\/\s*(\d)\s*(\d)(?:\s*\/\s*(\d)\s*(\d)\s*(\d)\s*(\d))?(?!\d)/g;
export function juntarDigitosDatas(linha) {
  return linha.replace(_DATA_ESPACADA, (_, a, b, c, d, e, f, g, h) =>
    `${a}${b}/${c}${d}` + (e ? `/${e}${f}${g}${h}` : ""));
}

const _VALOR = /(-?)\s*(?:R\$\s*)?(-?)\s*([\d.]+,\d{2})\s*$/;
const _INICIO = /^(\d{2})\/(\d{2})(?:\/(\d{4}))?\s+(?:(\d{2})\/(\d{2})(?:\/\d{4})?\s+)?(.+)$/;
const _TIPOS = [
  { rx: /^entrada\s+pix\b/i, tipo: "Entrada PIX", natureza: "receita" },
  { rx: /^sa[ií]da\s+pix\b/i, tipo: "Saída PIX", natureza: "despesa" },
  { rx: /^pagamento\b/i, tipo: "Pagamento", natureza: "despesa" },
];

function _cents(sinal, num) {
  const n = parseInt(num.replace(/\./g, "").replace(",", ""), 10);
  return sinal ? -n : n;
}

function _semAcento(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Parseia o texto do extrato C6. Retorna { linhas, saldos, semAno } no mesmo formato do
 * parseExtrato do Itaú (linhas com data ISO, descricao, valorCents absoluto, natureza, ordinal
 * por data; saldos com data e saldoCents), mais `tipo` em cada linha. `semAno` conta as linhas
 * que não deu pra datar (nenhum cabeçalho de mês antes delas) — ficam de fora, e quem chama avisa.
 */
export function parseExtratoC6(texto) {
  const linhas = [];
  const saldos = [];
  const ordinais = {};
  let ano = null;
  let semAno = 0;

  for (const raw of String(texto || "").split("\n")) {
    const l = juntarDigitosDatas(raw).replace(/\s+/g, " ").trim();
    if (!l) continue;
    if (/^sem lan[cç]amentos no m[eê]s/i.test(l)) continue;

    // cabeçalho de mês: dá o ano às linhas seguintes (que só trazem DD/MM)
    const cab = /^([a-zà-ú]+)(?: de)? (\d{4})\b/i.exec(l);
    if (cab && _MESES.includes(_semAcento(cab[1]))) { ano = cab[2]; continue; }

    const m = _INICIO.exec(l);
    if (!m) {
      // linha de período ("... 01/09/2031 a 30/09/2031"): também serve pra saber o ano
      const per = /\b\d{2}\/\d{2}\/(\d{4})\b/.exec(l);
      if (per && !ano) ano = per[1];
      continue;
    }
    const [, dd, mm, aaaa, , , resto] = m;
    const v = _VALOR.exec(resto);
    if (!v) { if (aaaa && !ano) ano = aaaa; continue; } // linha de período: dá o ano
    const corpo = resto.slice(0, v.index).trim();
    const cents = _cents(v[1] || v[2], v[3]);

    const anoLinha = aaaa || ano;
    if (!anoLinha) { semAno++; continue; }
    const data = `${anoLinha}-${mm}-${dd}`;

    if (/^saldo do dia\b/i.test(corpo)) {
      saldos.push({ data, saldoCents: cents });
      continue;
    }

    const t = _TIPOS.find((x) => x.rx.test(corpo));
    const tipo = t ? t.tipo : null;
    const descricao = (t ? corpo.replace(t.rx, "") : corpo).trim() || corpo;
    const natureza = t ? t.natureza : (cents < 0 ? "despesa" : "receita");

    const o = ordinais[data] || 0;
    ordinais[data] = o + 1;
    linhas.push({ data, tipo, descricao, valorCents: Math.abs(cents), natureza, ordinal: o });
  }

  return { linhas, saldos, semAno };
}

/**
 * Lê a lista de contas próprias do secret CONTAS_PROPRIAS (nomes separados por vírgula, ponto e
 * vírgula ou quebra de linha). Devolve os nomes normalizados (normalizarNome); secret ausente ou
 * vazio → lista vazia. Os nomes nunca moram no código: o repositório é público.
 */
export function lerContasProprias(valor) {
  if (!valor || typeof valor !== "string") return [];
  return [...new Set(valor.split(/[,;\n]/).map(normalizarNome).filter(Boolean))];
}

const _PIX_ENVIADO = /^pix enviado para\s+(.+)$/i;

/**
 * Saída Pix do C6 para uma conta própria ("Pix enviado para <nome da lista>") é repasse entre
 * contas: sai do resumo. O nome vem completo no C6, então comparar com a lista é seguro aqui (no
 * Itaú ele vem cortado — por isso o Itaú nunca compara nome; ver db.marcarRepassesEntreContas).
 */
export function ehRepasseProprio(linha, contasProprias) {
  if (!contasProprias || !contasProprias.length) return false;
  if (linha.natureza !== "despesa") return false;
  const m = _PIX_ENVIADO.exec(linha.descricao || "");
  if (!m) return false;
  const nome = normalizarNome(m[1]);
  return contasProprias.includes(nome);
}
