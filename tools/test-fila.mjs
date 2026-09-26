// Testes das regras da fila autônoma (tools/fila.mjs). As decisões que
// precisam ser exatas — quem é candidato, o que o diff tocou, se pode dar
// merge sozinho — moram aqui porque o script do workflow não roda sob
// node --test. Se estas regras erram, a rodada erra com convicção.
import { test } from "node:test";
import assert from "node:assert/strict";
import { carregarFila, checar, tocaValido, classificar, tocaDeCaminhos, foraDoDeclarado, degrau2 } from "./fila.mjs";
import { lerFrontmatter, lerCorpo, itensDeLista, lerOrdem, itemDeMarkdown, montarFila, serializar } from "./fila-md.mjs";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base = (extra = {}) => ({
  id: "B1", camada: 3, e: "livre", quem: "x", nome: "n", meta: "m", desc: "d",
  exige: [], destrava: [], ...extra,
});
const pronto = (extra = {}) => ({
  por: "Caio", em: "2026-09-24", aceite: ["a coluna aparece"], fora: [],
  toca: ["app"], auto_merge: false, ...extra,
});

test("carregarFila lê o array ITENS de um script clássico", () => {
  const itens = carregarFila('// comentário\nconst ITENS = [{id:"A", e:"feito"}];');
  assert.equal(itens.length, 1);
  assert.equal(itens[0].id, "A");
});

test("carregarFila com erro de sintaxe explica em português", () => {
  assert.throws(() => carregarFila('const ITENS = [{id:"A" e:"feito"}];'),
    /não consegui ler feitos\.js/);
});

test("carregarFila sem ITENS avisa", () => {
  assert.throws(() => carregarFila("const OUTRA = [];"), /ITENS/);
});

test("fila bem formada não tem erro", () => {
  assert.deepEqual(checar([base(), base({ id: "B2", exige: ["B1"], pronto: pronto() })]), []);
});

test("id repetido é erro", () => {
  assert.match(checar([base(), base()]).join("\n"), /B1: id repetido/);
});

test("exige e destrava apontando para id inexistente são erro", () => {
  const erros = checar([base({ exige: ["X9"], destrava: ["Y9"] })]).join("\n");
  assert.match(erros, /exige aponta para X9/);
  assert.match(erros, /destrava aponta para Y9/);
});

test("estado fora da lista é erro — a vitrine filtra por ele", () => {
  assert.match(checar([base({ e: "pronto" })]).join("\n"), /estado "pronto"/);
});

test("pronto incompleto é erro, campo a campo", () => {
  const erros = checar([base({ pronto: { toca: [], auto_merge: false } })]).join("\n");
  assert.match(erros, /pronto\.por/);
  assert.match(erros, /pronto\.em/);
  assert.match(erros, /pronto\.aceite/);
});

test("aceite com frase vazia é erro", () => {
  assert.match(checar([base({ pronto: pronto({ aceite: ["ok", "  "] }) })]).join("\n"), /pronto\.aceite/);
});

test("toca fora do vocabulário é erro", () => {
  assert.match(checar([base({ pronto: pronto({ toca: ["banco"] }) })]).join("\n"), /toca "banco"/);
});

test("auto_merge tem que ser booleano explícito", () => {
  assert.match(checar([base({ pronto: pronto({ auto_merge: "sim" }) })]).join("\n"), /auto_merge/);
});

test("vocabulário de toca: só as quatro áreas do repositório", () => {
  for (const t of ["migracao", "worker", "app", "tools"]) assert.ok(tocaValido(t), t);
  for (const t of ["tela:/app", "tela:*", "costing", "banco", "Migracao", "api", ""]) assert.ok(!tocaValido(t), t);
});
test("candidatos: só não-feito, com pronto, na ordem do array", () => {
  const itens = [
    base({ id: "A", e: "feito" }),
    base({ id: "C", pronto: pronto() }),
    base({ id: "B" }),                                // sem pronto: nem aparece
    base({ id: "D", pronto: pronto({ toca: ["api"] }) }),
  ];
  const r = classificar(itens, { prs: [], locais: [] });
  assert.deepEqual(r.prontos.map((p) => p.id), ["C", "D"]);
  assert.deepEqual(r.prontos[1].toca, ["api"]);
  assert.deepEqual(r.bloqueados, []);
});

