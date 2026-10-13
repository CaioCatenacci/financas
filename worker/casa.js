// G4: Projeto Casa — quanto do custo o patrimônio já cobre (sem cair abaixo da reserva) e em quanto
// tempo se chega lá no ritmo atual. Puro (sem banco, sem rede, sem relógio): as somas vêm do SQL
// (saldo do G1, despesa da categoria com a flag projeto_casa, já gasto, linhas do patrimônio) e o
// mês corrente entra por parâmetro. Aqui só se decide QUAIS somas contam. Centavos inteiros.
//
// Regras (card G4, Decisões de 2026-10-12/13):
// - patrimônio do mês = soma das contas; conta sem print no mês usa a ÚLTIMA foto anterior dela
//   (carregada para a frente, com a data da foto). Sem nenhuma foto até o mês → null, nunca zero
//   (zero daria disponível negativo e uma falta maior que o custo).
// - disponível = patrimônio − reserva; % = disponível ÷ custo; falta = custo − disponível − já gasto.
// - ritmo, uma vez só, ancorado em `ate`: média, nos 6 últimos meses FECHADOS (nunca o corrente),
//   de (saldo do G1 + despesa da Projeto Casa no mês) — a obra é uso do dinheiro juntado, não
//   consumo — mais, por conta, a média do rendimento nos meses da janela em que ele existe (null
//   não vira zero).
// - projeção = teto(falta ÷ ritmo); ritmo ≤ 0 → sem projeção, com aviso. Falta ≤ 0 → 0 ("já cobre").
// - ritmo necessário (com data_alvo) = teto(falta ÷ meses de `ate` até a data); data no mês de
//   `ate` ou antes → null, com aviso.
//
// Bordas que o card não decide (padrão registrado para o Caio confirmar): menos de 6 fechados →
// média sobre os que houver (n_meses_ritmo diz quantos); 0 fechados → ritmo null; o ritmo
// necessário arredonda para cima em centavos.

import { fotoDoMes, montarPatrimonio } from "./patrimonio.js";

const ISO_MES = /^\d{4}-(0[1-9]|1[0-2])$/;
export const JANELA_RITMO = 6;

export const AVISOS = {
  semFoto: "sem foto de patrimônio: mande o primeiro print (/patrimonio …)",
  semParam: "sem custo e reserva: preencha os parâmetros do Projeto Casa",
  semFechado: "nenhum mês fechado nos 12 meses: sem ritmo",
  ritmoNaoPositivo: "ritmo ≤ 0: no ritmo atual o dinheiro para a casa não cresce, sem projeção",
  alvoVencido: "data alvo no mês de referência ou antes dele: sem ritmo necessário",
};

// diferença em meses de calendário: `b` − `a` ('YYYY-MM' ou 'YYYY-MM-DD')
export function mesesEntre(a, b) {
  const [ya, ma] = a.slice(0, 7).split("-").map(Number);
  const [yb, mb] = b.slice(0, 7).split("-").map(Number);
  return (yb * 12 + mb) - (ya * 12 + ma);
}

