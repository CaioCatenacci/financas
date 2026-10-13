// A2: patrimônio por print — saldo e rendimento por conta, mês a mês. Puro (sem banco, sem rede,
// sem relógio): as somas vêm do SQL (db.patrimonioPorDia, db.aportesInvestimentoPorMes) e aqui só
// se decide QUAIS somas contam. Os valores são centavos inteiros: somar inteiro em JS é exato.
//
// O print guarda o menor grão que mostrar (cada título; o agregado só quando é o que há). Um mesmo
// print pode trazer os dois — "CDB, Renda Fixa e Estruturados" e, abaixo, os títulos que o compõem.
// Contar os dois dobraria a renda fixa; por isso: dentro de uma conta e data, os títulos de uma
// família substituem o agregado dela.

import { centsToBR } from "./money.js";
import { reconhecerNaoGasto } from "./classificar.js";

// vocabulário fechado (os CHECKs da tabela `patrimonio` dizem o mesmo)
export const FAMILIAS = ["fundos", "renda_fixa", "caixa", "outros"];
export const NIVEIS = ["titulo", "agregado"];
export const PERIODOS = ["mes", "ano", "12m", "desde_inicio"];
export const CONTAS = ["itau", "c6", "nubank", "mercadopago"];

// a conta cujo rendimento é calculado: os aportes/resgates estão no extrato do Itaú (Decisões do
// card, opção A). As demais usam o rendimento do print.
export const CONTA_CALCULADA = { conta: "itau", pessoa: "Caio" };

const ISO_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

// "Itaú", "ITAU", "Mercado Pago", "C6 Bank", "Nu" → vocabulário; desconhecida → null (a legenda
// pode dizer). Sem acento, sem espaço, minúsculo.
export function normalizarConta(v) {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!s) return null;
  if (s.startsWith("itau")) return "itau";
  if (s.startsWith("c6")) return "c6";
  if (s === "nu" || s.startsWith("nubank")) return "nubank";
  if (s === "mp" || s.startsWith("mercadopago")) return "mercadopago";
  return null;
}

/**
 * Legenda "/patrimonio [pessoa] [conta]" (qualquer ordem). O que a legenda diz vence o que o
 * modelo leu. Não é /patrimonio → null.
 * @returns {{conta: string|null, pessoa: string|null} | null}
 */
export function parsePatrimonio(caption) {
  if (!caption || typeof caption !== "string") return null;
  const m = caption.trim().match(/^\/patrimonio(?:@\S+)?(?:\s+(.*))?$/i);
  if (!m) return null;
  let conta = null, pessoa = null;
  // "mercado pago" vem em duas palavras: junta antes de separar
  const resto = (m[1] || "").replace(/mercado\s+pago/i, "mercadopago");
  for (const tok of resto.split(/\s+/).filter(Boolean)) {
    const c = normalizarConta(tok);
    if (c && !conta) conta = c;
    else if (!c && !pessoa) pessoa = tok;
  }
  return { conta, pessoa };
}

