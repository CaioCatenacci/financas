// Orquestração pura de import (extrato/fatura): monta o preview (parse → checksum → classifica
// → reconcilia) e aplica a decisão revisada no banco. Espelha tools/importar_extrato.py e
// tools/importar_fatura.py, mas puro — todo dado que viria do banco (catálogo, associações,
// existentes, hashes já gravados) entra por parâmetro; só `aplicar` recebe `db` (injetado),
// porque é o único ponto do fluxo que precisa gravar de fato.
import { parseExtrato, conferirChecksum } from "./extrato.js";
import { parseFatura } from "./fatura.js";
import { classificar } from "./classificar.js";
import { linhaHash, reconciliarLinha } from "./reconciliar.js";

function resumoVazio() {
  return { novos: 0, casados: 0, naoGasto: 0, ambiguos: 0, jaTem: 0 };
}

/**
 * Monta o preview de importação de um extrato: parse → checksum → por linha, calcula a
 * linha_hash (idempotência), classifica e — só quando `computaResumo` — reconcilia contra
 * `existentes`. `catalogo` entra no parâmetro por simetria com o resto do fluxo (a resolução
 * nome→id de categoria fica pra quem monta a `decisao` de `aplicar`, não pra este preview, que
 * trabalha só com nomes).
 *
 * Se o checksum não bater, o preview é montado do mesmo jeito (itens continuam classificados) —
 * quem chama é que decide não oferecer "aplicar" enquanto `checksum.ok` for false.
 *
 * @param {string} texto - texto do PDF do extrato
 * @param {string} conta - identificador da conta (entra na linha_hash)
 * @param {{catalogo:Object, associacoes:Object, existentes:Array, hashes:Array}} ctx
 */
export function montarPreviewExtrato(texto, conta, { catalogo, associacoes = {}, existentes = [], hashes = [] } = {}) {
  void catalogo; // não usado aqui — ver docstring
  const { linhas, saldos } = parseExtrato(texto);
  // extrato: o checksum é exato (saldos batem com os lançamentos) → se não bater, BLOQUEIA aplicar.
  const chk = conferirChecksum(linhas, saldos);
  const checksum = { ...chk, bloqueiaAplicar: !chk.ok };

  // cópia local, consumida ao casar: uma linha que já casou não pode "casar" de novo com a
  // MESMA candidata para uma segunda linha do lote (mesma data/valor) — spec §6.2.
  let disponiveis = [...existentes];
  const hashesSet = new Set(hashes);

  const itens = [];
  const resumo = resumoVazio();

  for (const l of linhas) {
    const lh = linhaHash(conta, l.data, l.descricao, l.valorCents, l.ordinal);

    if (hashesSet.has(lh)) {
      // já gravada em import anterior (idempotência) — nem classifica, nem reconcilia.
      itens.push({
        ...l, linhaHash: lh, status: "jaTem", matchId: null, computaResumo: null,
        categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null,
      });
      resumo.jaTem++;
      continue;
    }

    const info = classificar(l.descricao, associacoes);

    let status;
    let matchId = null;
    if (!info.computaResumo) {
      // não-gasto (transferência p/ conta própria, aplicação, pagamento de fatura): não entra
      // na reconciliação — não é candidato a "casar" com nada em `existentes`.
      status = "naoGasto";
    } else {
      const rec = reconciliarLinha(l, disponiveis);
      status = rec.status; // "novo" | "casado" | "ambiguo"
      if (status === "casado") {
        matchId = rec.matchId;
        disponiveis = disponiveis.filter(e => e.id !== matchId);
      }
    }

    itens.push({
      ...l, linhaHash: lh, status, matchId,
      computaResumo: info.computaResumo,
      categoriaNome: info.categoriaNome, subNome: info.subNome, categoriaOrg: info.categoriaOrg,
      contraparteNome: info.contraparteNome,
    });

    if (status === "novo") resumo.novos++;
    else if (status === "casado") resumo.casados++;
    else if (status === "ambiguo") resumo.ambiguos++;
    else if (status === "naoGasto") resumo.naoGasto++;
  }

  return { checksum, itens, resumo };
}

/**
 * Monta o preview de importação de uma fatura: parse → checksum (soma dos itens == total
 * impresso, quando a fatura trouxe essa linha) → por item, linha_hash + classifica. Itens de
 * fatura são sempre gasto de cartão — não há reconciliação contra `existentes` (a fatura não
 * "casa" com nada; quem eventualmente marca o pagamento como não-gasto no extrato é outro
 * fluxo, fora deste módulo).
 *
 * @param {string} texto - texto do PDF da fatura (modo layout)
 * @param {number} ano - ano do período (a fatura só traz DD/MM)
 * @param {string|number} mes - mês do período (entra na conta sintética da linha_hash)
 * @param {{catalogo:Object, associacoes:Object, hashes:Array}} ctx
 */