test("candidatos: exige não feito bloqueia, dizendo o quê", () => {
  const itens = [base({ id: "A" }), base({ id: "B", exige: ["A"], pronto: pronto() })];
  const r = classificar(itens, { prs: [], locais: [] });
  assert.deepEqual(r.prontos, []);
  assert.deepEqual(r.bloqueados, [{ id: "B", motivo: "espera A" }]);
});

test("candidatos: PR aberta fila/<id> tira da lista e vai para em_pr", () => {
  const r = classificar([base({ id: "B", pronto: pronto() })], { prs: ["fila/B", "outra"], locais: ["fila/B"] });
  assert.deepEqual(r.prontos, []);
  assert.deepEqual(r.em_pr, ["B"]);
});

test("candidatos: branch local de rodada anterior sem PR bloqueia", () => {
  const r = classificar([base({ id: "B", pronto: pronto() })], { prs: [], locais: ["fila/B"] });
  assert.deepEqual(r.bloqueados, [{ id: "B", motivo: "branch fila/B de rodada anterior ainda existe (sem PR) — olhar e apagar" }]);
});

test("candidatos: pronto em estado espera bloqueia em vez de sumir", () => {
  const r = classificar([base({ id: "B", e: "espera", pronto: pronto() })], { prs: [], locais: [] });
  assert.deepEqual(r.bloqueados, [{ id: "B", motivo: "estado espera: depende de alguém, não da fila" }]);
});
test("toca: cada caminho vai para a sua categoria", () => {
  const r = tocaDeCaminhos([
    "migrations/0010_x.sql", "schema.sql",
    "worker/index.js", "worker/db.js", "worker/telegram.js",
    "public/app.js", "public/index.html", "public/shell.css",
    "tools/import_planilha.py", "tools/categorias.py",
  ]);
  assert.deepEqual(r.derivado, ["app", "migracao", "tools", "worker"]);
  assert.deepEqual(r.nao_classificados, []);
});

test("toca: a infra da fila não é neutra nem vocabulário — mudar a regra muda as rodadas seguintes", () => {
  const r = tocaDeCaminhos(["tools/fila.mjs", "tools/fila-md.mjs", "tools/db.py", "tools/app.mjs", "tools/hooks/pre-push"]);
  assert.deepEqual(r.derivado, []);
  assert.deepEqual(r.nao_classificados, ["tools/app.mjs", "tools/db.py", "tools/fila-md.mjs", "tools/fila.mjs", "tools/hooks/pre-push"]);
});

test("toca: neutros não contam — toda entrega mexe neles", () => {
  const r = tocaDeCaminhos([
    "docs/superpowers/specs/x.md", "docs/superpowers/plans/y.md", "BACKLOG.md", "CONTEXTO.md", "README.md",
    "tests/test_db.py", "tests/test_import.py", "worker/db.test.mjs", "public/app.test.mjs",
    "tools/test-fila.mjs", "tools/test-app.mjs",
  ]);
  assert.deepEqual(r, { derivado: [], nao_classificados: [] });
  // A fila em Markdown também é registro: toda entrega a move (concluir).
  assert.deepEqual(tocaDeCaminhos(["fila/feitos.js", "fila/ORDEM.md", "fila/B50.md"]), { derivado: [], nao_classificados: [] });
});

