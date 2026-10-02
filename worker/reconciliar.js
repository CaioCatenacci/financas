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

// F1: membros do mesmo grupo são a mesma despesa (foto + manual agrupados) — contam como UM
// candidato. Quem representa o grupo na lista: o representante, se ele está entre os candidatos;
// senão o membro mais antigo (data; empate fica com a ordem de chegada). Grupo com um só membro
// na janela segue como candidato comum (nada a juntar).
function juntarPorGrupo(cand) {
  const unidades = [];
  const porGrupo = new Map();
  for (const c of cand) {
    const g = c.grupo_id ?? null;
    if (g === null) { unidades.push(c); continue; }
    if (!porGrupo.has(g)) { porGrupo.set(g, []); unidades.push(g); }
    porGrupo.get(g).push(c);
  }
  return unidades.map(u => {
    if (typeof u !== "string" && typeof u !== "number") return u;
    const membros = porGrupo.get(u);
    if (membros.length === 1) return membros[0];
    const rep = membros.find(m => m.representante)
      ?? membros.reduce((a, b) => (b.data < a.data ? b : a));
    return { ...rep, membros: membros.length };
  });
}

export function reconciliarLinha(linha, existentes) {
  const cand = existentes.filter(e => e.valorCents === linha.valorCents && dias(linha.data, e.data) <= 3);
  const unidades = juntarPorGrupo(cand);
  // Inc 4.6: matchGrupoId = grupo da candidata (se já agrupada) — o app usa pra entrar nele.
  if (unidades.length === 1) return { status: "casado", matchId: unidades[0].id, matchGrupoId: unidades[0].grupo_id ?? null };
  // C2: o ambíguo devolve quem empatou — o app mostra a lista e o Caio escolhe (a regra não muda).
  // F1: o grupo aparece uma vez, com `membros` = quantos dele empataram.
  if (unidades.length > 1) return { status: "ambiguo", matchId: null, matchGrupoId: null, candidatos: unidades };
  return { status: "novo", matchId: null, matchGrupoId: null };
}
