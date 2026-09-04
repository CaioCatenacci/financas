// Porte de tools/reconciliar.py. linhaHash: sha256 hex da MESMA base do Python.
import { createHash } from "node:crypto";

export function linhaHash(conta, data, descricao, valorCents, ordinal) {
  const base = `${conta}|${data}|${descricao}|${valorCents}|${ordinal}`;
  return createHash("sha256").update(base).digest("hex");
}

function dias(a, b) {
  const da = new Date(a + "T00:00:00Z"), db = new Date(b + "T00:00:00Z");
  return Math.abs((da - db) / 86400000);
}

export function reconciliarLinha(linha, existentes) {
  const cand = existentes.filter(e => e.valorCents === linha.valorCents && dias(linha.data, e.data) <= 3);
  if (cand.length === 1) return { status: "casado", matchId: cand[0].id };
  if (cand.length > 1) return { status: "ambiguo", matchId: null };
  return { status: "novo", matchId: null };
}
