// G5: lembrete do fechamento pelo Telegram (cron dos dias 5 e 15). Puro: sem banco, sem rede,
// sem relógio. O estado do mês vem de lerFechamento (a mesma regra do /api/fechamento, nada de
// regra nova de "o que falta"), as contas sem foto vêm de montarPatrimonio, e o envio recebe o
// `responder` e o `fetchImpl` de quem chama.
//
// Regra (card G5, Decisões de 2026-10-13):
// - mês anterior faltando/parcial → lista o que falta por fonte e as transações sem categoria;
// - mês anterior fechado sem diagnóstico salvo → "<mês> fechado — pode pedir o diagnóstico",
//   citando sem categoria e salário estimado só como informação;
// - diagnóstico salvo → o aviso de mês fechado não volta (é o "uma vez" sem estado novo);
// - conta sem foto no mês corrente = total_cents == null (não origem 'sem', que é "sem
//   rendimento" e vale sempre para o Itaú calculado enquanto o extrato não cobre o mês);
// - dia 15 só fala se houver pendência; sem categoria e salário estimado de mês fechado não são
//   pendência. O texto montado só existe quando há pendência, então o dia 5 com tudo em dia
//   também fica em silêncio (não há o que dizer).

const NOMES_MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
  "setembro", "outubro", "novembro", "dezembro"];

const nomeDoMes = (mes) => NOMES_MES[Number(mes.slice(5, 7)) - 1];
const maiuscula = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const proximoMes = (mes) => {
  const [a, m] = mes.split("-").map(Number);
  return new Date(Date.UTC(a, m, 1)).toISOString().slice(0, 7);
};
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const plural = (n, um, varios) => (n === 1 ? um : varios);

// linha de uma fonte de extrato que não está cheia
function linhaExtrato(nome, fonte) {
  if (!fonte || fonte.cobertura === "cheia") return null;
  return fonte.ate ? `• ${nome}: extrato depois de ${ddmm(String(fonte.ate))}` : `• ${nome}: nenhum extrato importado`;
}

function linhaPatrimonio(mesCorrente, contasSemFoto) {
  if (!contasSemFoto || !contasSemFoto.length) return null;
  const nomes = contasSemFoto.map((c) => `do ${c.conta} (${c.pessoa})`);
  const lista = nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
  return `Patrimônio de ${nomeDoMes(mesCorrente)}: falta o print ${lista}.`;
}

/**
 * Monta o texto do lembrete, ou null quando não há o que dizer.
 * @param {{dia:number, mesAnterior:{mes, estado, fontes, sem_categoria}, mesCorrente?:string,
 *          contasSemFoto:Array<{conta, pessoa}>, temDiagnostico:boolean}} p
 * @returns {string|null}
 */
export function montarLembrete({ dia, mesAnterior, mesCorrente = null, contasSemFoto = [], temDiagnostico = false }) {
  const m = mesAnterior;
  const corrente = mesCorrente || proximoMes(m.mes);
  const nome = nomeDoMes(m.mes);
  const semCat = Number(m.sem_categoria) || 0;
  const estimado = !!(m.fontes && m.fontes.salario && m.fontes.salario.estimado);
  const partes = [];

  if (m.estado !== "fechado") {
    const f = m.fontes || {};
    const linhas = [
      linhaExtrato("Itaú", f.itau),
      linhaExtrato("C6", f.c6),
      f.fatura && !f.fatura.existe ? `• fatura de ${nome}` : null,
      estimado ? "• salário estimado (falta a conversão do mês)" : null,
      semCat > 0 ? `• ${semCat} ${plural(semCat, "transação", "transações")} sem categoria` : null,
    ].filter(Boolean);
    partes.push([`📅 Fechamento de ${nome}: falta`, ...linhas].join("\n"));
  } else if (!temDiagnostico) {
    const info = [semCat > 0 ? `${semCat} sem categoria` : null, estimado ? "salário estimado" : null].filter(Boolean);
    partes.push(`📅 ${maiuscula(nome)} fechado${info.length ? ` (${info.join(", ")})` : ""} — pode pedir o diagnóstico.`);
  }

  const pat = linhaPatrimonio(corrente, contasSemFoto);
  if (pat) partes.push(pat);

  // dia 5 e dia 15 caem na mesma regra: só há parte quando há pendência. Sem categoria e salário
  // estimado de mês fechado com diagnóstico salvo não geram parte nenhuma, logo não falam sozinhos.
  return partes.length ? partes.join("\n") : null;
}

/** Contas do mês com total_cents == null em montarPatrimonio(...).meses. */
export function contasSemFotoDoMes(patrimonio, mes) {
  const m = ((patrimonio && patrimonio.meses) || []).find((x) => x.mes === mes);
  if (!m) return [];
  return m.porConta.filter((c) => c.total_cents == null).map((c) => ({ conta: c.conta, pessoa: c.pessoa }));
}

/** Dia, mês corrente e mês anterior a partir do event.scheduledTime (ms, UTC). */
export function momentoDoLembrete(scheduledTime) {
  const d = new Date(scheduledTime);
  const mesCorrente = d.toISOString().slice(0, 7);
  const anterior = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  return { dia: d.getUTCDate(), mesCorrente, mesAnterior: anterior };
}

/** Ids do ALLOWLIST (CSV), lidos como em worker/auth.js; ausente ou vazio → []. */
export function idsDaAllowlist(allowlistCsv) {
  if (!allowlistCsv) return [];
  return String(allowlistCsv).split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Manda o texto para cada id do ALLOWLIST. Lista vazia não manda nada (falha fechada). Erro num
 * envio vai pro console.error e não impede os outros: o cron nunca lança.
 * @param {Function} enviar - responder(token, chatId, texto, fetchImpl) de worker/telegram.js
 */
export async function enviarLembrete(texto, allowlistCsv, token, fetchImpl, enviar) {
  for (const id of idsDaAllowlist(allowlistCsv)) {
    try {
      await enviar(token, id, texto, fetchImpl);
    } catch (err) {
      console.error("lembrete: envio falhou", err && err.message ? err.message : String(err));
    }
  }
}
