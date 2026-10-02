import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linhaHash, reconciliarLinha } from "./reconciliar.js";

test("linhaHash bate byte-a-byte com o sha256 da base do Python", () => {
  const esperado = createHash("sha256").update("011638-2|2025-12-10|PIX X|19478|0").digest("hex");
  assert.equal(linhaHash("011638-2", "2025-12-10", "PIX X", 19478, 0), esperado);
});

test("linhaHash muda com o ordinal", () => {
  assert.notEqual(linhaHash("c","2025-12-10","X",100,0), linhaHash("c","2025-12-10","X",100,1));
});

test("reconciliarLinha: 1 candidato na janela ±3d → casado", () => {
  const r = reconciliarLinha({ data:"2025-12-10", valorCents:19478 },
    [{ id:"t1", data:"2025-12-11", valorCents:19478 }]);
  assert.deepEqual(r, { status:"casado", matchId:"t1", matchGrupoId: null });
});

test("reconciliarLinha: casado devolve matchGrupoId da candidata (null se ela não tem grupo)", () => {
  const linha = { data: "2026-09-30", valorCents: 250000 };
  const semGrupo = [{ id: "m1", data: "2026-09-29", valorCents: 250000, grupo_id: null }];
  assert.deepEqual(reconciliarLinha(linha, semGrupo), { status: "casado", matchId: "m1", matchGrupoId: null });
  const comGrupo = [{ id: "m1", data: "2026-09-29", valorCents: 250000, grupo_id: "G0" }];
  assert.deepEqual(reconciliarLinha(linha, comGrupo), { status: "casado", matchId: "m1", matchGrupoId: "G0" });
});

test("reconciliarLinha: >1 → ambiguo; 0/valor≠/fora da janela → novo", () => {
  assert.equal(reconciliarLinha({data:"2025-12-10",valorCents:5000},
    [{id:"a",data:"2025-12-10",valorCents:5000},{id:"b",data:"2025-12-12",valorCents:5000}]).status, "ambiguo");
  assert.equal(reconciliarLinha({data:"2025-12-10",valorCents:5000},
    [{id:"a",data:"2025-12-20",valorCents:5000},{id:"b",data:"2025-12-10",valorCents:9999}]).status, "novo");
});

test("reconciliarLinha: ambíguo devolve os candidatos que empataram (e só eles), pra escolha manual no app", () => {
  const r = reconciliarLinha({ data: "2025-12-10", valorCents: 8000 }, [
    { id: "a", data: "2025-12-09", valorCents: 8000 },
    { id: "b", data: "2025-12-11", valorCents: 8000 },
    { id: "c", data: "2025-12-10", valorCents: 8001 }, // valor diferente: não é candidato
  ]);
  assert.equal(r.status, "ambiguo");
  assert.deepEqual(r.candidatos.map(c => c.id), ["a", "b"]);
});

// ---- F1: candidatos do mesmo grupo contam como um só (dados inventados) ----
// Foto e manual da mesma padaria, agrupados: são a mesma despesa. Antes, viravam dois candidatos e a
// linha do extrato ficava ambígua sem haver o que escolher.
const fotoPadaria = { id: "foto", data: "2025-12-09", descricao: "padaria", valorCents: 8000, grupo_id: "G1", representante: true };
const manualPadaria = { id: "manual", data: "2025-12-09", descricao: "padaria manual", valorCents: 8000, grupo_id: "G1", representante: false };
const linhaPadaria = { data: "2025-12-11", valorCents: 8000 };

test("F1: dois membros do mesmo grupo na janela → casado direto no grupo (matchId = um membro)", () => {
  const r = reconciliarLinha(linhaPadaria, [manualPadaria, fotoPadaria]);
  assert.equal(r.status, "casado");
  assert.equal(r.matchGrupoId, "G1");
  assert.ok(["foto", "manual"].includes(r.matchId));
  assert.equal(r.candidatos, undefined);
});

test("F1: caso misto (grupo + solto) segue ambíguo, com o grupo uma vez só e a contagem de membros", () => {
  const solto = { id: "mercado", data: "2025-12-10", descricao: "mercado", valorCents: 8000, grupo_id: null };
  const r = reconciliarLinha(linhaPadaria, [fotoPadaria, solto, manualPadaria]);
  assert.equal(r.status, "ambiguo");
  assert.equal(r.candidatos.length, 2);
  const g = r.candidatos.find(c => c.grupo_id === "G1");
  assert.equal(g.membros, 2);
  assert.equal(g.descricao, "padaria"); // a do representante, que está entre os candidatos
  assert.deepEqual(r.candidatos.find(c => c.grupo_id === null), solto); // o solto vem como hoje
});

test("F1: sem o representante entre os candidatos, o grupo leva a descrição do membro mais antigo", () => {
  const a = { id: "a", data: "2025-12-10", descricao: "mais novo", valorCents: 8000, grupo_id: "G2", representante: false };
  const b = { id: "b", data: "2025-12-08", descricao: "mais antigo", valorCents: 8000, grupo_id: "G2", representante: false };
  const solto = { id: "s", data: "2025-12-10", descricao: "outro", valorCents: 8000, grupo_id: null };
  const r = reconciliarLinha({ data: "2025-12-10", valorCents: 8000 }, [a, b, solto]);
  const g = r.candidatos.find(c => c.grupo_id === "G2");
  assert.equal(g.descricao, "mais antigo");
  assert.equal(g.id, "b");
});

test("F1: a janela e o valor exato não mudam — membro a 4 dias ou de valor diferente não entra", () => {
  const longe = { ...manualPadaria, data: "2025-12-15" }; // 4 dias da linha
  assert.equal(reconciliarLinha(linhaPadaria, [longe]).status, "novo");
  const outroValor = { ...manualPadaria, valorCents: 8001 };
  assert.equal(reconciliarLinha(linhaPadaria, [outroValor]).status, "novo");
});
