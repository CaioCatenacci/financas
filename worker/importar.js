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
  const checksum = conferirChecksum(linhas, saldos);

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
  const checksum = totalCents
    ? { ok: soma === totalCents, diferencaCents: totalCents - soma }
    : { ok: true, diferencaCents: 0 };

  const conta = `fatura-${ano}${mes}`;
  const hashesSet = new Set(hashes);

  const itens = [];
  const resumo = resumoVazio();

  itensBrutos.forEach((item, i) => {
    // ordinal = índice do item na fatura (não há "várias por dia" a distinguir como no
    // extrato — o índice já é estável e único dentro da fatura).
    const lh = linhaHash(conta, item.data, item.descricao, item.valorCents, i);

    if (hashesSet.has(lh)) {
      itens.push({
        ...item, linhaHash: lh, status: "jaTem", matchId: null, computaResumo: null,
        categoriaNome: null, subNome: null, categoriaOrg: null, contraparteNome: null,
        natureza: "despesa", descricaoFinal: item.descricao,
      });
      resumo.jaTem++;
      return;
    }

    const info = classificar(item.descricao, associacoes);
    // remove "PARCELA XX/YY" do texto do estabelecimento (já temos `item.parcela` separado) e
    // reanexa como sufixo "(parc XX/YY)" — mesma limpeza do tools/importar_fatura.py.
    const descLimpo = item.descricao.replace(/\bPARCELA\s+\d{2}\/\d{2}\b/i, "").trim();
    const descricaoFinal = descLimpo + (item.parcela ? ` (parc ${item.parcela})` : "");

    const status = info.computaResumo ? "novo" : "naoGasto";

    itens.push({
      ...item, linhaHash: lh, status, matchId: null,
      computaResumo: info.computaResumo,
      categoriaNome: info.categoriaNome, subNome: info.subNome, categoriaOrg: info.categoriaOrg,
      contraparteNome: info.contraparteNome, natureza: "despesa", descricaoFinal,
    });

    if (status === "novo") resumo.novos++;
    else resumo.naoGasto++;
  });

  return { checksum, itens, resumo };
}

/**
 * Aplica a decisão já revisada (pelo usuário, no app) no banco: novos + não-gasto viram
 * `db.inserirTransacao`; casados só carimbam a linha_hash na transação existente (não duplicam).
 * `db` é injetado — é o único efeito colateral deste módulo, e só existe aqui porque é o
 * propósito da função.
 *
 * `decisao.novos`/`decisao.naoGasto` já devem chegar com `categoria_id`/`subcategoria_id`
 * resolvidos (nome→id) por quem monta a decisão — este módulo não resolve categoria.
 *
 * ATENÇÃO (Task 7): `db.carimbarLinhaHash(id, hash)` ainda NÃO existe em worker/db.js — precisa
 * ser adicionado (equivalente ao `update transacoes set linha_hash=%s where id=%s and
 * linha_hash is null` do tools/importar_extrato.py) para este fluxo funcionar de ponta a ponta.
 *
 * @param {Object} db - objeto com inserirTransacao(t) e carimbarLinhaHash(id, hash)
 * @param {{novos:Array, naoGasto:Array, casados:Array}} decisao
 */
export async function aplicar(db, decisao) {
  const novos = decisao.novos || [];
  const naoGasto = decisao.naoGasto || [];
  const casados = decisao.casados || [];

  for (const item of [...novos, ...naoGasto]) {
    await db.inserirTransacao(item);
  }
  for (const item of casados) {
    await db.carimbarLinhaHash(item.matchId, item.linhaHash);
  }

  return { gravados: novos.length + naoGasto.length, conciliados: casados.length, naoGasto: naoGasto.length };
}