// Review Focus 3 do plano: CI, package.json e afins não devolvem o item, mas barram o degrau 2.
test("toca: código fora do vocabulário vira nao_classificado — não devolve, mas barra o degrau 2", () => {
  const r = tocaDeCaminhos([".github/workflows/ci.yml", "package.json", "wrangler.toml", "pyproject.toml", "tools/hooks/x"]);
  assert.deepEqual(r.derivado, []);
  assert.deepEqual(r.nao_classificados, [".github/workflows/ci.yml", "package.json", "pyproject.toml", "tools/hooks/x", "wrangler.toml"]);
  assert.deepEqual(foraDoDeclarado(r.derivado, ["app"]), []);
  const item = base({ pronto: pronto({ toca: ["app"], auto_merge: true }) });
  const d2 = degrau2(item, { degrau: 2, derivado: [], nao_classificados: r.nao_classificados, aprovou_de_primeira: true });
  assert.equal(d2.ok, false);
  assert.match(d2.motivos.join(" "), /não classificado/);
});

test("toca: barra do Windows é normalizada", () => {
  assert.deepEqual(tocaDeCaminhos(["public\\app.js"]).derivado, ["app"]);
});

test("fora do declarado: o que o diff tocou e o item não declarou", () => {
  assert.deepEqual(foraDoDeclarado(["app", "worker"], ["app"]), ["worker"]);
  assert.deepEqual(foraDoDeclarado(["app"], ["app", "worker"]), []);
  assert.deepEqual(foraDoDeclarado(["migracao"], ["app"]), ["migracao"]);
  assert.deepEqual(foraDoDeclarado([], []), []);
});

const itemAuto = base({ pronto: pronto({ toca: ["app"], auto_merge: true }) });
const d2ok = { degrau: 2, derivado: ["app"], nao_classificados: [], aprovou_de_primeira: true };

test("degrau 2: tudo certo, pode", () => {
  assert.deepEqual(degrau2(itemAuto, d2ok), { ok: true, motivos: [] });
});

test("degrau 2: worker e app não barram — o Caio é o único usuário e a entrega deploya e confere", () => {
  assert.deepEqual(degrau2(itemAuto, { ...d2ok, derivado: ["app", "worker"] }), { ok: true, motivos: [] });
  const itemWorker = base({ pronto: pronto({ toca: ["worker", "tools"], auto_merge: true }) });
  assert.deepEqual(degrau2(itemWorker, { ...d2ok, derivado: ["tools", "worker"] }), { ok: true, motivos: [] });
});

test("degrau 2: cada condição derruba sozinha", () => {
  const casos = [
    [itemAuto, { ...d2ok, degrau: 1 }, /degrau 1/],
    [base({ pronto: pronto({ toca: ["app"], auto_merge: false }) }), d2ok, /auto_merge/],
    [base({ pronto: pronto({ toca: ["migracao"], auto_merge: true }) }), d2ok, /migracao/],
    [itemAuto, { ...d2ok, derivado: ["migracao"] }, /migracao/],
    [itemAuto, { ...d2ok, nao_classificados: ["package.json"] }, /não classificado/],
    [itemAuto, { ...d2ok, aprovou_de_primeira: false }, /de primeira/],
  ];
  for (const [item, ctx, esperado] of casos) {
    const r = degrau2(item, ctx);
    assert.equal(r.ok, false, String(esperado));
    assert.match(r.motivos.join(" "), esperado);
  }
});
const rodar = (args, stdin = "") =>
  spawnSync(process.execPath, ["tools/fila.mjs", ...args], { input: stdin, encoding: "utf8" });

test("CLI degrau2: id inexistente sai 1", () => {
  const r = rodar(["degrau2", "NAO-EXISTE"], JSON.stringify(d2ok));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NAO-EXISTE/);
});

// Achados da revisão final (24/09): os erros de edição à mão mais comuns não
// podem virar stack trace, e mexer nas regras dos agentes não é "neutro".
test("checar: buraco no array (vírgula dobrada) é erro, não TypeError", () => {
  // eslint-disable-next-line no-sparse-arrays
  assert.match(checar([base(), , base({ id: "B2" })]).join("\n"), /posição 1/);
});

