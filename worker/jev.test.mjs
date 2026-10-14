// H4 — perguntas do JEV portadas de tools/jev_classificar.py. Os casos espelham os de
// tests/test_jev_classificar.py (mesmos catálogos inventados): se as perguntas divergirem entre o
// Worker e a ferramenta, o limiar de 0,90 medido no H2 deixa de valer para o import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as jev from "./jev.js";
import { NENHUMA, SEM_SUB } from "./jev.js";

const CATALOGO = {
  categorias: [
    { id: "cA", nome: "Alimentação", natureza: "despesa", padrao: false, ativa: true },
    { id: "cT", nome: "Transporte", natureza: "despesa", padrao: false, ativa: true },
    { id: "cO", nome: "Outros", natureza: "despesa", padrao: false, ativa: true },
    { id: "cV", nome: "Velha", natureza: "despesa", padrao: false, ativa: false },
    { id: "cN", nome: "Não Identificado", natureza: "despesa", padrao: true, ativa: true },
    { id: "cR", nome: "Renda", natureza: "receita", padrao: false, ativa: true },
  ],
  subcategorias: [
    { id: "sP", categoria_id: "cA", nome: "Padaria", ativa: true },
    { id: "sM", categoria_id: "cA", nome: "Mercado", ativa: true },
    { id: "sX", categoria_id: "cA", nome: "Extinta", ativa: false },
    { id: "sC", categoria_id: "cT", nome: "Combustível", ativa: true },
    { id: "sS", categoria_id: "cR", nome: "Salário", ativa: true },
  ],
};

// Catálogo com os nomes que as descrições à mão usam (Banco, Alimentação → Restaurante/Outros/Ifood,
// Compras → Compras) e uma categoria com as duas genéricas.
const CATALOGO_H2 = {
  categorias: [
    { id: "kB", nome: "Banco", natureza: "despesa", padrao: false, ativa: true },
    { id: "kA", nome: "Alimentação", natureza: "despesa", padrao: false, ativa: true },
    { id: "kC", nome: "Compras", natureza: "despesa", padrao: false, ativa: true },
    { id: "kL", nome: "Lazer", natureza: "despesa", padrao: false, ativa: true },
    { id: "kS", nome: "Saúde", natureza: "despesa", padrao: false, ativa: true },
    { id: "kN", nome: "Não Identificado", natureza: "despesa", padrao: true, ativa: true },
  ],
  subcategorias: [
    { id: "b1", categoria_id: "kB", nome: "Fatura de cartão", ativa: true },
    { id: "b2", categoria_id: "kB", nome: "Outros", ativa: true },
    { id: "a1", categoria_id: "kA", nome: "Ifood", ativa: true },
    { id: "a2", categoria_id: "kA", nome: "Mercado", ativa: true },
    { id: "a3", categoria_id: "kA", nome: "Outros", ativa: true },
    { id: "a4", categoria_id: "kA", nome: "Restaurante", ativa: true },
    { id: "c1", categoria_id: "kC", nome: "Amazon", ativa: true },
    { id: "c2", categoria_id: "kC", nome: "Compras", ativa: true },
    { id: "c3", categoria_id: "kC", nome: "Outros", ativa: false }, // mesclada
    { id: "l1", categoria_id: "kL", nome: "Cinema", ativa: true },
    { id: "l2", categoria_id: "kL", nome: "Outros", ativa: true },
    { id: "l3", categoria_id: "kL", nome: "Lazer", ativa: true },
    { id: "s1", categoria_id: "kS", nome: "Farmácia", ativa: true },
    { id: "s2", categoria_id: "kS", nome: "Consulta", ativa: true },
  ],
};

const tx = (kw = {}) => ({ descricao: "PADARIA X", contraparte: null, valorCents: 3000,
  natureza: "despesa", fonte: "fatura", ...kw });

