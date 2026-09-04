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
  assert.deepEqual(r, { status:"casado", matchId:"t1" });
});

test("reconciliarLinha: >1 → ambiguo; 0/valor≠/fora da janela → novo", () => {
  assert.equal(reconciliarLinha({data:"2025-12-10",valorCents:5000},
    [{id:"a",data:"2025-12-10",valorCents:5000},{id:"b",data:"2025-12-12",valorCents:5000}]).status, "ambiguo");
  assert.equal(reconciliarLinha({data:"2025-12-10",valorCents:5000},
    [{id:"a",data:"2025-12-20",valorCents:5000},{id:"b",data:"2025-12-10",valorCents:9999}]).status, "novo");
});