test("checar: pronto null é erro, não TypeError", () => {
  assert.match(checar([base({ pronto: null })]).join("\n"), /pronto tem que ser objeto/);
});

test("checar: exige como texto é erro — iteraria letra por letra", () => {
  assert.match(checar([base({ exige: "B1" })]).join("\n"), /exige tem que ser lista/);
});

test("toca: prompts dos agentes e CLAUDE.md não são neutros", () => {
  const r = tocaDeCaminhos([".claude/agents/reviewer-financas.md", ".claude/workflows/fila.js", ".claude/settings.json", "CLAUDE.md", "CONTEXTO.md"]);
  assert.deepEqual(r.derivado, []);
  assert.deepEqual(r.nao_classificados, [".claude/agents/reviewer-financas.md", ".claude/settings.json", ".claude/workflows/fila.js", "CLAUDE.md"]);
});

// ---------------------------------------------------------------- fila em Markdown
// O Caio escreve estes arquivos à mão (VS Code ou Obsidian, no Windows). O que
// ele digita naturalmente — CRLF, caixa marcada, resposta embaixo da pergunta —
// tem que ser lido, não virar item sumido.

test("frontmatter: listas, booleano, comentário e dois-pontos no valor", () => {
  const r = lerFrontmatter("---\nid: B50\nestado: livre   # livre | espera\nexige: [P1, P2]\ntoca: [tela:/analytics, api]\nauto_merge: false\nmeta: decidida 24/09: margem\n---\n# N\n");
  assert.deepEqual(r.campos, { id: "B50", estado: "livre", exige: ["P1", "P2"],
    toca: ["tela:/analytics", "api"], auto_merge: false, meta: "decidida 24/09: margem" });
  assert.equal(r.resto, "# N\n");
});

test("frontmatter: lista vazia e ausência de frontmatter", () => {
  assert.deepEqual(lerFrontmatter("---\nexige: []\n---\n").campos.exige, []);
  assert.equal(lerFrontmatter("# sem frontmatter\n"), null);
});

test("frontmatter e corpo com CRLF são lidos igual — core.autocrlf=true", () => {
  const r = lerFrontmatter("---\r\nid: B1\r\n---\r\n# Nome\r\n\r\n## Problema\r\ndói\r\n");
  assert.equal(r.campos.id, "B1");
  const c = lerCorpo(r.resto);
  assert.equal(c.nome, "Nome");
  assert.deepEqual(c.secoes.map((s) => s.titulo), ["Problema"]);
});

test("corpo: título, citação antes das seções é ignorada, seções em ordem", () => {
  const c = lerCorpo("# Nome do item\n\n> Dossiê: IDEIAS.md\n\n## Problema\nlinha 1\n## Valor\nlinha 2\n");
  assert.equal(c.nome, "Nome do item");
  assert.deepEqual(c.secoes.map((s) => s.titulo), ["Problema", "Valor"]);
  assert.ok(c.secoes[0].linhas.includes("linha 1"));
});

test("lista: caixa marcada ou não conta; marcador entre parênteses não", () => {
  assert.deepEqual(itensDeLista(["- [ ] a", "- [x] b", "- [X] c", "- d", "- (a definir)", "- (nenhuma)"]),
    ["a", "b", "c", "d"]);
});

test("lista: resposta recuada embaixo da pergunta não é pergunta nova", () => {
  assert.deepEqual(itensDeLista(["- pergunta do PM", "  - resposta do Caio", "texto solto do Caio", ""]),
    ["pergunta do PM"]);
});

test("ORDEM: três faixas, ordem preservada, comentário ignorado", () => {
  const r = lerOrdem("# Ordem\nprovisória\n\n## Agora\n- B50\n- B49\n\n## Próximo\n- B26\n\n## Depois\n- D3\n");
  assert.deepEqual(r.faixas, { Agora: ["B50", "B49"], "Próximo": ["B26"], Depois: ["D3"] });
  assert.deepEqual(r.erros, []);
});

