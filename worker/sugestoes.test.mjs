// H4 — o lote de sugestões cabe no teto de subrequests do Worker mesmo no pior caso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sugerirLote, vaiAoJev, validarLote, ORCAMENTO_CHAMADAS } from "./sugestoes.js";

const CATALOGO = {
  categorias: [
    { id: "kC", nome: "Compras", natureza: "despesa", ativa: true },
    { id: "kN", nome: "Não Identificado", natureza: "despesa", padrao: true, ativa: true },
  ],
  subcategorias: [{ id: "c2", categoria_id: "kC", nome: "Compras", ativa: true }],
};
const linha = (i) => ({ indice: i, descricao: `LOJA EXEMPLO ${i}`, valorCents: 1000, natureza: "despesa",
  status: "novo", categoriaNome: null, categoriaOrg: null });

test("lote de 20 com 429 em todas: não passa do orçamento de chamadas e todas ficam sem sugestão", async () => {
  // sem o orçamento seriam 20 × 2 tentativas = 40 só na categoria, mais o que viesse; o Worker
  // estoura em 50 subrequests (a rota já gasta 2 no banco)
  let chamadas = 0;
  const fetchImpl = async () => { chamadas++; return new Response("{}", { status: 429 }); };
  const itens = Array.from({ length: 20 }, (_, i) => linha(i));
  const r = await sugerirLote({ fonte: "fatura", itens }, { catalogo: CATALOGO, chave: "k", fetchImpl, esperar: async () => {} });
  assert.ok(chamadas <= ORCAMENTO_CHAMADAS, `${chamadas} chamadas`);
  assert.ok(ORCAMENTO_CHAMADAS + 2 <= 50);
  assert.equal(r.itens.length, 20);
  assert.ok(r.itens.every((i) => i.sugestao === null));
  assert.equal(r.indisponivel, true);
});

test("lote de 20 que preenche tudo cabe no orçamento (2 perguntas por linha)", async () => {
  let chamadas = 0;
  const fetchImpl = async (url, init) => {
    chamadas++;
    const [id] = Object.keys(JSON.parse(init.body).questions);
    return new Response(JSON.stringify({ answers: { [id]: { choice: "Compras", probabilities: { Compras: 0.95 } } } }));
  };
  const itens = Array.from({ length: 20 }, (_, i) => linha(i));
  const r = await sugerirLote({ fonte: "fatura", itens }, { catalogo: CATALOGO, chave: "k", fetchImpl });
  assert.equal(chamadas, 40);
  assert.ok(r.itens.every((i) => i.preenche));
  assert.equal(r.indisponivel, false);
});

test("só a linha nova na padrão vai ao JEV", () => {
  assert.equal(vaiAoJev(linha(0)), true);
  assert.equal(vaiAoJev({ ...linha(0), status: "ambiguo" }), false);
  assert.equal(vaiAoJev({ ...linha(0), categoriaNome: "Compras" }), false);
  assert.equal(vaiAoJev({ ...linha(0), categoriaOrg: "Transferências" }), false);
  assert.equal(vaiAoJev({ ...linha(0), valorCents: 10.5 }), false); // centavos são inteiros
});

test("validarLote recusa lote acima de 20, sem lista e fonte fora de extrato/fatura", () => {
  assert.equal(validarLote({ fonte: "fatura", itens: Array.from({ length: 20 }, (_, i) => linha(i)) }), null);
  assert.ok(validarLote({ fonte: "fatura", itens: Array.from({ length: 21 }, (_, i) => linha(i)) }));
  assert.ok(validarLote({ fonte: "fatura" }));
  assert.ok(validarLote({ fonte: "manual", itens: [] }));
});
