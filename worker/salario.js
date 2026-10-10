// G1: salário por competência. Puro (sem banco/rede) — tudo entra por parâmetro, pra auditar o
// número quando parecer errado. Dinheiro em centavos inteiros.
//
// Regra (Decisões do card G1, 2026-10-09): o salário é fixo em dólar e varia só pelo câmbio da
// conversão. Cada dólar convertido paga o mês mais antigo ainda não pago (FIFO), a `usd_cents` do
// parâmetro vigente naquele mês; uma conversão que cobre dois meses divide os reais na proporção
// dos dólares; o mês coberto só em parte ou ainda não coberto vem `estimado: true`, valendo o que
// falta × a última taxa conhecida (a da conversão mais recente). Mês anterior ao primeiro
// parâmetro não tem salário em dólar: `brl_cents` nulo e `estimado: false`.
//
// Onde o FIFO começa: no mês da primeira conversão (ou no do primeiro parâmetro, se for depois).
// É o que o Exemplo do card diz — salário desde janeiro, conversões só em agosto, e agosto é o
// primeiro mês pago; e é o que o período Nomad precisa (maio e junho de 2025 ficam estimados, sem
// extrato que os pague). Meses entre o primeiro parâmetro e a primeira conversão vêm estimados.
import { mesAnterior } from "./metas.js";

// os `n` meses que terminam em `ate` ('YYYY-MM'), do mais antigo ao mais novo.
export function mesesAte(ate, n = 12) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(mesAnterior(ate, i));
  return out;
}

function mesDe(iso) { return String(iso).slice(0, 7); }

// parâmetro vigente num mês: o baseline mais recente com vigente_desde <= mês (como alvoEfetivo).
function paramVigente(params, mes) {
  let v = null;
  for (const p of params) {
    const pm = mesDe(p.vigente_desde);
    if (pm <= mes && (v === null || mesDe(v.vigente_desde) < pm)) v = p;
  }
  return v;
}

/**
 * @param {Array<{data:string, usd_cents:number, brl_cents:number}>} conversoes
 * @param {Array<{vigente_desde:string, usd_cents:number}>} params
 * @param {string[]} meses - 'YYYY-MM' a devolver (qualquer ordem)
 * @returns {Array<{mes, brl_cents, usd_cents, taxa, estimado}>} na ordem de `meses`
 */
export function alocarSalario(conversoes, params, meses) {
  const ps = (params || []).map((p) => ({ vigente_desde: mesDe(p.vigente_desde) + "-01", usd_cents: Number(p.usd_cents) }));
  const fila = (conversoes || [])
    .map((c) => ({ data: String(c.data).slice(0, 10), usd_cents: Number(c.usd_cents), brl_cents: Number(c.brl_cents) }))
    .filter((c) => c.usd_cents > 0)
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0))
    .map((c) => ({ ...c, usdResta: c.usd_cents, brlResta: c.brl_cents }));

  const semSalario = (mes) => ({ mes, brl_cents: null, usd_cents: null, taxa: null, estimado: false });
  if (!ps.length || !meses || !meses.length) return (meses || []).map(semSalario);

  const primeiro = ps.reduce((m, p) => (mesDe(p.vigente_desde) < m ? mesDe(p.vigente_desde) : m), mesDe(ps[0].vigente_desde));
  const ultimo = meses.reduce((m, x) => (x > m ? x : m), meses[0]);
  // o FIFO começa no mês da primeira conversão (nunca antes do primeiro parâmetro)
  const inicioFifo = fila.length && mesDe(fila[0].data) > primeiro ? mesDe(fila[0].data) : primeiro;

  // última taxa conhecida: a da conversão mais recente (brl/usd), tenha sido consumida ou não
  const maisRecente = fila.length ? fila[fila.length - 1] : null;
  const taxaUltima = maisRecente ? maisRecente.brl_cents / maisRecente.usd_cents : null;

  // FIFO do primeiro parâmetro até o último mês pedido — a alocação de um mês depende da dos anteriores
  const porMes = new Map();
  let i = 0; // índice da conversão que ainda tem dólares
  for (let mes = primeiro; mes <= ultimo; mes = mesAnterior(mes, -1)) {
    const p = paramVigente(ps, mes);
    const alvo = p ? p.usd_cents : 0;
    let usdPago = 0, brlPago = 0;
    while (mes >= inicioFifo && usdPago < alvo && i < fila.length) {
      const c = fila[i];
      const usa = Math.min(c.usdResta, alvo - usdPago);
      // a última fatia leva o que sobrou dos reais: as partes fecham com o total da conversão
      const brl = usa === c.usdResta ? c.brlResta : Math.round(c.brl_cents * usa / c.usd_cents);
      c.usdResta -= usa; c.brlResta -= brl;
      usdPago += usa; brlPago += brl;
      if (c.usdResta === 0) i++;
    }
    const falta = alvo - usdPago;
    let brl_cents, estimado;
    if (falta === 0) { brl_cents = brlPago; estimado = false; }
    else if (taxaUltima === null) { brl_cents = null; estimado = true; }
    else { brl_cents = brlPago + Math.round(falta * taxaUltima); estimado = true; }
    const taxa = brl_cents === null || alvo === 0 ? null : Math.round(brl_cents / alvo * 10000) / 10000;
    porMes.set(mes, { mes, brl_cents, usd_cents: alvo, taxa, estimado });
  }

  return meses.map((mes) => (mes < primeiro ? semSalario(mes) : porMes.get(mes)));
}