test("ORDEM: faixa sem acento é erro que diz quais valem", () => {
  const r = lerOrdem("## Proximo\n- B26\n");
  assert.match(r.erros.join("\n"), /faixa "Proximo".*Agora\/Próximo\/Depois/);
  assert.match(r.erros.join("\n"), /B26 fora de uma faixa/);
});

const md = ({ id = "B1", estado = "livre", extra = "", dod = "- [ ] a coluna aparece", perguntas = "", decisoes = "- (nenhuma registrada)" } = {}) =>
  `---\nid: ${id}\nestado: ${estado}\nexige: []\ntoca: [app]\nauto_merge: false\n${extra}---\n# Nome ${id}\n\n` +
  `## Problema\ndói\n\n## Valor\nvale\n\n## Pronto quando (DoD)\n${dod}\n\n## Exemplo\n5 dá A\n\n## Fora\n- não mexer no P&L\n\n` +
  `## Decisões\n${decisoes}\n\n## Perguntas em aberto\n${perguntas}\n`;
const ORDEM = (agora = ["B1"], proximo = [], depois = []) =>
  `## Agora\n${agora.map((i) => `- ${i}`).join("\n")}\n\n## Próximo\n${proximo.map((i) => `- ${i}`).join("\n")}\n\n## Depois\n${depois.map((i) => `- ${i}`).join("\n")}\n`;
const FEITO = { id: "P1", camada: 0, e: "feito", quem: "feito", nome: "p", meta: "m", desc: "d", exige: [], destrava: [] };
const PRONTO_OK = { estado: "pronto", decisoes: "- 2026-09-25 · estado: pronto · Caio (redação: assistente)" };

test("item livre em Agora vira camada 3, 'agora 1', desc = Problema + Valor", () => {
  const { item, erros } = itemDeMarkdown("B1", md(), { faixa: "Agora", pos: 1 });
  assert.deepEqual(erros, []);
  assert.equal(item.camada, 3); assert.equal(item.quem, "agora 1"); assert.equal(item.e, "livre");
  assert.equal(item.nome, "Nome B1"); assert.equal(item.desc, "dói vale"); assert.equal(item.pronto, undefined);
});

test("faixa e espera decidem camada e quem — é o que a vitrine agrupa", () => {
  const q = (texto, lugar) => { const { item } = itemDeMarkdown("B1", texto, lugar); return [item.camada, item.quem, item.e]; };
  assert.deepEqual(q(md(), { faixa: "Próximo", pos: 1 }), [3, "próximo", "livre"]);
  assert.deepEqual(q(md(), { faixa: "Depois", pos: 2 }), [4, "depois", "livre"]);
  assert.deepEqual(q(md({ estado: "espera", extra: "espera: paola\n" }), { faixa: "Agora", pos: 1 }), [1, "espera a Paola", "espera"]);
  assert.deepEqual(q(md({ estado: "espera" }), { faixa: "Depois", pos: 1 }), [2, "espera o Caio", "espera"]);
});

test("pronto completo vira o bloco que a rodada consome, com o Exemplo junto", () => {
  const { item, erros } = itemDeMarkdown("B1", md(PRONTO_OK), { faixa: "Agora", pos: 1 });
  assert.deepEqual(erros, []);
  assert.deepEqual(item.pronto, { por: "Caio (redação: assistente)", em: "2026-09-25",
    aceite: ["a coluna aparece"], fora: ["não mexer no P&L"], toca: ["app"], auto_merge: false, exemplo: "5 dá A" });
});

test("pronto fora de Agora, com pergunta, sem DoD ou sem a linha em Decisões é erro, cada um", () => {
  const e = (opts, lugar = { faixa: "Agora", pos: 1 }) => itemDeMarkdown("B1", md({ ...PRONTO_OK, ...opts }), lugar).erros.join("\n");
  assert.match(e({}, { faixa: "Próximo", pos: 1 }), /pronto fora da faixa Agora/);
  assert.match(e({ perguntas: "- e o inativo? (PM, 2026-09-25)" }), /1 pergunta\(s\) em aberto/);
  assert.match(e({ dod: "- [ ] (a definir)" }), /sem frase no "Pronto quando"/);
  assert.match(e({ decisoes: "- 2026-09-24 · base = margem · Caio" }), /estado: pronto · quem/);
});