// Responde por id de pergunta (no formato HTTP da TypeSafe) e guarda os corpos recebidos.
function perguntadorFalso(respostas) {
  const chamadas = [];
  const perguntar = async (corpo) => {
    chamadas.push(corpo);
    const [id] = Object.keys(corpo.questions);
    const [choice, prob] = respostas[id];
    return { answers: { [id]: { choice, probabilities: { [choice]: prob } } } };
  };
  return { perguntar, chamadas, perguntas: (id) => chamadas.filter((c) => id in c.questions).map((c) => c.questions[id]) };
}

const opcoes = (t) => Object.keys(jev.perguntaCategoria(t, CATALOGO).criteria);
const cat = (nome) => CATALOGO_H2.categorias.find((c) => c.nome === nome);
const critSub = (nome) => jev.perguntaSubcategoria(cat(nome), CATALOGO_H2).criteria;

test("módulo puro: não usa rede nem banco (o fetch entra por parâmetro, em sugestoes.js)", () => {
  const fonte = readFileSync(new URL("./jev.js", import.meta.url), "utf8");
  assert.doesNotMatch(fonte, /\bfetch\b/);
  assert.doesNotMatch(fonte, /\bdb\b|neon|db\.js/);
  assert.doesNotMatch(fonte, /^import /m);
});

// --- pergunta de categoria (paridade com o Python) --------------------------

test("despesa escolhe entre as ativas de despesa", () => {
  assert.deepEqual(opcoes(tx()), ["Alimentação", "Transporte", "Outros", NENHUMA]);
});

test("receita de extrato e fatura recebe todas, porque estorno fica sob despesa", () => {
  for (const fonte of ["extrato", "fatura"]) {
    assert.deepEqual(opcoes(tx({ natureza: "receita", fonte })),
      ["Alimentação", "Transporte", "Outros", "Renda", NENHUMA]);
    assert.match(jev.perguntaCategoria(tx({ natureza: "receita", fonte }), CATALOGO).instructions, /estorno/);
  }
});

test("receita de outra fonte só vê as de receita", () => {
  for (const fonte of ["imagem", "manual", "importacao"]) {
    assert.deepEqual(opcoes(tx({ natureza: "receita", fonte })), ["Renda", NENHUMA]);
  }
});

test("a padrão nunca entra e 'nenhuma serve' sempre entra, por último", () => {
  // "nenhuma serve" faz o papel da padrão; mantê-la deixaria o resultado circular
  for (const natureza of ["despesa", "receita"]) {
    for (const fonte of jev.FONTES) {
      const ops = opcoes(tx({ natureza, fonte }));
      assert.ok(!ops.includes("Não Identificado"));
      assert.ok(!ops.includes("Velha"));
      assert.equal(ops.at(-1), NENHUMA);
    }
  }
});

test("descrição à mão de Banco sobrepõe o 'inclui:'", () => {
  // no H1, "inclui: Fatura de cartão" puxava toda compra de cartão para Banco
  const crit = jev.perguntaCategoria(tx({ descricao: "LOJA EXEMPLO LTDA" }), CATALOGO_H2).criteria;
  assert.equal(crit.Banco, "tarifas, juros, IOF, anuidade e o pagamento da fatura em si — nunca uma compra feita no cartão");
  assert.equal(crit["Saúde"], "inclui: Farmácia, Consulta");
  assert.equal(crit.Compras, "inclui: Amazon, Compras");
});

// --- pergunta de subcategoria ------------------------------------------------

test("sub só com as ativas da categoria, mais 'sem subcategoria' quando não há genérica", () => {
  assert.deepEqual(Object.keys(jev.perguntaSubcategoria(CATALOGO.categorias[0], CATALOGO).criteria),
    ["Padaria", "Mercado", SEM_SUB]);
});

test("descrição à mão de Alimentação → Restaurante e → Outros", () => {
  const crit = critSub("Alimentação");
  assert.equal(crit.Restaurante, "comer ou beber no local: restaurante, bar, café");
  // a descrição à mão vale mais que o critério genérico
  assert.equal(crit.Outros, "delivery fora do iFood, padaria, sorveteria e o resto");
  assert.equal(crit.Ifood, null);
  assert.equal(crit.Mercado, null);
  assert.ok(!(SEM_SUB in crit));
});

