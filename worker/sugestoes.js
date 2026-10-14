// H4 — sugestões do JEV para as linhas novas do import (rota POST /api/importar/sugestoes).
//
// A prévia sai como sempre (sem modelo); a tela pede as sugestões depois, em lotes de até 20
// linhas. Aqui mora o que a rota faz com um lote: decide quais linhas vão ao JEV, chama a API HTTP
// da TypeSafe (sem SDK) e devolve a sugestão de cada uma. O fetch entra por parâmetro.
//
// O import nunca falha por causa do JEV: sem chave, com erro de rede, 429/529 repetido ou resposta
// inválida, a linha volta sem sugestão (fica na padrão) e o lote volta com `indisponivel`.
// Nada aqui grava no banco — em especial, nenhuma regra em `associacoes` nasce do JEV.
import { classificar } from "./classificar.js";
import { classificarLinha, preenche, LOTE_MAX } from "./jev.js";

export const URL_JEV = "https://api.typesafe.ai/v1/systemone";
export const AVISO_INDISPONIVEL = "classificação automática indisponível";
// Teto de chamadas por lote, novas tentativas incluídas: o Worker tem 50 subrequests por pedido e
// a rota já gasta 2 lendo catálogo e associações. Passou disso, a linha fica sem sugestão.
export const ORCAMENTO_CHAMADAS = 40;
// Quantas linhas conversam com o JEV ao mesmo tempo (gentil com o limite de taxa da API).
const CONCORRENCIA = 4;
const ESPERA_429_MS = 400;

/** Erro de entrada do lote (vira 400 na rota), ou null se o lote é aceitável. */
export function validarLote(b) {
  if (!b || !Array.isArray(b.itens)) return "itens deve ser uma lista";
  if (b.itens.length > LOTE_MAX) return `lote acima de ${LOTE_MAX} linhas`;
  if (b.fonte !== "extrato" && b.fonte !== "fatura") return "fonte deve ser extrato ou fatura";
  return null;
}

/**
 * A linha vai ao JEV? Só a nova (status `novo`) que caiu na categoria padrão: sem regra aprendida
 * (`categoriaNome`) e sem categoria de não-gasto (`categoriaOrg`). A regra aprendida é conferida de
 * novo contra `associacoes` — se o Caio ensinou a regra entre a prévia e o pedido, ela vale.
 * Casada, repetida (hash), ambígua e repasse nunca vão.
 */
export function vaiAoJev(item, associacoes = {}) {
  if (!item || item.status !== "novo") return false;
  if (item.categoriaNome || item.categoriaOrg) return false;
  if (typeof item.descricao !== "string" || !item.descricao.trim()) return false;
  if (!Number.isInteger(item.valorCents)) return false;
  if (item.natureza !== "despesa" && item.natureza !== "receita") return false;
  return !classificar(item.descricao, associacoes).categoriaNome;
}

/**
 * Faz a pergunta pela API HTTP. 429/529 → uma nova tentativa depois de uma espera curta; na
 * segunda falha (ou qualquer outro status), lança. Cada tentativa gasta do `orcamento`.
 */
export function criarPerguntar({ chave, fetchImpl, esperar = esperaPadrao, orcamento = { resta: ORCAMENTO_CHAMADAS } }) {
  const chamar = async (corpo) => {
    if (orcamento.resta <= 0) throw new Error("orçamento de chamadas do lote esgotado");
    orcamento.resta--;
    return fetchImpl(URL_JEV, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + chave },
      body: JSON.stringify(corpo),
    });
  };
  return async (corpo) => {
    let r = await chamar(corpo);
    if (r.status === 429 || r.status === 529) {
      await esperar(ESPERA_429_MS);
      r = await chamar(corpo);
    }
    if (!r.ok) throw new Error(`JEV respondeu ${r.status}`);
    return r.json();
  };
}

function esperaPadrao(ms) {
  return new Promise((ok) => setTimeout(ok, ms));
}

async function emParalelo(lista, n, fn) {
  const saida = new Array(lista.length);
  let prox = 0;
  const trabalhador = async () => {
    while (prox < lista.length) {
      const k = prox++;
      saida[k] = await fn(lista[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, trabalhador));
  return saida;
}

const semSugestao = (item) => ({ indice: item?.indice ?? null, sugestao: null, preenche: false });

/**
 * Sugere a categoria das linhas do lote. Devolve `{itens: [{indice, sugestao, preenche}],
 * indisponivel, aviso?}` — uma entrada por linha recebida, na mesma ordem. `sugestao` é
 * `{categoria, subcategoria, prob_categoria, prob_subcategoria}` ou null.
 */
export async function sugerirLote(b, { catalogo, associacoes = {}, chave, fetchImpl, esperar } = {}) {
  const itens = b.itens;
  if (!chave) {
    return { itens: itens.map(semSugestao), indisponivel: true, aviso: AVISO_INDISPONIVEL };
  }
  const perguntar = criarPerguntar({ chave, fetchImpl, esperar });
  let falhou = false;
  const saida = await emParalelo(itens, CONCORRENCIA, async (item) => {
    if (!vaiAoJev(item, associacoes)) return semSugestao(item);
    try {
      const s = await classificarLinha({
        descricao: item.descricaoFinal ?? item.descricao,
        contraparte: item.contraparte ?? null,
        valorCents: item.valorCents, natureza: item.natureza, fonte: b.fonte,
      }, catalogo, perguntar);
      const sugestao = { categoria: s.categoria, subcategoria: s.subcategoria,
                         prob_categoria: s.prob_categoria, prob_subcategoria: s.prob_subcategoria };
      return { indice: item.indice ?? null, sugestao, preenche: preenche(sugestao) };
    } catch {
      falhou = true;
      return semSugestao(item);
    }
  });
  return falhou ? { itens: saida, indisponivel: true, aviso: AVISO_INDISPONIVEL } : { itens: saida, indisponivel: false };
}