test("pergunta respondida embaixo continua sendo UMA pergunta — o PM é quem a fecha", () => {
  const texto = md({ ...PRONTO_OK, perguntas: "- e o inativo? (PM, 2026-09-25)\n  - fora da soma (Caio)" });
  assert.match(itemDeMarkdown("B1", texto, { faixa: "Agora", pos: 1 }).erros.join("\n"), /1 pergunta\(s\)/);
});

test("arquivo torto: sem frontmatter, id trocado, estado feito, espera sem estado, seções fora de ordem", () => {
  assert.match(itemDeMarkdown("B1", "# só título\n").erros.join(), /sem frontmatter/);
  assert.match(itemDeMarkdown("B1", md({ id: "B2" })).erros.join(), /id "B2", o arquivo é B1\.md/);
  assert.match(itemDeMarkdown("B1", md({ estado: "feito" })).erros.join(), /estado "feito".*feitos\.js/);
  assert.match(itemDeMarkdown("B1", md({ extra: "espera: paola\n" })).erros.join(), /espera: só com estado: espera/);
  const trocado = md().replace("## Valor\nvale\n\n", "").replace("## Exemplo", "## Valor\nvale\n\n## Exemplo");
  assert.match(itemDeMarkdown("B1", trocado).erros.join(), /seções têm que ser, nesta ordem/);
});

test("montar: ordem de saída é a do ORDEM.md, feitos no fim, destrava derivado", () => {
  const arquivos = { "B2.md": md({ id: "B2" }).replace("exige: []", "exige: [B1]"), "B1.md": md() };
  const { itens, erros } = montarFila({ ordem: ORDEM(["B1"], ["B2"]), arquivos, feitos: [FEITO] });
  assert.deepEqual(erros, []);
  assert.deepEqual(itens.map((i) => i.id), ["B1", "B2", "P1"]);
  assert.deepEqual(itens[0].destrava, ["B2"]);
});

test("montar: item sem linha no ORDEM, linha sem item, id repetido, id aberto e feito", () => {
  const e = (ordem, arquivos, feitos = [FEITO]) => montarFila({ ordem, arquivos, feitos }).erros.join("\n");
  assert.match(e(ORDEM([]), { "B1.md": md() }), /B1: não aparece no ORDEM\.md/);
  assert.match(e(ORDEM(["B1", "B9"]), { "B1.md": md() }), /ORDEM\.md: B9 não tem arquivo/);
  assert.match(e(ORDEM(["B1"], ["B1"]), { "B1.md": md() }), /B1 aparece mais de uma vez/);
  assert.match(e(ORDEM(["P1"]), { "P1.md": md({ id: "P1" }) }), /P1: está em fila\/ e em feitos\.js/);
});

test("serializar devolve um script clássico que o carregarFila lê de volta igual", () => {
  const itens = [FEITO, { ...FEITO, id: "P2", nome: "aspas \" e ç" }];
  const texto = serializar(itens, "// gerado\n");
  assert.ok(texto.startsWith("// gerado\nconst ITENS = [\n"));
  // carregarFila avalia num contexto vm: objetos de outro realm, e o deepEqual
  // estrito compara protótipo. Pelo JSON, compara-se só o conteúdo.
  assert.deepEqual(JSON.parse(JSON.stringify(carregarFila(texto))), itens);
  assert.equal(serializar(itens, "// gerado\n"), texto);   // determinístico: o CI compara texto
});

