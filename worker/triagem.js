// H5 — triagem assistida pelo JEV na aba Lançamentos (rota POST /api/triagem/sugestoes).
//
// As linhas já gravadas na categoria padrão ("Não Identificado") ganham uma sugestão do JEV para o
// Caio aceitar ou trocar. Diferente do import (H4, worker/sugestoes.js), aqui as linhas vêm do banco
// por id — quem chama passa a leitura pronta em `linhas` — e nada é gravado: aceitar é a
// reclassificação manual de sempre (PATCH /api/transacoes/:id ou o lote), feita pela tela.
//
// Reaproveita as perguntas, a regra IFD* (worker/jev.js) e o cliente HTTP com uma nova tentativa no
// 429/529 (criarPerguntar, worker/sugestoes.js). O fetch entra por parâmetro.
import { classificarLinha, FONTES } from "./jev.js";
import { criarPerguntar, emParalelo, AVISO_INDISPONIVEL } from "./sugestoes.js";
import { ehUuid } from "./validar.js";

// 2 perguntas por linha × 10 = 20 chamadas por pedido, folgado no teto de subrequests do Worker.
// (O import segue com 20 linhas e só pergunta a sub acima de 0,90; aqui a sub é perguntada mais
// vezes, por isso o lote é menor.)
export const TRIAGEM_LOTE_MAX = 10;
// O X da tela: a partir dele a sub é perguntada e a linha ganha o "aceitar" (decisão do Caio, H5).
export const LIMIAR_TRIAGEM = 0.7;
const CONCORRENCIA = 4;

/** `{ids, limiar}` válido, ou `{erro}` (vira 400 na rota). Limiar ausente → 0,70. */
export function validarLoteTriagem(b) {
  if (!b || !Array.isArray(b.ids)) return { erro: "ids deve ser uma lista" };
  if (b.ids.length > TRIAGEM_LOTE_MAX) return { erro: `lote acima de ${TRIAGEM_LOTE_MAX} linhas` };
  if (!b.ids.every(ehUuid)) return { erro: "id inválido" };
  let limiar = LIMIAR_TRIAGEM;
  if (b.limiar !== undefined && b.limiar !== null) {
    if (typeof b.limiar !== "number" || !Number.isFinite(b.limiar) || b.limiar < 0 || b.limiar > 1) {
      return { erro: "limiar deve ser um número entre 0 e 1" };
    }
    limiar = b.limiar;
  }
  return { ids: [...new Set(b.ids)], limiar };
}

/**
 * A linha lida do banco entra na triagem? Só a que está na categoria padrão (`padrao = true` no
 * catálogo; nunca por nome) e não é membro não-representante de grupo — membro não conta no resumo
 * nem é editável na tela (Inc 4.6). Sem descrição, fonte fora do vocabulário ou valor que não é
 * inteiro, não há o que perguntar.
 */
export function vaiATriagem(linha, catalogo) {
  if (!linha) return false;
  const padrao = (catalogo?.categorias || []).find((c) => c.padrao);
  if (!padrao || linha.categoria_id !== padrao.id) return false;
  if (linha.grupo_id && !linha.representante) return false;
  if (typeof linha.descricao !== "string" || !linha.descricao.trim()) return false;
  if (!FONTES.includes(linha.fonte)) return false;
  if (linha.natureza !== "despesa" && linha.natureza !== "receita") return false;
  return Number.isInteger(Number(linha.valor_cents));
}

/**
 * Sugestão para cada id pedido, na ordem do pedido: `{itens: [{id, sugestao, ignorado}],
 * indisponivel, aviso?}`. `ignorado` = a linha não está (mais) na triagem (outra categoria, membro
 * de grupo, id que não existe) — não houve chamada. `sugestao` é `{categoria, subcategoria,
 * prob_categoria, prob_subcategoria}` ou null. Sem chave, ou com qualquer falha do JEV, a linha
 * volta sem sugestão e o corpo traz o aviso — como no import.
 */
export async function sugerirTriagem(ids, limiar, { linhas = [], catalogo, chave, fetchImpl, esperar } = {}) {
  if (!chave) {
    return { itens: ids.map((id) => ({ id, sugestao: null, ignorado: false })), indisponivel: true, aviso: AVISO_INDISPONIVEL };
  }
  const porId = new Map(linhas.map((l) => [l.id, l]));
  const perguntar = criarPerguntar({ chave, fetchImpl, esperar });
  let falhou = false;
  const itens = await emParalelo(ids, CONCORRENCIA, async (id) => {
    const l = porId.get(id);
    if (!vaiATriagem(l, catalogo)) return { id, sugestao: null, ignorado: true };
    try {
      const s = await classificarLinha({
        descricao: l.descricao, contraparte: l.contraparte_nome ?? null,
        valorCents: Number(l.valor_cents), natureza: l.natureza, fonte: l.fonte,
      }, catalogo, perguntar, limiar);
      return { id, ignorado: false, sugestao: { categoria: s.categoria, subcategoria: s.subcategoria,
        prob_categoria: s.prob_categoria, prob_subcategoria: s.prob_subcategoria } };
    } catch {
      falhou = true;
      return { id, sugestao: null, ignorado: false };
    }
  });
  return falhou ? { itens, indisponivel: true, aviso: AVISO_INDISPONIVEL } : { itens, indisponivel: false };
}
