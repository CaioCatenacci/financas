// tools/deploy.mjs é o único caminho de deploy que os agentes podem rodar: sempre
// de uma worktree limpa do origin/master, nunca do checkout principal (que pode ter
// trabalho do Caio) nem da worktree do item (código que o reviewer não aprovou).
import { test } from "node:test";
import assert from "node:assert/strict";
import { comandos, executar, PASTA } from "./deploy.mjs";

test("comandos: fetch, worktree limpa do origin/master, wrangler com o -c da worktree, remoção", () => {
  const c = comandos();
  assert.deepEqual(c.map((x) => x.cmd), ["git", "git", "git", "npx", "git"]);
  assert.deepEqual(c[2].args, ["worktree", "add", "--detach", PASTA, "origin/master"]);
  assert.deepEqual(c[3].args, ["wrangler", "deploy", "-c", `${PASTA}/wrangler.toml`]);
  assert.equal(c[1].opcional, true);   // remover uma worktree que não existe não é erro
  assert.equal(c[4].opcional, undefined);
});

test("executar: para no primeiro passo obrigatório que falha e diz qual", () => {
  const vistos = [];
  const falhaNoDeploy = ({ cmd, args }) => { vistos.push(cmd); return { status: cmd === "npx" ? 1 : 0, saida: `${cmd} ${args[0]}` }; };
  const r = executar(comandos(), falhaNoDeploy);
  assert.equal(r.ok, false);
  assert.equal(r.passo, "npx wrangler");
  assert.deepEqual(vistos, ["git", "git", "git", "npx"]);
});

test("executar: passo opcional falhando não para; tudo certo devolve a saída do wrangler", () => {
  // A primeira remoção falha (a worktree ainda não existe); a última, depois do deploy, dá certo.
  let remocoes = 0;
  const r = executar(comandos(), ({ cmd, args }) => {
    const remove = args[0] === "worktree" && args[1] === "remove";
    if (remove) remocoes++;
    return { status: remove && remocoes === 1 ? 1 : 0, saida: cmd === "npx" ? "Deployed financas" : "" };
  });
  assert.equal(r.ok, true);
  assert.match(r.saida, /Deployed/);
});
