import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExtratoC6, juntarDigitosDatas, lerContasProprias, ehRepasseProprio } from "./extrato_c6.js";
import { conferirChecksum } from "./extrato.js";
import { montarPreviewExtratoC6 } from "./importar.js";
import { linhaHash } from "./reconciliar.js";

// Tudo inventado (ano fictício, nomes fictícios): o repositório é público.
// Layout do PDF que o C6 exporta, como o pdf.js entrega no modo "simples": cabeçalho de mês dá o
// ano, a data vem com os dígitos separados por espaço e há linha "Saldo do dia".
const TXT = `Extrato de conta corrente
Setembro 2031
0 1 / 0 9 0 1 / 0 9 Saldo do dia R$ 100,00
1 0 / 0 9 1 0 / 0 9 Entrada PIX Pix recebido de CAMBIO FICTICIO LTDA R$ 1.000,00
1 0 / 0 9 1 0 / 0 9 Pagamento DAS SIMPLES NACIONAL -R$ 600,00
1 1 / 0 9 1 1 / 0 9 Saída PIX Pix enviado para FULANO DE TAL -R$ 400,00
1 1 / 0 9 1 1 / 0 9 Saldo do dia R$ 100,00
Outubro 2031
Sem lançamentos no mês`;

const CONTAS = lerContasProprias("Fulano de Tal; BELTRANA INVENTADA");

test("juntarDigitosDatas: '1 0 / 1 0' vira 10/10 — o PDF do C6 separa os dígitos da data com espaço", () => {
  assert.equal(juntarDigitosDatas("1 0 / 1 0"), "10/10");
  assert.equal(juntarDigitosDatas("0 1 / 0 9 / 2 0 3 1 x"), "01/09/2031 x");
  // duas datas lado a lado continuam duas datas (não cola uma na outra)
  assert.equal(juntarDigitosDatas("1 0 / 1 0 1 1 / 1 0 Pagamento"), "10/10 11/10 Pagamento");
});

test("parseExtratoC6 lê data de lançamento, tipo, descrição e valor em centavos; a natureza vem do tipo", () => {
  const { linhas } = parseExtratoC6(TXT);
  assert.equal(linhas.length, 3);
  const [ent, pag, sai] = linhas;
  assert.deepEqual(
    { data: ent.data, tipo: ent.tipo, descricao: ent.descricao, valorCents: ent.valorCents, natureza: ent.natureza },
    { data: "2031-09-10", tipo: "Entrada PIX", descricao: "Pix recebido de CAMBIO FICTICIO LTDA", valorCents: 100000, natureza: "receita" },
  );
  assert.equal(pag.tipo, "Pagamento");
  assert.equal(pag.natureza, "despesa");
  assert.equal(pag.valorCents, 60000);
  assert.equal(sai.tipo, "Saída PIX");
  assert.equal(sai.natureza, "despesa");
  assert.equal(sai.data, "2031-09-11");
  // dois lançamentos no mesmo dia: o ordinal os distingue na linha_hash
  assert.deepEqual([ent.ordinal, pag.ordinal, sai.ordinal], [0, 1, 0]);
});

test("parseExtratoC6: 'Sem lançamentos no mês' não gera linha, e 'Saldo do dia' vira saldo, não lançamento", () => {
  const r = parseExtratoC6("Outubro 2031\nSem lançamentos no mês");
  assert.equal(r.linhas.length, 0);
  const { linhas, saldos } = parseExtratoC6(TXT);
  assert.ok(linhas.every((l) => !/saldo/i.test(l.descricao)));
  assert.deepEqual(saldos, [{ data: "2031-09-01", saldoCents: 10000 }, { data: "2031-09-11", saldoCents: 10000 }]);
});

test("parseExtratoC6: a natureza é do tipo, não do sinal (Saída sem sinal negativo segue despesa)", () => {
  const { linhas } = parseExtratoC6("Setembro 2031\n05/09 05/09 Saída PIX Pix enviado para ALGUEM R$ 10,00");
  assert.equal(linhas[0].natureza, "despesa");
});