export function montarPreviewFatura(texto, ano, mes, { catalogo, associacoes = {}, hashes = [] } = {}) {
  void catalogo; // não usado aqui — ver docstring de montarPreviewExtrato
  const { itens: itensBrutos, totalCents } = parseFatura(texto, ano);
  const soma = itensBrutos.reduce((s, i) => s + i.valorCents, 0);
  // totalCents=0 quando a fatura não trouxe "Total dos lançamentos atuais" — sem total pra
  // comparar não há o que checar (mesmo critério do tools/importar_fatura.py).
  // fatura: o "Total dos lançamentos atuais" inclui IOF/encargos que NÃO são lançamentos com data,
  // então a soma dos itens pode ficar um pouco abaixo do total. O checksum é AVISO (bloqueiaAplicar
  // = false): mostra a diferença mas não impede aplicar.
  const checksum = totalCents
    ? { ok: soma === totalCents, diferencaCents: totalCents - soma, bloqueiaAplicar: false }
    : { ok: true, diferencaCents: 0, bloqueiaAplicar: false };

  const conta = `fatura-${ano}${mes}`;
  const hashesSet = new Set(hashes);

  const itens = [];
  const resumo = resumoVazio();

  itensBrutos.forEach((item, i) => {
    // ordinal = índice do item na fatura (não há "várias por dia" a distinguir como no
    // extrato — o índice já é estável e único dentro da fatura).
    // linhaHash usa o valor COM sinal (estável/único: compra +X e estorno -X do mesmo lugar/data
    // ficam distintos).
    const lh = linhaHash(conta, item.data, item.descricao, item.valorCents, i);

    // estorno (valor negativo na fatura) vira RECEITA com valor positivo — igual ao extrato trata
    // crédito. valor_total no banco é sempre >= 0 (check constraint); o net entra em receita−despesa.
    const natureza = item.valorCents < 0 ? "receita" : "despesa";
    const valorCents = Math.abs(item.valorCents);

    if (hashesSet.has(lh)) {
      itens.push({
        ...item, valorCents, linhaHash: lh, status: "jaTem", matchId: null, computaResumo: null,
        categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null,
        natureza, descricaoFinal: item.descricao,
      });
      resumo.jaTem++;
      return;
    }

    const info = classificar(item.descricao, associacoes);
    // remove "PARCELA XX/YY" do texto do estabelecimento (já temos `item.parcela` separado) e
    // reanexa como sufixo "(parc XX/YY)" — mesma limpeza do tools/importar_fatura.py.
    const descLimpo = item.descricao.replace(/\bPARCELA\s+\d{2}\/\d{2}\b/i, "").trim();
    const descricaoFinal = descLimpo + (item.parcela ? ` (parc ${item.parcela})` : "");

    // Item de fatura é SEMPRE gasto de cartão (invariante do brief e da docstring acima):
    // mesmo que a descrição do estabelecimento bata num padrão de não-gasto (ex.: uma loja
    // com "CDB"/"APLICACAO" no nome), ela NÃO vira não-gasto. O único não-gasto do cartão é o
    // PAGAMENTO da fatura, que aparece no extrato — outro fluxo. Reaproveitamos `classificar`
    // só pela categoria/contraparte aprendida; ignoramos o veredito de não-gasto dele.
    itens.push({
      ...item, valorCents, linhaHash: lh, status: "novo", matchId: null,
      computaResumo: true,
      categoriaNome: info.categoriaNome, subNome: info.subNome, categoriaOrg: null,
      contraparteNome: info.contraparteNome, natureza, descricaoFinal,
    });

    resumo.novos++;
  });

  // totalCents = total impresso na fatura (não a soma dos itens novos): quem aplica usa isso pra
  // achar e marcar o pagamento correspondente no extrato como fora do resumo (evita contar 2x).
  return { checksum, itens, resumo, totalCents };
}

/**
 * Aplica a decisão já revisada (pelo usuário, no app) no banco, delegando pro
 * `db.aplicarImportacao`, que grava novos+não-gasto (insert) e carimba a linha_hash dos casados
 * numa ÚNICA transação HTTP (1 subrequest, atômica). `db` é injetado — único efeito colateral.
 *
 * `decisao.novos`/`decisao.naoGasto` já devem chegar com `categoria_id`/`subcategoria_id`
 * resolvidos (nome→id) por quem monta a decisão — este módulo não resolve categoria.
 *
 * @param {Object} db - objeto com aplicarImportacao({novos, naoGasto, casados})
 * @param {{novos:Array, naoGasto:Array, casados:Array}} decisao
 */
export async function aplicar(db, decisao) {
  // delega o lote inteiro pro db.aplicarImportacao, que grava tudo numa única transação HTTP
  // (1 subrequest, atômica). O loop antigo (1 db.inserirTransacao por linha) estourava o limite
  // de subrequests do Worker num extrato grande e podia gravar pela metade.
  return await db.aplicarImportacao({
    novos: decisao.novos || [],
    naoGasto: decisao.naoGasto || [],
    casados: decisao.casados || [],
  });
}
