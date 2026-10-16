// H4 — perguntas do JEV (TypeSafe) para classificar a linha nova do import (puro).
//
// Porte de tools/jev_classificar.py (H2/H3): o mesmo estado (com a fonte explicada), as mesmas
// descrições escritas à mão, a sub genérica no lugar de "sem subcategoria" e a regra "IFD*" →
// Alimentação/Ifood sem chamada. Se mexer numa pergunta aqui, mexa lá também (e vice-versa): o
// limiar de 0,90 foi medido no H2 com estas perguntas, e uma pergunta diferente mede outra coisa.
//
// Nada de rede nem de banco aqui: quem faz a chamada HTTP entra por parâmetro (`perguntar`), como o
// catálogo e a linha. É o que deixa testar a classificação sem a API e sem chave.

export const NENHUMA = "nenhuma serve";
export const SEM_SUB = "sem subcategoria";

// Decisão do Caio (13/10/2026, H3): ~60% das pendentes com ~92% de acerto em categoria+sub.
export const LIMIAR_JEV = 0.9;
// 2 perguntas por linha × 20 = 40 chamadas, abaixo do teto de 50 subrequests do Worker.
export const LOTE_MAX = 20;

export const FONTES = ["extrato", "fatura", "imagem", "importacao", "manual"];

// O que a fonte quer dizer, para o JEV. No H1 o estado mandava só "fatura", e o modelo puxava
// qualquer compra de cartão para "Banco → Fatura de cartão": o nome da fonte parecia o nome da sub.
export const FONTE_EXPLICADA = {
  extrato: "movimento da conta corrente (linha do extrato bancário)",
  fatura: "compra feita no cartão de crédito (linha da fatura)",
  imagem: "comprovante fotografado (Pix, boleto ou recibo)",
  importacao: "lançamento trazido da planilha antiga de controle",
  manual: "lançamento digitado à mão",
};

// Descrição escrita à mão por categoria; tem precedência sobre o "inclui: <subs>".
export const DESCRICAO_CATEGORIA = {
  Banco: "tarifas, juros, IOF, anuidade e o pagamento da fatura em si — nunca uma compra feita no cartão",
};

// Descrição escrita à mão por (categoria, sub), chave "Categoria|Sub". Vale mais que o critério
// da genérica (Alimentação → Outros diz o que cobre).
export const DESCRICAO_SUB = {
  "Alimentação|Restaurante": "comer ou beber no local: restaurante, bar, café",
  "Alimentação|Outros": "delivery fora do iFood, padaria, sorveteria e o resto",
};

export const CRITERIO_GENERICA = "quando nenhuma outra subcategoria se aplica";

// Regra fixa antes do modelo: "IFD*" é sempre iFood (no H1 o JEV escolhia Restaurante/Mercado).
export const PREFIXO_IFOOD = "IFD*";
export const REGRA_IFOOD = { categoria: "Alimentação", subcategoria: "Ifood" };

// Crédito/estorno de extrato e fatura é receita sob categoria de despesa (naturezaAoReclassificar,
// worker/categorias.js): por isso essas receitas escolhem entre TODAS as categorias.
const FONTES_COM_ESTORNO = ["extrato", "fatura"];

