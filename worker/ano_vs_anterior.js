// D5: período da comparação "este ano × ano passado". Puro: sem banco, sem relógio.
//
// O ano anterior só é comparável a partir de quando a fatura do cartão começou a ser importada
// (antes disso as compras no cartão simplesmente não existem no banco, e o ano anterior pareceria
// mais barato). A primeira fatura só traz parte das compras do mês dela, então o mês dela também
// não serve: o período começa no mês seguinte — salvo se a cobertura começa em janeiro.

const pad = (n) => String(n).padStart(2, "0");
const ultimoDia = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();
const diaSeguinteAoMes = (ano, mes) => (mes === 12 ? `${ano + 1}-01-01` : `${ano}-${pad(mes + 1)}-01`);

/**
 * Mês ('MM') em que a comparação começa, ou null se o ano anterior não tem cobertura de fatura.
 * @param {number} ano  o ano corrente (o do mês selecionado)
 * @param {string[]} mesesFatura  meses 'AAAA-MM' do vencimento das faturas importadas (qualquer conta)
 */
export function inicioComparacao(ano, mesesFatura) {
  const prefixo = `${ano - 1}-`;
  const doAnterior = (mesesFatura || []).filter((m) => typeof m === "string" && m.startsWith(prefixo)).sort();
  if (!doAnterior.length) return null;
  const primeiro = Number(doAnterior[0].slice(5, 7));
  if (primeiro === 1) return "01";
  if (primeiro === 12) return null; // o "mês seguinte" é do ano corrente: o anterior fica sem nenhum mês
  return pad(primeiro + 1);
}

/**
 * Datas da comparação para o mês selecionado ('AAAA-MM'): de/ate (inclusivos, como na API) e os
 * fins exclusivos para o SQL. `antesDoInicio` = o mês selecionado ainda não chegou ao início.
 * null quando não há fatura no ano anterior.
 */
export function periodoAnoVsAnterior(mes, mesesFatura) {
  const ano = Number(mes.slice(0, 4)), m = Number(mes.slice(5, 7));
  const inicio = inicioComparacao(ano, mesesFatura);
  if (inicio == null) return null;
  return {
    de: `${ano}-${inicio}-01`,
    ate: `${ano}-${pad(m)}-${pad(ultimoDia(ano, m))}`,
    de_anterior: `${ano - 1}-${inicio}-01`,
    ate_anterior: `${ano - 1}-${pad(m)}-${pad(ultimoDia(ano - 1, m))}`,
    ateExcl: diaSeguinteAoMes(ano, m),
    ateExclAnterior: diaSeguinteAoMes(ano - 1, m),
    antesDoInicio: m < Number(inicio),
  };
}
