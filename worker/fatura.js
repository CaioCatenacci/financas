/**
 * Parser da fatura Itaú (texto do PDF extraído no navegador via pdf.js e reconstruído por linhas).
 *
 * Uma fatura real é DENSA e em 2 COLUNAS: a reconstrução por linha (y) às vezes junta um
 * lançamento da coluna esquerda e outro da direita na MESMA linha. Por isso capturamos TODOS os
 * lançamentos de cada linha (regex global), não só o primeiro.
 *
 * Como distinguir um lançamento do ruído:
 * - Um lançamento do período começa com `DD/MM` seguido de ESPAÇO (ex.: "16/06  LOJA  100,00").
 *   Datas de cabeçalho são `DD/MM/AAAA` (barra depois do MM) — o `\s+` exigido após o dia/mês as
 *   exclui naturalmente (inclusive "Pagamento efetuado em 06/06/2025 - 17,00").
 * - O valor é o PRIMEIRO token de dinheiro após a data (a categoria/ruído vem depois).
 * - Estornos vêm com "-" antes do valor → valor negativo.
 * - PARAMOS de capturar ao encontrar "Total dos lançamentos atuais": o que vem depois é
 *   parcelamento de PRÓXIMAS faturas, simulação de saque, etc. — não é gasto do período.
 *
 * Observação de checksum: o "Total dos lançamentos atuais" inclui IOF/encargos (ex.: IOF de
 * transação internacional) que NÃO são lançamentos com data. Então a soma dos itens pode ficar
 * um pouco abaixo do total — quem consome (montarPreviewFatura) trata isso como AVISO, não erro.
 */

const _MONEY = /-?\s*\d{1,3}(?:\.\d{3})*,\d{2}/;
// lançamento: DD/MM + ESPAÇO + estabelecimento (não-guloso) + ESPAÇO + valor (opcional "-").
// global: pega os 2 lançamentos quando a linha juntou as duas colunas.
const _ITEM = /(\d{2})\/(\d{2})\s+(.+?)\s+(-?\s*\d{1,3}(?:\.\d{3})*,\d{2})/g;
const _TOTAL_LABEL = /total\s+dos\s+lan.amentos\s+atuais/i;
// sufixo de parcela (DD/MM) colado/solto no fim do estabelecimento (ex.: "GIULIANA MARKET IN01/03").
const _PARCELA_FIM = /(\d{2}\/\d{2})\s*$/;

/**
 * Converte string de dinheiro brasileiro (com sinal opcional) para centavos (inteiro).
 * '- 17,40' -> -1740 ; '1.007,56' -> 100756 ; '411,48' -> 41148
 */
function _cents(v) {
  const neg = /^\s*-/.test(v);
  const n = parseInt(v.replace(/[^\d]/g, ""), 10);
  return neg ? -n : n;
}

/**
 * Parser da fatura Itaú.
 * @param {string} texto - Texto da fatura (pdf.js reconstruído por linhas)
 * @param {number} ano - Ano do período da fatura (a fatura só traz DD/MM)
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

    // Total do período: captura o valor e PARA de ler itens (o que vem depois é parcelamento
    // futuro / simulações, não gasto do período).
    const mt = _TOTAL_LABEL.exec(linha);
    if (mt) {
      const resto = linha.substring(mt.index + mt[0].length);
      const mv = _MONEY.exec(resto);
      if (mv) {
        totalCents = _cents(mv[0]);
      }
      break;
    }

    // Captura TODOS os lançamentos da linha (fatura de 2 colunas pode trazer 2 por linha).
    _ITEM.lastIndex = 0;
    let m;
    while ((m = _ITEM.exec(linha)) !== null) {
      const dd = m[1];
      const mm = m[2];
      let est = m[3].replace(/\s{2,}/g, " ").trim();

      // sufixo de parcela (DD/MM) no fim do estabelecimento — separa e limpa a descrição.
      let parcela = null;
      const pm = est.match(_PARCELA_FIM);
      if (pm) {
        parcela = pm[1];
        est = est.slice(0, pm.index).replace(/[\s*]+$/, "").trim();
      }

      itens.push({
        data: `${ano}-${mm}-${dd}`,
        descricao: est,
        valorCents: _cents(m[4]),
        parcela,
      });
    }
  }

  return { itens, totalCents };
}