// Uma pasta fila/ de mentira: ORDEM.md, feitos.js e os .md passados.
function pastaTemporaria({ ordem = ORDEM(["B1"]), arquivos = { "B1.md": md(PRONTO_OK) }, feitos = [FEITO] } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "fila-")), "fila");
  mkdirSync(dir);
  writeFileSync(join(dir, "ORDEM.md"), ordem);
  writeFileSync(join(dir, "feitos.js"), serializar(feitos, "// feitos\n"));
  writeFileSync(join(dir, "README.md"), "# não é item\n");
  writeFileSync(join(dir, "_modelo.md"), "# também não\n");
  for (const [n, t] of Object.entries(arquivos)) writeFileSync(join(dir, n), t);
  return dir;
}

test("CLI checar: pasta ok sai 0 e conta abertos, histórico e prontos", () => {
  const r = rodar(["checar", pastaTemporaria()]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 itens \(1 abertos, 1 no histórico\), 1 prontos/);
});

test("CLI checar: erro do Markdown sai 1 e lista, sem stack trace", () => {
  const r = rodar(["checar", pastaTemporaria({ ordem: ORDEM(["B1"]), arquivos: { "B1.md": md({ estado: "feito" }) } })]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /estado "feito"/);
  assert.doesNotMatch(r.stderr, /at .*fila(-md)?\.mjs/);
});

test("CLI checar: feitos.js quebrado sai 1 dizendo o arquivo", () => {
  const dir = pastaTemporaria();
  writeFileSync(join(dir, "feitos.js"), 'const ITENS = [{id:"A" e:"x"}];');
  const r = rodar(["checar", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /feitos\.js/);
});

test("CLI concluir: sai do Markdown e do ORDEM, entra no histórico como feito", () => {
  const dir = pastaTemporaria();
  const r = rodar(["concluir", "B1", "entregue 26/09 · resumo por pessoa", dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(dir, "B1.md")), false);
  assert.doesNotMatch(readFileSync(join(dir, "ORDEM.md"), "utf8"), /B1/);
  const feitos = carregarFila(readFileSync(join(dir, "feitos.js"), "utf8"));
  const b1 = feitos.find((i) => i.id === "B1");
  assert.deepEqual([b1.e, b1.camada, b1.quem, b1.meta], ["feito", 0, "feito", "entregue 26/09 · resumo por pessoa"]);
  assert.equal(b1.pronto, undefined);
  assert.equal(rodar(["checar", dir]).status, 0);
});

test("CLI checar sobre a fila/ real passa", () => {
  const r = rodar(["checar"]);
  assert.equal(r.status, 0, r.stderr);
});

// Review Focus 4 do plano: a fila recém-criada (faixas vazias, histórico vazio) é válida.
test("fila recém-criada: faixas vazias e histórico vazio passam no checar e não têm candidatos", () => {
  const dir = pastaTemporaria({ ordem: "# Ordem da fila\n\n## Agora\n\n## Próximo\n\n## Depois\n", arquivos: {}, feitos: [] });
  const c = rodar(["checar", dir]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /0 itens \(0 abertos, 0 no histórico\), 0 prontos/);
  assert.deepEqual(classificar([], { prs: [], locais: [] }), { prontos: [], bloqueados: [], em_pr: [] });
});

// Achados da revisão final (25/09): o marcador "(...)" engolia frase real, a
// saída do gerar era livre, e o --ref (o único caminho que a rodada usa) não
// tinha teste.
test("pronto: pergunta que começa com parêntese continua sendo pergunta", () => {
  const texto = md({ ...PRONTO_OK, perguntas: "- (PM, 2026-09-25) o toca cobre o /ajuda? (recomendo incluir)" });
  assert.match(itemDeMarkdown("B1", texto, { faixa: "Agora", pos: 1 }).erros.join("\n"), /1 pergunta\(s\)/);
});

test("pronto: DoD com '(a definir)' ao lado de frase real é erro, não filtro", () => {
  const texto = md({ ...PRONTO_OK, dod: "- [ ] frase real\n- [ ] (a definir)" });
  assert.match(itemDeMarkdown("B1", texto, { faixa: "Agora", pos: 1 }).erros.join("\n"), /\(a definir\)/);
});

test("lista: frase entre parênteses que não é marcador não some do aceite", () => {
  assert.deepEqual(itensDeLista(["- (opcional) exportar CSV (se couber)", "- (a definir)", "- (nenhuma registrada)"]),
    ["(opcional) exportar CSV (se couber)"]);
});

test("CLI concluir só grava em fila/ (ou em pasta temporária de teste)", () => {
  const r = rodar(["concluir", "B1", "x", "tools"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /só grava/);
});

test("CLI --ref lê a fila pelo git; ref sem fila/ para a rodada", () => {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(repo, "x.txt"), "x"); git("add", "."); git("commit", "-q", "-m", "sem fila");
  const semFila = git("rev-parse", "HEAD").trim();
  mkdirSync(join(repo, "fila"));
  writeFileSync(join(repo, "fila", "ORDEM.md"), ORDEM(["B1"]));
  writeFileSync(join(repo, "fila", "feitos.js"), serializar([FEITO], "// feitos\n"));
  writeFileSync(join(repo, "fila", "B1.md"), md(PRONTO_OK));
  git("add", "."); git("commit", "-q", "-m", "com fila");
  // A árvore de trabalho muda depois do commit: o --ref não pode enxergá-la.
  writeFileSync(join(repo, "fila", "B1.md"), "lixo");
  const cli = (...a) => spawnSync(process.execPath, [join(process.cwd(), "tools/fila.mjs"), ...a], { cwd: repo, encoding: "utf8", input: "{}" });
  const ok = cli("--ref", "HEAD", "checar");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /1 prontos/);
  const c = cli("--ref", "HEAD", "candidatos");
  assert.deepEqual(JSON.parse(c.stdout).prontos.map((i) => i.id), ["B1"]);
  const sem = cli("--ref", semFila, "checar");
  assert.equal(sem.status, 1);
  assert.match(sem.stderr, /não consegui ler/);
});