// 'YYYY-MM' + n meses
export function somaMeses(mes, n) {
  const [a, m] = mes.split("-").map(Number);
  const idx = a * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

// teto de a ÷ b com inteiros positivos (sem float no caminho)
const tetoDiv = (a, b) => Math.floor((a + b - 1) / b);

/**
 * Patrimônio de cada mês com a última foto de cada conta carregada para a frente.
 * @param {string[]} meses - 'YYYY-MM', em ordem
 * @param {Array<{mes, data, conta, pessoa, familia, nivel, saldo_cents}>} linhas - todo o histórico até o último mês
 * @returns {Array<{mes, patrimonio_cents: number|null, data_foto_mais_antiga: string|null,
 *                  contas: Array<{conta, pessoa, data_foto, mes_foto, total_cents, carregada}>}>}
 */
export function patrimonioCarregado(meses, linhas = []) {
  const porConta = new Map(); // chave → {conta, pessoa, porMes: Map(mes → linhas)}
  for (const l of linhas) {
    const k = `${l.conta}|${l.pessoa}`;
    if (!porConta.has(k)) porConta.set(k, { conta: l.conta, pessoa: l.pessoa, porMes: new Map() });
    const c = porConta.get(k);
    if (!c.porMes.has(l.mes)) c.porMes.set(l.mes, []);
    c.porMes.get(l.mes).push(l);
  }
  const contas = [...porConta.values()].sort((a, b) => (a.pessoa + a.conta).localeCompare(b.pessoa + b.conta));
  for (const c of contas) c.mesesComFoto = [...c.porMes.keys()].sort();
  return meses.map((mes) => {
    const fotos = [];
    for (const c of contas) {
      // o mês com foto mais recente que não passa de `mes`
      let mesFoto = null;
      for (const m of c.mesesComFoto) if (m <= mes) mesFoto = m;
      if (!mesFoto) continue;
      const f = fotoDoMes(c.porMes.get(mesFoto));
      fotos.push({ conta: c.conta, pessoa: c.pessoa, data_foto: f.data, mes_foto: mesFoto, total_cents: f.total_cents, carregada: mesFoto !== mes });
    }
    const patrimonio_cents = fotos.length ? fotos.reduce((s, f) => s + f.total_cents, 0) : null;
    const data_foto_mais_antiga = fotos.length ? fotos.map((f) => f.data_foto).sort()[0] : null;
    return { mes, patrimonio_cents, data_foto_mais_antiga, contas: fotos };
  });
}

/**
 * Janela do ritmo: os `n` últimos meses com estado 'fechado', nunca o mês corrente (nem futuro).
 * @param {Array<{mes, estado}>} estados - saída de montarFechamento
 */
export function janelaRitmo(estados, mesCorrente, n = JANELA_RITMO) {
  return (estados || [])
    .filter((e) => e.estado === "fechado" && (!mesCorrente || e.mes < mesCorrente))
    .map((e) => e.mes).sort().slice(-n);
}

/**
 * Ritmo mensal ancorado na janela.
 * @param {string[]} janela - meses 'YYYY-MM'
 * @param {{saldos: Array<{mes, saldo_cents}>, despesaCasa: Array<{mes, despesa_cents}>,
 *          rendimentos: Array<{mes, porConta: Array<{conta, pessoa, rendimento_cents}>}>}} leituras
 *   saldos = G1; despesaCasa = despesa da categoria Projeto Casa por mês; rendimentos = montarPatrimonio().meses
 */
export function calcularRitmo(janela, { saldos = [], despesaCasa = [], rendimentos = [] } = {}) {
  const n = janela.length;
  const saldo = new Map(saldos.map((s) => [s.mes, Number(s.saldo_cents) || 0]));
  const casa = new Map(despesaCasa.map((d) => [d.mes, Number(d.despesa_cents) || 0]));
  // rendimento por conta: só os meses da janela em que existe
  const porConta = new Map();
  const naJanela = new Set(janela);
  for (const m of rendimentos) {
    for (const c of m.porConta || []) {
      const k = `${c.conta}|${c.pessoa}`;
      if (!porConta.has(k)) porConta.set(k, { conta: c.conta, pessoa: c.pessoa, soma: 0, n: 0 });
      if (naJanela.has(m.mes) && c.rendimento_cents != null) {
        const p = porConta.get(k);
        p.soma += Number(c.rendimento_cents); p.n += 1;
      }
    }
  }
  const rendimento_meses_por_conta = [...porConta.values()]
    .sort((a, b) => (a.pessoa + a.conta).localeCompare(b.pessoa + b.conta))
    .map((p) => ({ conta: p.conta, pessoa: p.pessoa, n_meses: p.n, de_meses: n, media_cents: p.n ? Math.round(p.soma / p.n) : null }));
  if (!n) {
    return { janela_ritmo: janela, n_meses_ritmo: 0, saldo_medio_cents: null, rendimento_medio_cents: null, ritmo_cents: null, rendimento_meses_por_conta };
  }
  // saldo do mês com a obra somada de volta: o gasto na casa não é consumo e não reduz o ritmo
  const somaSaldo = janela.reduce((s, m) => s + (saldo.get(m) || 0) + (casa.get(m) || 0), 0);
  const somaRend = [...porConta.values()].reduce((s, p) => s + (p.n ? p.soma / p.n : 0), 0);
  return {
    janela_ritmo: janela, n_meses_ritmo: n,
    saldo_medio_cents: Math.round(somaSaldo / n),
    rendimento_medio_cents: Math.round(somaRend),
    // um arredondamento só, no fim
    ritmo_cents: Math.round(somaSaldo / n + somaRend),
    rendimento_meses_por_conta,
  };
}

/**
 * Projeção e ritmo necessário a partir da falta no mês `ate`.
 * @returns {{projecao_meses, projecao_mes, ritmo_necessario_cents, meses_ate_alvo, avisos: string[]}}
 */
export function projetar({ ate, falta_cents, ritmo_cents, data_alvo = null }) {
  const avisos = [];
  let projecao_meses = null, ritmo_necessario_cents = null, meses_ate_alvo = null;
  if (falta_cents != null) {
    if (falta_cents <= 0) projecao_meses = 0; // o disponível já cobre: sem divisão
    else if (ritmo_cents != null && ritmo_cents <= 0) avisos.push(AVISOS.ritmoNaoPositivo);
    else if (ritmo_cents != null) projecao_meses = tetoDiv(falta_cents, ritmo_cents);
  }
  if (data_alvo) {
    meses_ate_alvo = mesesEntre(ate, String(data_alvo));
    if (meses_ate_alvo <= 0) avisos.push(AVISOS.alvoVencido);
    else if (falta_cents != null) ritmo_necessario_cents = falta_cents <= 0 ? 0 : tetoDiv(falta_cents, meses_ate_alvo);
  }
  const projecao_mes = projecao_meses == null ? null : somaMeses(ate, projecao_meses);
  return { projecao_meses, projecao_mes, ritmo_necessario_cents, meses_ate_alvo, avisos };
}

/**
 * Monta a resposta de GET /api/casa.
 * @param {string[]} meses - 12 meses 'YYYY-MM' terminando em `ate`
 * @param {string} mesCorrente - 'YYYY-MM' (quem chama tem o relógio)
 * @param {{param: {custo_total_cents, reserva_cents, data_alvo}|null,
 *          linhasPatrimonio: Array, aportes: Array, periodosItau: Array,
 *          estados: Array<{mes, estado}>, saldos: Array<{mes, saldo_cents}>,
 *          despesaCasa: Array<{mes, despesa_cents}>, jaGastoCents: number}} leituras
 *   linhasPatrimonio = todo o histórico até `ate` (a foto carregada pode ser anterior aos 12 meses)
 */
export function montarCasa(meses, mesCorrente, { param = null, linhasPatrimonio = [], aportes = [], periodosItau = [], estados = [], saldos = [], despesaCasa = [], jaGastoCents = 0 } = {}) {
  for (const m of meses) if (!ISO_MES.test(m || "")) throw new Error(`mes inválido: ${m}`);
  const ate = meses[meses.length - 1];
  const ja_gasto_cents = Number(jaGastoCents) || 0;
  const custo = param ? Number(param.custo_total_cents) : null;
  const reserva = param ? Number(param.reserva_cents) : null;

  // o mesmo parâmetro (o vigente em `ate`) vale para a série inteira: a série mostra o caminho até
  // a meta de hoje, não metas antigas
  const serie = patrimonioCarregado(meses, linhasPatrimonio).map((m) => {
    const temNumeros = m.patrimonio_cents != null && !!param;
    const disponivel_cents = temNumeros ? m.patrimonio_cents - reserva : null;
    return {
      mes: m.mes,
      patrimonio_cents: m.patrimonio_cents,
      disponivel_cents,
      // percentual (0–100), duas casas
      pct_coberto: temNumeros ? Math.round((disponivel_cents * 10000) / custo) / 100 : null,
      falta_cents: temNumeros ? custo - disponivel_cents - ja_gasto_cents : null,
      data_foto_mais_antiga: m.data_foto_mais_antiga,
      contas: m.contas,
    };
  });

  const janela = janelaRitmo(estados, mesCorrente);
  const { meses: rendimentos } = montarPatrimonio(meses, { linhas: linhasPatrimonio, aportes, periodosItau });
  const ritmo = calcularRitmo(janela, { saldos, despesaCasa, rendimentos });

  const atual = serie[serie.length - 1];
  const proj = projetar({ ate, falta_cents: atual.falta_cents, ritmo_cents: ritmo.ritmo_cents, data_alvo: param ? param.data_alvo : null });
  const avisos = [];
  if (atual.patrimonio_cents == null) avisos.push(AVISOS.semFoto);
  if (!param) avisos.push(AVISOS.semParam);
  if (!ritmo.n_meses_ritmo) avisos.push(AVISOS.semFechado);
  avisos.push(...proj.avisos);

  return {
    ate, mes_corrente: mesCorrente, param, ja_gasto_cents,
    meses: serie,
    ...ritmo,
    projecao_meses: proj.projecao_meses, projecao_mes: proj.projecao_mes,
    ritmo_necessario_cents: proj.ritmo_necessario_cents, meses_ate_alvo: proj.meses_ate_alvo,
    avisos,
  };
}

// 'YYYY-MM-DD' que existe no calendário (2026-02-30 não passa)
function dataValida(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Valida o corpo de PUT /api/casa/param. Devolve o parâmetro normalizado (vigente_desde no dia 01,
 * vigência por mês como o salário do G1) ou {erro} com uma mensagem legível.
 */
export function validarParamCasa(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { erro: "corpo inválido (JSON com vigente_desde, custo_total_cents, reserva_cents, data_alvo)" };
  const vd = b.vigente_desde;
  if (typeof vd !== "string" || !(ISO_MES.test(vd) || dataValida(vd))) return { erro: "vigente_desde inválido (use YYYY-MM ou YYYY-MM-DD)" };
  if (!Number.isSafeInteger(b.custo_total_cents) || b.custo_total_cents <= 0) return { erro: "custo_total_cents inválido (inteiro em centavos, maior que zero)" };
  if (!Number.isSafeInteger(b.reserva_cents) || b.reserva_cents < 0) return { erro: "reserva_cents inválido (inteiro em centavos, zero ou mais)" };
  const da = b.data_alvo ?? null;
  if (da !== null && !dataValida(da)) return { erro: "data_alvo inválida (use YYYY-MM-DD ou null)" };
  return { vigente_desde: `${vd.slice(0, 7)}-01`, custo_total_cents: b.custo_total_cents, reserva_cents: b.reserva_cents, data_alvo: da };
}

/**
 * Parâmetro vigente num mês: o mais recente com vigente_desde ≤ mês (como o salário do G1).
 * @param {Array<{vigente_desde, custo_total_cents, reserva_cents, data_alvo}>} params
 */
export function paramVigente(params, mes) {
  let v = null;
  for (const p of params || []) {
    const pm = String(p.vigente_desde).slice(0, 7);
    if (pm <= mes && (!v || String(v.vigente_desde).slice(0, 7) < pm)) v = p;
  }
  return v;
}
