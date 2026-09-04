/**
 * Parser da fatura Itaú (texto do PDF, extraído em modo layout).
 * A fatura tem layout de 2 colunas; em modo layout cada linha de lançamento vira
 * 'DATA   ESTABELECIMENTO   VALOR   [ruído da coluna da direita: juros etc]'.
 * Regra: uma linha de item é a que COMEÇA (após strip) com 'DD/MM'; o valor do
 * lançamento é o PRIMEIRO token de dinheiro que aparece depois da data — ruído da
 * coluna da direita (ex.: juros) vem depois e tem que ser ignorado. O estabelecimento
 * é o texto entre a data e esse primeiro valor. Ano vem do período da fatura (parâmetro).
 * Parcela 'x/y' extraída do texto do estabelecimento.
 */

const _LINHA_DATA = /^(\d{2})\/(\d{2})\s+(.*)$/;
const _MONEY = /\d{1,3}(?:\.\d{3})*,\d{2}/;
const _PARCELA = /PARCELA\s+(\d{2}\/\d{2})/i;
// ".", não "ç"/"ã" diretamente: o texto extraído pode carregar acentuação estranha
const _TOTAL_LABEL = /total\s+dos\s+lan.amentos\s+atuais/i;
const _IGNORAR = /total\s+dos\s+lan.amentos|lan.amentos\s+no\s+cart.o|^data\s+estabelecimento/i;

/**
 * Converte string de dinheiro brasileiro para centavos (inteiro).
 * Remove pontos de milhar e converte vírgula decimal.
 */
function _cents(v) {
  return parseInt(v.replace(/\./g, "").replace(",", ""), 10);
}

/**
 * Extrai a primeira ocorrência de um padrão regex em uma string.
 */
function _searchRegex(regex, text) {
  const match = regex.exec(text);
  return match ? { index: match.index, match } : null;
}

/**
 * Parser da fatura Itaú.
 * @param {string} texto - Texto da fatura (PDF em modo layout)
 * @param {number} ano - Ano do período da fatura
 * @returns {{itens: Array, totalCents: number}}
 */
export function parseFatura(texto, ano) {
  const itens = [];
  let totalCents = 0;

  for (const raw of texto.split("\n")) {
    const linha = raw.trim();

    if (!linha) {
      continue;
    }

    // Procura pelo total
    const mtTotal = _TOTAL_LABEL.exec(linha);
    if (mtTotal) {
      const restoDaLinha = linha.substring(mtTotal.index + mtTotal[0].length);
      const mvTotal = _MONEY.exec(restoDaLinha);
      if (mvTotal) {
        totalCents = _cents(mvTotal[0]);
      }
      continue;
    }

    // Ignora linhas de subtotal, header, título
    if (_IGNORAR.test(linha)) {
      continue;
    }

    // Tenta extrair data (DD/MM)
    const mdData = _LINHA_DATA.exec(linha);
    if (!mdData) {
      continue;
    }

    const dd = mdData[1];
    const mm = mdData[2];
    const resto = mdData[3];

    // Procura pelo primeiro valor de dinheiro após a data
    const mvDinheiro = _MONEY.exec(resto);
    if (!mvDinheiro) {
      // linha começa com data mas não tem valor reconhecível — ignora
      continue;
    }

    // Extrai estabelecimento (texto entre data e primeiro valor)
    // Colapsa múltiplos espaços em branco
    const estabelecimento = resto.substring(0, mvDinheiro.index)
      .replace(/\s{2,}/g, " ")
      .trim();

    // Procura por parcela no estabelecimento
    const parcMatch = _PARCELA.exec(estabelecimento);

    itens.push({
      data: `${ano}-${mm}-${dd}`,
      descricao: estabelecimento,
      valorCents: _cents(mvDinheiro[0]),
      parcela: parcMatch ? parcMatch[1] : null,
    });
  }

  return { itens, totalCents };
}
