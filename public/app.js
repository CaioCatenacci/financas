export function centavosBR(numericStr) {
  const cents = Math.round(parseFloat(numericStr) * 100);
  const reais = Math.floor(Math.abs(cents) / 100).toLocaleString("pt-BR");
  const dec = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${reais},${dec}`;
}

export function agruparMensal(rows) {
  const mapa = new Map();
  for (const r of rows) {
    if (!mapa.has(r.mes)) mapa.set(r.mes, { mes: r.mes, receita: 0, despesa: 0, saldo: 0 });
    const o = mapa.get(r.mes);
    const v = parseFloat(r.total);
    if (r.natureza === "receita") o.receita += v; else o.despesa += v;
    o.saldo = o.receita - o.despesa;
  }
  return [...mapa.values()].sort((a, b) => a.mes.localeCompare(b.mes));
}

// ---- helpers de rede (não testados) ----
export const apiGet = (p) => fetch(p).then((r) => r.json());
export const apiPatch = (p, body) => fetch(p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const apiDelete = (p) => fetch(p, { method: "DELETE" });