// data da mensagem do Telegram (unix, segundos) no fuso de Brasília (UTC-3, sem horário de verão
// desde 2019): uma foto mandada às 22h não pode cair no dia seguinte.
export function dataDaMensagem(unixSeg) {
  const ms = Number.isFinite(unixSeg) ? unixSeg * 1000 : Date.now();
  return new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

const slug = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// /Finanças/Patrimônio/AAAA/AAAA-MM-DD_<conta>_<pessoa>.<ext>
export function caminhoPatrimonio({ dataISO, conta, pessoa, ext }) {
  return `/Finanças/Patrimônio/${dataISO.slice(0, 4)}/${dataISO}_${slug(conta)}_${slug(pessoa)}.${ext}`;
}

/**
 * Total de uma conta numa data: soma os títulos e, para cada família, só usa o agregado quando
 * não há título dessa família (na mesma conta e data — quem chama já filtrou).
 * @param {Array<{familia, nivel, saldo_cents}>} linhas
 * @returns {{total_cents: number, porFamilia: Object<string, number>}}
 */
export function totalContaData(linhas) {
  const comTitulo = new Set(linhas.filter((l) => l.nivel === "titulo").map((l) => l.familia));
  const porFamilia = {};
  let total_cents = 0;
  for (const l of linhas) {
    if (l.nivel === "agregado" && comTitulo.has(l.familia)) continue;
    const v = Number(l.saldo_cents) || 0;
    porFamilia[l.familia] = (porFamilia[l.familia] || 0) + v;
    total_cents += v;
  }
  return { total_cents, porFamilia };
}

/**
 * Foto do mês de uma conta: para cada família, vale a última data do mês em que ela apareceu;
 * dentro dessa data, títulos substituem o agregado. Assim um detalhe no dia 05 e um agregado no
 * dia 20 não somam a renda fixa duas vezes, e um print só de Fundos não apaga as outras famílias.
 * @param {Array<{data, familia, nivel, saldo_cents, rend_mes_cents?, n_rend_mes?}>} linhas - uma conta, um mês
 * @returns {null | {data, total_cents, porFamilia, rendimento_print_cents: number|null}}
 */
export function fotoDoMes(linhas) {
  if (!linhas || !linhas.length) return null;
  const ultima = {};
  for (const l of linhas) if (!ultima[l.familia] || l.data > ultima[l.familia]) ultima[l.familia] = l.data;
  const escolhidas = linhas.filter((l) => l.data === ultima[l.familia]);
  const { total_cents, porFamilia } = totalContaData(escolhidas);
  // rendimento do print com período 'mes', das mesmas linhas que entraram no saldo
  const comTitulo = new Set(escolhidas.filter((l) => l.nivel === "titulo").map((l) => l.familia));
  let rend = 0, nRend = 0;
  for (const l of escolhidas) {
    if (l.nivel === "agregado" && comTitulo.has(l.familia)) continue;
    if (Number(l.n_rend_mes) > 0) { rend += Number(l.rend_mes_cents) || 0; nRend += Number(l.n_rend_mes); }
  }
  const data = Object.values(ultima).sort().pop();
  return { data, total_cents, porFamilia, rendimento_print_cents: nRend ? rend : null };
}

const somaDia = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ultimoDia = (mes) => { const [a, m] = mes.split("-").map(Number); return `${mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`; };

/**
 * Os imports (`importacoes`) cobrem o mês inteiro, do dia 01 ao último? Registros que se
 * encostam ou se sobrepõem somam. Registro sem `de` não prova o começo: não conta.
 * @param {Array<{de: string|null, ate: string}>} periodos
 */
export function cobreMes(periodos, mes) {
  const ps = (periodos || []).filter((p) => p && p.de && p.ate)
    .map((p) => ({ de: String(p.de).slice(0, 10), ate: String(p.ate).slice(0, 10) }))
    .sort((a, b) => (a.de < b.de ? -1 : a.de > b.de ? 1 : 0));
  let ate = somaDia(`${mes}-01`, -1); // coberto até aqui (o dia anterior ao mês)
  for (const p of ps) {
    if (p.de > somaDia(ate, 1)) break; // buraco antes do próximo registro
    if (p.ate > ate) ate = p.ate;
  }
  return ate >= ultimoDia(mes);
}

// aporte ou resgate de uma linha de extrato: a categoria é Investimentos (pelo padrão da
// descrição) e o sinal do extrato dá a direção — saiu dinheiro (despesa) = aporte, entrou
// (receita) = resgate. É o mesmo critério que a soma em SQL usa (categoria + natureza).
export function movimentoInvestimento(descricao, natureza) {
  if (reconhecerNaoGasto(descricao) !== "Investimentos") return null;
  return natureza === "receita" ? "resgate" : "aporte";
}

export const MOTIVOS = {
  extratoPendente: "extrato pendente",
  semPrint: "sem print no mês",
  semAnterior: "sem print anterior",
  periodo: "rendimento do print não é do mês",
};

/**
 * Rendimento do mês de uma conta. Sem dado, null — nunca zero (zero diria "não rendeu").
 * - conta calculada (Itaú do Caio): saldo − (saldo anterior + aportes − resgates), só com o
 *   extrato cobrindo o mês inteiro;
 * - as demais: o rendimento do print quando o período é 'mes'.
 * @returns {{rendimento_cents: number|null, origem: 'calculado'|'print'|'sem', motivo: string|null}}
 */
export function rendimentoDoMes({ calculada = false, coberto = false, foto = null, fotoAnterior = null, aportes_cents = 0, resgates_cents = 0 }) {
  const sem = (motivo) => ({ rendimento_cents: null, origem: "sem", motivo });
  if (calculada && !coberto) return sem(MOTIVOS.extratoPendente);
  if (!foto) return sem(MOTIVOS.semPrint);
  if (!fotoAnterior) return sem(MOTIVOS.semAnterior);
  if (calculada) {
    const r = foto.total_cents - (fotoAnterior.total_cents + (Number(aportes_cents) || 0) - (Number(resgates_cents) || 0));
    return { rendimento_cents: r, origem: "calculado", motivo: null };
  }
  if (foto.rendimento_print_cents == null) return sem(MOTIVOS.periodo);
  return { rendimento_cents: foto.rendimento_print_cents, origem: "print", motivo: null };
}

// rótulo da origem para a tela e o bot: "calculado", "print", "sem rendimento (extrato pendente)"
export function rotuloRendimento(r) {
  if (!r) return "sem rendimento";
  if (r.origem === "sem") return r.motivo ? `sem rendimento (${r.motivo})` : "sem rendimento";
  return r.origem;
}

const anterior = (mes) => { const [a, m] = mes.split("-").map(Number); const d = new Date(Date.UTC(a, m - 2, 1)); return d.toISOString().slice(0, 7); };

/**
 * Monta a resposta de GET /api/patrimonio.
 * @param {string[]} meses - 'YYYY-MM', em ordem
 * @param {{linhas: Array<{mes, data, conta, pessoa, familia, nivel, saldo_cents, rend_mes_cents, n_rend_mes}>,
 *          aportes: Array<{mes, aportes_cents, resgates_cents}>, periodosItau: Array<{de, ate}>,
 *          calculada?: {conta, pessoa}}} leituras - linhas incluem o mês anterior ao primeiro
 */
export function montarPatrimonio(meses, { linhas = [], aportes = [], periodosItau = [], calculada = CONTA_CALCULADA } = {}) {
  for (const m of meses) if (!ISO_MES.test(m || "")) throw new Error(`mes inválido: ${m}`);
  const chave = (conta, pessoa) => `${conta}|${pessoa}`;
  const contas = [];
  const vistas = new Set();
  const porChaveMes = new Map();
  for (const l of linhas) {
    const k = chave(l.conta, l.pessoa);
    if (!vistas.has(k)) { vistas.add(k); contas.push({ conta: l.conta, pessoa: l.pessoa }); }
    const km = `${k}|${l.mes}`;
    if (!porChaveMes.has(km)) porChaveMes.set(km, []);
    porChaveMes.get(km).push(l);
  }
  contas.sort((a, b) => (a.pessoa + a.conta).localeCompare(b.pessoa + b.conta));
  const ap = new Map(aportes.map((a) => [a.mes, a]));
  const ehCalculada = (c) => c.conta === calculada.conta && String(c.pessoa).toLowerCase() === String(calculada.pessoa).toLowerCase();
  const foto = (c, mes) => fotoDoMes(porChaveMes.get(`${chave(c.conta, c.pessoa)}|${mes}`) || []);

  const serie = meses.map((mes) => {
    const porConta = contas.map((c) => {
      const f = foto(c, mes);
      const calc = ehCalculada(c);
      const a = ap.get(mes) || {};
      const r = rendimentoDoMes({
        calculada: calc, coberto: calc && cobreMes(periodosItau, mes),
        foto: f, fotoAnterior: foto(c, anterior(mes)),
        aportes_cents: a.aportes_cents || 0, resgates_cents: a.resgates_cents || 0,
      });
      return {
        conta: c.conta, pessoa: c.pessoa,
        data: f ? f.data : null, total_cents: f ? f.total_cents : null, porFamilia: f ? f.porFamilia : {},
        rendimento_cents: r.rendimento_cents, origem: r.origem, motivo: r.motivo,
      };
    });
    const comFoto = porConta.filter((c) => c.total_cents != null);
    const porPessoa = [];
    for (const c of comFoto) {
      let p = porPessoa.find((x) => x.pessoa === c.pessoa);
      if (!p) { p = { pessoa: c.pessoa, total_cents: 0 }; porPessoa.push(p); }
      p.total_cents += c.total_cents;
    }
    const total_cents = comFoto.length ? comFoto.reduce((s, c) => s + c.total_cents, 0) : null;
    return { mes, total_cents, porPessoa, porConta };
  });
  return { meses: serie, contas };
}

// confirmação do bot: o que leu, o total (sem contar duas vezes) e quantos produtos
export function textoConfirmacao({ conta, pessoa, dataISO, produtos }) {
  const { total_cents } = totalContaData(produtos);
  const [a, m, d] = dataISO.split("-");
  const n = produtos.length;
  return `✅ Patrimônio · ${conta} · ${pessoa} · ${d}/${m}/${a}\nR$ ${centsToBR(total_cents)} em ${n} produto${n === 1 ? "" : "s"}`;
}