// Guarda de push (tools/hooks/pre-push). O master é o que se deploya, e o
// GitHub deste plano não protege o master do lado do servidor: esta é a
// trava. O git entrega ao hook, no stdin, uma linha por ref empurrada:
// "<ref local> <sha local> <ref remota> <sha remota>".
const HOOK = "tools/hooks/pre-push";
const empurrar = (linhas) =>
  spawnSync("sh", [HOOK, "origin", "git@github.com:x/y.git"], { input: linhas, encoding: "utf8" });
const Z = "0000000000000000000000000000000000000000";

test("pre-push: branch fila/<id> passa", () => {
  const r = empurrar(`refs/heads/fila/B1 abc refs/heads/fila/B1 ${Z}\n`);
  assert.equal(r.status, 0, r.stderr);
});

// Review Focus 5 do plano: a ref de DESTINO é o que conta, seja qual for a branch local.
test("pre-push: master recusa, qualquer que seja a branch local", () => {
  for (const local of ["refs/heads/master", "refs/heads/fila/B1", "HEAD"]) {
    const r = empurrar(`${local} abc refs/heads/master def\n`);
    assert.equal(r.status, 1, local);
    assert.match(r.stderr, /master/);
  }
});

test("pre-push: uma ref para o master no meio de várias recusa tudo", () => {
  const r = empurrar(`refs/heads/fila/B1 abc refs/heads/fila/B1 ${Z}\nrefs/heads/x abc refs/heads/master def\n`);
  assert.equal(r.status, 1);
});

// O PM não monta mais o JSON das branches locais com `node -e` (a permissão
// ampla de node foi fechada): o próprio candidatos lê o git quando o stdin
// não traz "locais".
test("branchesLocais: lê a saída do git branch --list, uma por linha", async () => {
  const { branchesLocais } = await import("./fila.mjs");
  assert.deepEqual(branchesLocais("fila/B1\r\nfila/B2\n\n"), ["fila/B1", "fila/B2"]);
  assert.deepEqual(branchesLocais(""), []);
});
