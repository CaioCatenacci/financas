// tools/deploy.mjs — o único deploy que os papéis da fila podem rodar.
//
// Sempre de uma worktree limpa do origin/master: nunca do checkout principal (que
// pode ter trabalho do Caio no meio) nem da worktree do item (código que o
// reviewer não aprovou). O settings.json libera `node tools/deploy.mjs` e não
// libera `npx wrangler deploy` solto — é isso que impede um coder de publicar o
// que ainda não passou pela revisão.
//
// Uso: node tools/deploy.mjs   → imprime {ok, passo, saida} (a saída do wrangler).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const PASTA = ".claude/worktrees/deploy";

export function comandos(pasta = PASTA) {
  return [
    { cmd: "git", args: ["fetch", "origin"] },
    { cmd: "git", args: ["worktree", "remove", "--force", pasta], opcional: true },
    { cmd: "git", args: ["worktree", "add", "--detach", pasta, "origin/master"] },
    { cmd: "npx", args: ["wrangler", "deploy", "-c", `${pasta}/wrangler.toml`] },
    { cmd: "git", args: ["worktree", "remove", "--force", pasta] },
  ];
}

// Roda os passos em ordem; um passo obrigatório que falha para tudo e diz qual.
// O `rodar` entra por parâmetro para o teste não precisar de git nem de rede.
export function executar(passos, rodar) {
  let saida = "";
  for (const p of passos) {
    const r = rodar(p);
    if (p.cmd === "npx") saida = r.saida;
    if (r.status !== 0 && !p.opcional) return { ok: false, passo: `${p.cmd} ${p.args[0]}`, saida: r.saida };
  }
  return { ok: true, passo: "", saida };
}

function rodarDeVerdade({ cmd, args }) {
  // npx no Windows é npx.cmd: precisa do shell. Os argumentos são fixos (nada vem do usuário).
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
  return { status: r.status ?? 1, saida: `${r.stdout || ""}${r.stderr || ""}`.trim().slice(-2000) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = executar(comandos(), rodarDeVerdade);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
