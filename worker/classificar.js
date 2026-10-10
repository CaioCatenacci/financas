// Classificação de linha de extrato/fatura (puro). Deriva o descritor do estabelecimento,
// reconhece não-gasto por padrões, e resolve categoria via associações aprendidas (Inc 2).

import { normalizarNome } from "./contraparte.js";

// Padrões de NÃO-GASTO (conservador; editável). Ordem importa.
const _NAO_GASTO = [
  // G1: aplicação E resgate (RESGATE, AG. RESGATE, INT RESGATE) são movimento de investimento —
  // nem gasto nem receita. Antes só a aplicação saía e o resgate entrava como receita.
  { rx: /\bAPLICACAO\b|RESGATE|PERSONDIF|COR COMP CDB|\bCDB\b|PERS BLACK/i, cat: "Investimentos" },
  // conta própria da Paola. O "PIX TRANSF <Caio>…" não mora aqui: no Itaú é a chegada da Wise, e
  // sai do resumo pela lista CONTAS_PROPRIAS (prefixo do nome), em montarPreviewExtrato (G1) — o
  // nome nunca vai no código. Os importadores Python seguem com o padrão antigo (BACKLOG C6).
  { rx: /PIX TRANSF PAOLA\b/i, cat: "Transferências" },
  { rx: /PAGAMENTO.*(CARTAO|FATURA)|DEB.*CARTAO/i, cat: "Fatura de cartão" },
];

const _DATA_SUFIXO = /\s*\d{2}\/\d{2}\s*$/;            // '…30/12' no fim
// DA = débito automático (Itaú); "Pix recebido de"/"Pix enviado para" = descrição do C6 (C1)
const _PREFIXOS = /^(PIX QRS|PIX TRANSF|PIX RECEBIDO DE|PIX ENVIADO PARA|PAG BOLETO|DA|TED|DOC)\b\s*/i;

/**
 * Remove sufixo de data, prefixos conhecidos, números longos, pontuação.
 * Resultado: mesmo estabelecimento, meses diferentes → mesmo string.
 */
export function normalizarDescritor(descricao) {
  let s = descricao.trim();
  s = s.replace(_DATA_SUFIXO, "");          // remove '…30/12' no fim
  s = s.replace(_PREFIXOS, "");             // remove prefixos
  s = s.replace(/\d{3,}/g, " ");            // números longos (docs/contas) viram espaço
  s = s.replace(/[.\-]/g, " ");             // ponto e hífen viram espaço
  s = s.replace(/\s+/g, " ").trim().toLowerCase(); // colapa espaços, minúsculo
  return s;
}

/**
 * Reconhece padrões de não-gasto: transferências, investimentos, fatura de cartão.
 * Retorna a categoria (string) ou null se é um gasto comum.
 */
export function reconhecerNaoGasto(descricao) {
  for (const { rx, cat } of _NAO_GASTO) {
    if (rx.test(descricao)) {
      return cat;
    }
  }
  return null;
}

/**
 * Classifica uma transação: detecta não-gasto, resolve categoria via associação.
 *
 * @param {string} descricao - descrição da transação
 * @param {Object} associacoes - dict { chaveNormalizada: { categoriaNome, subNome } }
 * @returns {Object} { contraparteNome, categoriaNome|null, subNome|null, computaResumo, categoriaOrg|null }
 */
export function classificar(descricao, associacoes = {}) {
  const org = reconhecerNaoGasto(descricao);
  const descritor = normalizarDescritor(descricao);

  if (org) {
    // Não-gasto: não computa resumo, guarda categoria original
    return {
      contraparteNome: descritor,
      categoriaNome: null,
      subNome: null,
      computaResumo: false,
      categoriaOrg: org,
    };
  }

  // Gasto comum: lookup associação usa normalizarNome para casar chave
  const chaveNormalizada = normalizarNome(descritor);
  const a = associacoes[chaveNormalizada];

  return {
    contraparteNome: descritor,
    categoriaNome: a ? a.categoriaNome : null,
    subNome: a ? a.subNome : null,
    computaResumo: true,
    categoriaOrg: null,
  };
}