test("sub genérica substitui 'sem subcategoria' (o JEV fugia para ela)", () => {
  assert.equal(jev.CRITERIO_GENERICA, "quando nenhuma outra subcategoria se aplica");
  assert.deepEqual(critSub("Compras"), { Amazon: null, Compras: jev.CRITERIO_GENERICA });
  assert.deepEqual(critSub("Banco"), { "Fatura de cartão": null, Outros: jev.CRITERIO_GENERICA });
});

test("com duas candidatas a genérica, a de mesmo nome da categoria vence", () => {
  const crit = critSub("Lazer");
  assert.equal(crit.Lazer, jev.CRITERIO_GENERICA);
  assert.equal(crit.Outros, null);
  assert.ok(!(SEM_SUB in crit));
  assert.equal(jev.subGenerica(cat("Lazer"), CATALOGO_H2), "Lazer");
});

test("categoria sem genérica segue com 'sem subcategoria'", () => {
  assert.deepEqual(Object.keys(critSub("Saúde")), ["Farmácia", "Consulta", SEM_SUB]);
  assert.equal(jev.subGenerica(cat("Saúde"), CATALOGO_H2), null);
});

test("categoria sem sub ativa não ganha pergunta de sub", () => {
  const outros = CATALOGO.categorias.find((c) => c.nome === "Outros");
  assert.equal(jev.perguntaSubcategoria(outros, CATALOGO), null);
});

// --- estado ------------------------------------------------------------------

test("estado tem descrição, contraparte, valor em texto vindo de centavos, natureza e fonte explicada", () => {
  assert.deepEqual(jev.estado(tx({ contraparte: "FULANO TESTE", valorCents: 123456 })), {
    descricao: "PADARIA X", contraparte: "FULANO TESTE", valor: "1.234,56", natureza: "despesa",
    fonte: "compra feita no cartão de crédito (linha da fatura)",
  });
});

test("valor formata só com inteiros, inclusive milhões e centavos com zero à esquerda", () => {
  assert.equal(jev.formatarValor(5), "0,05");
  assert.equal(jev.formatarValor(123456789), "1.234.567,89");
  assert.equal(jev.formatarValor(-100), "-1,00");
});

test("estado explica a fonte em vez de só nomeá-la, e aceita contraparte nula", () => {
  // H2: "fonte: fatura" sozinho puxava compra de cartão para "Banco → Fatura de cartão"
  assert.match(jev.estado(tx({ fonte: "extrato" })).fonte, /movimento da conta corrente/);
  const textos = jev.FONTES.map((f) => jev.estado(tx({ fonte: f })).fonte);
  assert.equal(new Set(textos).size, jev.FONTES.length);
  jev.FONTES.forEach((f, i) => assert.notEqual(textos[i], f));
  assert.equal(jev.estado(tx()).contraparte, null);
});

test("fonte fora do vocabulário é recusada", () => {
  assert.throws(() => jev.estado(tx({ fonte: "pix" })));
});

// --- classificar -------------------------------------------------------------

test("IFD* vai para Alimentação/Ifood pela regra, com prob 1 e sem chamada", async () => {
  const f = perguntadorFalso({});
  const r = await jev.classificarLinha(tx({ descricao: "IFD*LANCHONETE EXEMPLO" }), CATALOGO_H2, f.perguntar);
  assert.equal(f.chamadas.length, 0);
  assert.deepEqual([r.categoria, r.subcategoria, r.prob_categoria, r.prob_subcategoria], ["Alimentação", "Ifood", 1, 1]);
  assert.ok(jev.preenche(r));
});

test("corpo da chamada: modelo jev-latest, estado e uma pergunta por chamada", async () => {
  const f = perguntadorFalso({ categoria: ["Compras", 0.96], subcategoria: ["Compras", 0.8] });
  await jev.classificarLinha(tx({ descricao: "LOJA EXEMPLO LTDA", valorCents: 8000 }), CATALOGO_H2, f.perguntar);
  assert.equal(f.chamadas.length, 2);
  for (const c of f.chamadas) {
    assert.equal(c.model, "jev-latest");
    assert.equal(c.state.fonte, "compra feita no cartão de crédito (linha da fatura)");
    assert.equal(Object.keys(c.questions).length, 1);
  }
  const [q] = f.perguntas("subcategoria");
  assert.equal(q.criteria.Compras, jev.CRITERIO_GENERICA);
  assert.ok(!(SEM_SUB in q.criteria));
});