const norm = (v) => String(v ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
const ativa = (x) => x.ativa !== false;

/** As categorias que o JEV pode escolher. A padrão nunca entra: é dela que a linha quer sair, e o
 *  "nenhuma serve" faz o papel dela (mantê-la deixaria o resultado circular). */
export function opcoesCategoria(natureza, fonte, catalogo) {
  const ativas = (catalogo.categorias || []).filter((c) => ativa(c) && !c.padrao);
  if (natureza === "despesa") return ativas.filter((c) => c.natureza === "despesa");
  if (FONTES_COM_ESTORNO.includes(fonte)) return ativas;
  return ativas.filter((c) => c.natureza === "receita");
}

export function subsAtivas(categoriaId, catalogo) {
  return (catalogo.subcategorias || []).filter((s) => s.categoria_id === categoriaId && ativa(s));
}

/** Choice da categoria. A descrição de cada opção lista as subs, que dizem ao modelo o que a
 *  categoria cobre melhor que o nome sozinho. */
export function perguntaCategoria(linha, catalogo) {
  const criteria = {};
  for (const c of opcoesCategoria(linha.natureza, linha.fonte, catalogo)) {
    if (Object.hasOwn(DESCRICAO_CATEGORIA, c.nome)) {
      criteria[c.nome] = DESCRICAO_CATEGORIA[c.nome];
      continue;
    }
    const subs = subsAtivas(c.id, catalogo).map((s) => s.nome);
    criteria[c.nome] = subs.length ? `inclui: ${subs.join(", ")}` : null;
  }
  criteria[NENHUMA] = "Nenhuma das outras categorias serve para esta transação.";
  let instructions = "Em qual categoria do orçamento doméstico esta transação se encaixa?";
  if (linha.natureza === "receita" && FONTES_COM_ESTORNO.includes(linha.fonte)) {
    instructions += " Uma receita de extrato ou fatura costuma ser estorno ou crédito de " +
      "uma compra: nesse caso, escolha a categoria da compra.";
  }
  return { type: "choice", instructions, criteria };
}

/** A sub "quando nada mais se aplica": a de mesmo nome da categoria (Compras → Compras) ou, sem
 *  ela, "Outros". Com as duas, a de mesmo nome vence. null se não há nenhuma. */
export function subGenerica(categoria, catalogo) {
  const nomes = subsAtivas(categoria.id, catalogo).map((s) => s.nome);
  for (const alvo of [categoria.nome, "Outros"]) {
    const achada = nomes.find((n) => norm(n) === norm(alvo));
    if (achada !== undefined) return achada;
  }
  return null;
}

/** Choice da sub entre as ativas da categoria; null se ela não tem sub ativa. Com sub genérica,
 *  "sem subcategoria" sai: no H1 o JEV fugia para ela quando não sabia, e o Caio usa a genérica. */
export function perguntaSubcategoria(categoria, catalogo) {
  const subs = subsAtivas(categoria.id, catalogo);
  if (!subs.length) return null;
  const generica = subGenerica(categoria, catalogo);
  const criteria = {};
  for (const s of subs) {
    let criterio = DESCRICAO_SUB[`${categoria.nome}|${s.nome}`] ?? null;
    if (criterio === null && s.nome === generica) criterio = CRITERIO_GENERICA;
    criteria[s.nome] = criterio;
  }
  if (generica === null) criteria[SEM_SUB] = "A transação é desta categoria, mas nenhuma subcategoria se aplica.";
  return { type: "choice", instructions: `Dentro da categoria ${categoria.nome}, qual subcategoria?`, criteria };
}

/** Centavos → "1.234,56", só com inteiros (nada de float no dinheiro). */
export function formatarValor(centavos) {
  const c = Math.trunc(Number(centavos));
  const abs = Math.abs(c);
  const reais = Math.trunc(abs / 100);
  const cent = abs % 100;
  const milhar = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${c < 0 ? "-" : ""}${milhar},${String(cent).padStart(2, "0")}`;
}

/** O que o JEV vê da linha. Contraparte pode ser nula (extrato não tem).
 *  H6: a `legenda` (o que o Caio escreveu no comprovante do Telegram) é opcional e só entra no
 *  estado quando existe — no import e na triagem ela não vem, e o estado fica idêntico ao medido
 *  no H2 (por isso não há o que espelhar em tools/jev_classificar.py). */
export function estado(linha) {
  if (!FONTES.includes(linha.fonte)) throw new Error(`fonte fora do vocabulário: ${linha.fonte}`);
  const est = {
    descricao: linha.descricao || "",
    contraparte: linha.contraparte ?? null,
    valor: formatarValor(linha.valorCents),
    natureza: linha.natureza,
    fonte: FONTE_EXPLICADA[linha.fonte],
  };
  if (typeof linha.legenda === "string" && linha.legenda.trim()) est.legenda = linha.legenda.trim();
  return est;
}

/** A sugestão da regra fixa, ou null se nenhuma regra se aplica. Não gasta chamada. */
export function regraFixa(linha) {
  if (String(linha.descricao || "").trim().toUpperCase().startsWith(PREFIXO_IFOOD)) {
    return { categoria: REGRA_IFOOD.categoria, subcategoria: REGRA_IFOOD.subcategoria,
             prob_categoria: 1, prob_subcategoria: 1, origem: "regra" };
  }
  return null;
}

/** Corpo do POST /v1/systemone (contrato HTTP da TypeSafe, sem SDK). */
export function corpoPergunta(est, id, pergunta) {
  return { model: "jev-latest", state: est, questions: { [id]: pergunta } };
}

/**
 * Interpreta a resposta: `answers.<id>.choice`, com prob = `answers.<id>.probabilities[choice]`.
 * Escolha fora das opções perguntadas ou probabilidade que não é número entre 0 e 1 → null
 * (resposta inválida: a linha fica sem sugestão, nunca com um nome inventado).
 */
export function lerResposta(json, id, pergunta) {
  const a = json && json.answers && json.answers[id];
  if (!a || typeof a.choice !== "string") return null;
  if (pergunta && !Object.hasOwn(pergunta.criteria, a.choice)) return null;
  const prob = a.probabilities && a.probabilities[a.choice];
  if (typeof prob !== "number" || !Number.isFinite(prob) || prob < 0 || prob > 1) return null;
  return { choice: a.choice, prob };
}

/** A sugestão preenche a linha? Só com confiança da categoria >= limiar (0,90 no import) e
 *  categoria de verdade ("nenhuma serve" nunca preenche, nem com confiança alta — como no H3). */
export function preenche(sugestao, limiar = LIMIAR_JEV) {
  return !!sugestao && sugestao.categoria !== NENHUMA && typeof sugestao.prob_categoria === "number" &&
    sugestao.prob_categoria >= limiar;
}

/**
 * Classifica uma linha. `perguntar(corpo)` faz a chamada (async) e devolve o JSON da resposta, ou
 * lança. Resposta inválida também lança: quem chama decide que a linha fica sem sugestão.
 *
 * A pergunta da sub só é feita quando a confiança da categoria passa de `limiarSub`: abaixo dele a
 * sub não seria usada — e cada chamada a menos é um subrequest a menos no lote. O import (H4) usa o
 * padrão 0,90 (é o mesmo corte que preenche a linha); a triagem (H5) passa o X da tela (0,70), já
 * que lá quem decide é o Caio, ao aceitar.
 */
export async function classificarLinha(linha, catalogo, perguntar, limiarSub = LIMIAR_JEV) {
  const regra = regraFixa(linha);
  if (regra) return regra;
  const est = estado(linha);
  const pc = perguntaCategoria(linha, catalogo);
  const rc = lerResposta(await perguntar(corpoPergunta(est, "categoria", pc)), "categoria", pc);
  if (!rc) throw new Error("resposta do JEV sem answers válidos (categoria)");
  const sugestao = { categoria: rc.choice, subcategoria: null, prob_categoria: rc.prob,
                     prob_subcategoria: null, origem: "jev" };
  if (!preenche(sugestao, limiarSub)) return sugestao;
  const escolhida = opcoesCategoria(linha.natureza, linha.fonte, catalogo).find((c) => c.nome === rc.choice);
  const ps = escolhida ? perguntaSubcategoria(escolhida, catalogo) : null;
  if (!ps) return sugestao;
  const rs = lerResposta(await perguntar(corpoPergunta(est, "subcategoria", ps)), "subcategoria", ps);
  if (!rs) throw new Error("resposta do JEV sem answers válidos (subcategoria)");
  sugestao.subcategoria = rs.choice === SEM_SUB ? null : rs.choice;
  sugestao.prob_subcategoria = rs.prob;
  return sugestao;
}