test("checksum do C6: os 'Saldo do dia' fecham com os lançamentos", () => {
  const { linhas, saldos } = parseExtratoC6(TXT);
  assert.equal(conferirChecksum(linhas, saldos).ok, true); // 100 + 1000 − 600 − 400 = 100
});

test("preview do C6: saldo que fecha → bloqueiaAplicar false; saldo que não fecha → true", () => {
  const ok = montarPreviewExtratoC6(TXT, { contasProprias: CONTAS });
  assert.equal(ok.checksum.bloqueiaAplicar, false);
  const quebrado = TXT.replace("1 1 / 0 9 1 1 / 0 9 Saldo do dia R$ 100,00", "1 1 / 0 9 1 1 / 0 9 Saldo do dia R$ 900,00");
  const p = montarPreviewExtratoC6(quebrado, { contasProprias: CONTAS });
  assert.equal(p.checksum.ok, false);
  assert.equal(p.checksum.bloqueiaAplicar, true);
});

test("contas próprias: nomes do secret, normalizados (caixa e espaços não importam); vazio → lista vazia", () => {
  assert.deepEqual(CONTAS, ["FULANO DE TAL", "BELTRANA INVENTADA"]);
  assert.deepEqual(lerContasProprias(undefined), []);
  assert.deepEqual(lerContasProprias(" "), []);
  assert.ok(ehRepasseProprio({ natureza: "despesa", descricao: "Pix enviado para fulano  de tal" }, CONTAS));
  // entrada nunca é repasse; terceiro não é conta própria
  assert.ok(!ehRepasseProprio({ natureza: "receita", descricao: "Pix enviado para FULANO DE TAL" }, CONTAS));
  assert.ok(!ehRepasseProprio({ natureza: "despesa", descricao: "Pix enviado para OUTRA PESSOA" }, CONTAS));
});

test("regra da receita no C6 (Exemplo): entrada conta como receita, pagamento conta como despesa, repasse p/ conta própria sai do resumo", () => {
  const p = montarPreviewExtratoC6(TXT, { contasProprias: CONTAS });
  const [ent, pag, sai] = p.itens;
  assert.equal(ent.natureza, "receita");
  assert.equal(ent.computaResumo, true);
  assert.equal(pag.natureza, "despesa");
  assert.equal(pag.computaResumo, true);
  assert.equal(sai.computaResumo, false);
  assert.equal(sai.status, "naoGasto");
  assert.equal(sai.categoriaOrg, "Transferências");
  assert.deepEqual(p.avisos, []);
});

test("sem o secret CONTAS_PROPRIAS nenhuma saída vira repasse, e o preview avisa", () => {
  const p = montarPreviewExtratoC6(TXT, { contasProprias: [] });
  assert.ok(p.itens.every((i) => i.computaResumo === true));
  assert.equal(p.avisos.length, 1);
  assert.match(p.avisos[0], /CONTAS_PROPRIAS/);
});

test("preview do C6 segue o fluxo do Itaú: casado traz matchId/matchGrupoId e o hash usa a conta 'c6'", () => {
  const existentes = [{ id: "m1", data: "2031-09-09", valorCents: 60000, grupo_id: "G1" }];
  const p = montarPreviewExtratoC6(TXT, { contasProprias: CONTAS, existentes });
  const pag = p.itens.find((i) => i.tipo === "Pagamento");
  assert.equal(pag.status, "casado");
  assert.equal(pag.matchId, "m1");
  assert.equal(pag.matchGrupoId, "G1");
  // a conta 'c6' entra na base do hash (a mesma linha noutra conta teria outro hash)
  const ent = p.itens[0];
  assert.equal(ent.linhaHash, linhaHash("c6", ent.data, ent.descricao, ent.valorCents, ent.ordinal));
});

test("reimportar o mesmo texto do C6 com os hashes do 1º import dá todos os itens 'jaTem'", () => {
  const p1 = montarPreviewExtratoC6(TXT, { contasProprias: CONTAS });
  const p2 = montarPreviewExtratoC6(TXT, { contasProprias: CONTAS, hashes: p1.itens.map((i) => i.linhaHash) });
  assert.ok(p2.itens.length > 0);
  assert.ok(p2.itens.every((i) => i.status === "jaTem"));
  assert.equal(p2.resumo.jaTem, p2.itens.length);
});