test("Exemplo do card: Compras 0,96 preenche; 0,46 fica na padrão e nem pergunta a sub", async () => {
  const alta = perguntadorFalso({ categoria: ["Compras", 0.96], subcategoria: ["Compras", 0.9] });
  const r1 = await jev.classificarLinha(tx({ descricao: "LOJA EXEMPLO LTDA" }), CATALOGO_H2, alta.perguntar);
  assert.deepEqual(r1, { categoria: "Compras", subcategoria: "Compras", prob_categoria: 0.96, prob_subcategoria: 0.9, origem: "jev" });
  assert.ok(jev.preenche(r1));

  // abaixo do limiar a sub não seria usada: a pergunta não é feita (um subrequest a menos)
  const baixa = perguntadorFalso({ categoria: ["Compras", 0.46] });
  const r2 = await jev.classificarLinha(tx({ descricao: "FULANO DE TAL" }), CATALOGO_H2, baixa.perguntar);
  assert.equal(baixa.chamadas.length, 1);
  assert.equal(r2.prob_categoria, 0.46);
  assert.equal(jev.preenche(r2), false);
});

test("limiar corta certo: 0,90 entra, 0,89 não", () => {
  assert.equal(jev.LIMIAR_JEV, 0.9);
  assert.equal(jev.preenche({ categoria: "Compras", prob_categoria: 0.9 }), true);
  assert.equal(jev.preenche({ categoria: "Compras", prob_categoria: 0.89 }), false);
  assert.equal(jev.preenche(null), false);
});

test("'nenhuma serve' encerra sem perguntar a sub e não preenche nem com confiança alta", async () => {
  const f = perguntadorFalso({ categoria: [NENHUMA, 0.99] });
  const r = await jev.classificarLinha(tx(), CATALOGO, f.perguntar);
  assert.equal(f.chamadas.length, 1);
  assert.equal(r.categoria, NENHUMA);
  assert.equal(jev.preenche(r), false);
});

test("'sem subcategoria' vira sub nula com probabilidade", async () => {
  const f = perguntadorFalso({ categoria: ["Saúde", 0.95], subcategoria: [SEM_SUB, 0.55] });
  const r = await jev.classificarLinha(tx(), CATALOGO_H2, f.perguntar);
  assert.equal(r.subcategoria, null);
  assert.equal(r.prob_subcategoria, 0.55);
});

// --- interpretação da resposta ----------------------------------------------

test("lerResposta lê answers.<id>.choice e a probabilidade da escolha", () => {
  const q = { criteria: { Compras: null, Banco: null } };
  assert.deepEqual(jev.lerResposta({ answers: { categoria: { choice: "Compras", probabilities: { Compras: 0.97, Banco: 0.03 } } } }, "categoria", q),
    { choice: "Compras", prob: 0.97 });
});

test("resposta sem answers, com escolha fora das opções ou prob inválida é nula (nunca um nome inventado)", () => {
  const q = { criteria: { Compras: null } };
  assert.equal(jev.lerResposta({}, "categoria", q), null);
  assert.equal(jev.lerResposta(null, "categoria", q), null);
  assert.equal(jev.lerResposta({ answers: { categoria: { choice: "Inventada", probabilities: { Inventada: 1 } } } }, "categoria", q), null);
  assert.equal(jev.lerResposta({ answers: { categoria: { choice: "Compras", probabilities: {} } } }, "categoria", q), null);
  assert.equal(jev.lerResposta({ answers: { categoria: { choice: "Compras", probabilities: { Compras: 1.5 } } } }, "categoria", q), null);
});

test("resposta inválida faz classificarLinha lançar (quem chama deixa a linha sem sugestão)", async () => {
  await assert.rejects(jev.classificarLinha(tx(), CATALOGO, async () => ({ answers: {} })));
});
