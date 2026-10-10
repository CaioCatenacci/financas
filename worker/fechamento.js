// G2: fechamento do mês — o que falta importar. Puro (sem banco, sem rede, sem relógio): o mês
// corrente entra por parâmetro, as coberturas vêm lidas do banco por quem chama.
//
// Regra (card G2, Decisões de 2026-10-10):
// - cada fonte tem uma cobertura: Itaú e C6 pelo max(ate) de `importacoes` (extrato, conta 'itau'
//   ou 'c6'); a fatura é binária (a do mês existe ou não; a fatura pertence ao mês do vencimento).
//   Cobertura até o último dia do mês (ou depois) = cheia; dentro do mês = parcial; antes do dia
//   01 (ou nenhum import) = faltando.
// - o mês: faltando se alguma fonte falta; senão parcial se alguma é parcial; senão fechado.
//   Faltando prevalece: o que não chegou é mais urgente do que o que chegou pela metade.
// - o mês corrente (e um futuro) nunca é fechado: não acabou, ainda pode ter movimento.
// - sem categoria e salário estimado NÃO travam o fechado: voltam como pendência/informação.

const ISO_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

export function ultimoDiaDoMes(mes) {
  const [a, m] = mes.split("-").map(Number);
  const d = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${mes}-${String(d).padStart(2, "0")}`;
}

// 'cheia' | 'parcial' | 'faltando' — comparação de strings ISO (YYYY-MM-DD) é cronológica
export function coberturaFonte(ate, mes) {
  if (!ate) return "faltando";
  const a = String(ate).slice(0, 10);
  if (a < `${mes}-01`) return "faltando";
  if (a >= ultimoDiaDoMes(mes)) return "cheia";
  return "parcial";
}

/**
 * @param {{mes:string, mesCorrente:string, itauAte:?string, c6Ate:?string, faturaExiste:boolean,
 *          semCategoria?:number, salarioEstimado?:boolean, salarioAte?:?string}} p
 */
export function estadoDoMes({ mes, mesCorrente, itauAte = null, c6Ate = null, faturaExiste = false, semCategoria = 0, salarioEstimado = false, salarioAte = null }) {
  if (!ISO_MES.test(mes || "")) throw new Error(`mes inválido: ${mes}`);
  const itau = { ate: itauAte ?? null, cobertura: coberturaFonte(itauAte, mes) };
  const c6 = { ate: c6Ate ?? null, cobertura: coberturaFonte(c6Ate, mes) };
  const fatura = { existe: !!faturaExiste, cobertura: faturaExiste ? "cheia" : "faltando" };
  const cobs = [itau.cobertura, c6.cobertura, fatura.cobertura];

  let estado = cobs.includes("faltando") ? "faltando" : cobs.includes("parcial") ? "parcial" : "fechado";
  // mês que não acabou: tudo coberto até hoje ainda é só parte do mês
  if (estado === "fechado" && mesCorrente && mes >= mesCorrente) estado = "parcial";

  return {
    mes, estado,
    fontes: { itau, c6, fatura, salario: { ate: salarioAte ?? null, estimado: !!salarioEstimado } },
    sem_categoria: Number(semCategoria) || 0,
  };
}

/**
 * Junta as leituras do banco nos meses pedidos. Itaú = extrato com conta 'itau'; C6 = extrato com
 * conta 'c6' (a linha 'wise' de importacoes fica gravada, mas o salário lê as conversões).
 *
 * @param {string[]} meses - 'YYYY-MM'
 * @param {string} mesCorrente - 'YYYY-MM' (quem chama tem o relógio)
 * @param {{coberturas:Array<{conta,tipo,ate}>, faturas:string[], semCategoria:Array<{mes,n}>,
 *          salarios:Array<{mes,estimado}>, ultimaConversao:?string}} leituras
 */
export function montarFechamento(meses, mesCorrente, { coberturas = [], faturas = [], semCategoria = [], salarios = [], ultimaConversao = null } = {}) {
  const ate = (conta, tipo) => {
    const c = coberturas.find((x) => x.conta === conta && x.tipo === tipo);
    return c ? String(c.ate).slice(0, 10) : null;
  };
  const itauAte = ate("itau", "extrato"), c6Ate = ate("c6", "extrato");
  const fat = new Set(faturas);
  const semCat = new Map(semCategoria.map((s) => [s.mes, Number(s.n)]));
  const sal = new Map(salarios.map((s) => [s.mes, s]));
  return meses.map((mes) => estadoDoMes({
    mes, mesCorrente, itauAte, c6Ate, faturaExiste: fat.has(mes),
    semCategoria: semCat.get(mes) || 0,
    salarioEstimado: !!(sal.get(mes) && sal.get(mes).estimado), salarioAte: ultimaConversao,
  }));
}
