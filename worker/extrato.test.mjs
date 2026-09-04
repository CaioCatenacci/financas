import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExtrato, conferirChecksum } from "./extrato.js";

const TXT = `10/12/2025 SALDO DO DIA 38.681,68
10/12/2025 PIX QRS MAGALUPAY10/12 -194,78
10/12/2025 PIX TRANSF CAIO CA10/12 30.000,00
09/12/2025 SALDO DO DIA 8.876,46
09/12/2025 PIX TRANSF QUINTOA09/12 0,01`;

test("ignora SALDO DO DIA e parseia linhas", () => {
  const r = parseExtrato(TXT);
  assert.equal(r.linhas.length, 3);
  assert.ok(!r.linhas.some(l => l.descricao === "SALDO DO DIA"));
});

test("sinal define natureza e cents", () => {
  const r = parseExtrato(TXT);
  const saida = r.linhas.find(l => l.descricao.includes("MAGALUPAY"));
  assert.equal(saida.valorCents, 19478);
  assert.equal(saida.natureza, "despesa");
  const ent = r.linhas.find(l => l.descricao.includes("CAIO CA"));
  assert.equal(ent.valorCents, 3000000);
  assert.equal(ent.natureza, "receita");
});

test("ordinal por dia", () => {
  const d10 = parseExtrato(TXT).linhas.filter(l => l.data === "2025-12-10");
  assert.deepEqual(d10.map(l => l.ordinal), [0, 1]);
});

test("checksum bate (atribuição por intervalo)", () => {
  const r = parseExtrato(TXT);
  assert.equal(conferirChecksum(r.linhas, r.saldos).ok, true);
});

test("checksum detecta diferença", () => {
  const r = parseExtrato(TXT);
  r.linhas[0].valorCents += 100;
  assert.equal(conferirChecksum(r.linhas, r.saldos).ok, false);
});

test("checksum ignora saldo após o último lançamento (data de emissão)", () => {
  const r = parseExtrato(TXT);
  r.saldos.push({ data: "2026-09-03", saldoCents: 4538422 });
  assert.equal(conferirChecksum(r.linhas, r.saldos).ok, true);
});

test("checksum atribui por intervalo (lançamento em dia sem SALDO DO DIA)", () => {
  const linhas = [
    { data: "2025-01-02", descricao: "A", valorCents: 2000, natureza: "despesa", ordinal: 0 },
    { data: "2025-01-03", descricao: "B", valorCents: 1000, natureza: "despesa", ordinal: 0 },
  ];
  const saldos = [{ data: "2025-01-01", saldoCents: 10000 }, { data: "2025-01-03", saldoCents: 7000 }];
  assert.equal(conferirChecksum(linhas, saldos).ok, true);
});
