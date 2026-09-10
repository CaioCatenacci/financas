// Inc 4: planejamento. Puro (sem banco/rede) — tudo entra por parâmetro, p/ auditar o número.
// Dinheiro em centavos inteiros; datas ISO comparadas lexicograficamente (YYYY-MM-DD ordena certo).

// 'YYYY-MM' ou 'YYYY-MM-DD' → 'YYYY-MM-01' (primeiro dia do mês).
export function primeiroDiaDoMes(mes) {
  return mes.slice(0, 7) + "-01";
}

// n meses antes de `mes`; n negativo = meses à frente. Vira o ano via aritmética de índice.
export function mesAnterior(mes, n = 1) {
  const [a, m] = mes.slice(0, 7).split("-").map(Number);
  const idx = a * 12 + (m - 1) - n;
  const ano = Math.floor(idx / 12);
  const mm = ((idx % 12) + 12) % 12 + 1; // 1..12, seguro p/ índice negativo
  return `${ano}-${String(mm).padStart(2, "0")}`;
}

// Alvo efetivo de (categoria, mês). Precedência: exceção > baseline mais recente <= mês > sem-alvo.
export function alvoEfetivo(baselines, excecoes, categoriaId, mesDia01) {
  const exc = (excecoes || []).find(e => e.categoria_id === categoriaId && e.mes === mesDia01);
  if (exc) return { valorCents: exc.valor_cents, origem: "excecao" };
  const cands = (baselines || [])
    .filter(b => b.categoria_id === categoriaId && b.vigente_desde <= mesDia01)
    .sort((x, y) => (x.vigente_desde < y.vigente_desde ? 1 : -1)); // desc: mais recente primeiro
  if (cands.length) return { valorCents: cands[0].valor_cents, origem: "baseline" };
  return { valorCents: null, origem: "sem-alvo" };
}

// Média (centavos, arredondada) do realizado dos `janela` meses ANTERIORES a `mes`.
// Conta só os meses presentes em realizadoPorMes; nenhum presente → null.
export function mediaSugestao(realizadoPorMes, mes, janela = 3) {
  const vals = [];
  for (let i = 1; i <= janela; i++) {
    const m = mesAnterior(mes, i);
    if (realizadoPorMes[m] != null) vals.push(realizadoPorMes[m]);
  }
  if (!vals.length) return null;
  return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
}

// Faixa visual do consumo do alvo. Sem alvo → 'sem-alvo'; >100% → 'estouro'; >=80% → 'aviso'; senão 'normal'.
export function statusMeta(realizadoCents, alvoCents) {
  if (alvoCents == null) return "sem-alvo";
  if (alvoCents === 0) return realizadoCents > 0 ? "estouro" : "normal";
  const frac = realizadoCents / alvoCents;
  if (frac > 1) return "estouro";
  if (frac >= 0.8) return "aviso";
  return "normal";
}
