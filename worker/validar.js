import { parseBRtoCents } from "./money.js";

/**
 * Normaliza data em formato BR (DD/MM/AAAA) ou ISO (AAAA-MM-DD).
 * Rejeita datas impossíveis (ex: 32/13).
 * Retorna string ISO "AAAA-MM-DD" ou null se inválida.
 */
function normalizarData(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let ano, mes, dia;
  if (m) {
    [, ano, mes, dia] = m;
  } else {
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    [, dia, mes, ano] = m;
  }
  const d = new Date(`${ano}-${mes}-${dia}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  // Rejeita overflow tipo 32/13: o Date normaliza, então confere de volta
  if (d.getUTCMonth() + 1 !== Number(mes) || d.getUTCDate() !== Number(dia)) return null;
  return `${ano}-${mes}-${dia}`;
}

/**
 * Valida extração de dados financeiros.
 *
 * @param {Object} campos - { data, valor, descricao?, natureza?, macro, sub? }
 * @param {Array<string>} macrosValidas - lista de categorias principais válidas
 * @returns {Object} { ok: boolean, erros: string[], normalizado?: {...} }
 *   Se ok, normalizado contém: dataISO, valorCents, natureza, macro, sub, descricao
 */
export function validarExtracao(campos, macrosValidas) {
  const erros = [];

  // Validar valor: parseável, numérico e > 0
  const valorCents =
    typeof campos.valor === "number"
      ? Math.round(campos.valor * 100)
      : parseBRtoCents(String(campos.valor ?? ""));
  if (valorCents === null || valorCents <= 0) {
    erros.push("valor inválido");
  }

  // Validar data: aceita DD/MM/AAAA ou AAAA-MM-DD
  const dataISO = normalizarData(campos.data);
  if (!dataISO) {
    erros.push("data inválida");
  }

  // Natureza: default "despesa" se ausente
  const natureza = campos.natureza === "receita" ? "receita" : "despesa";

  // Macro: deve estar na lista fornecida
  const macro = campos.macro;
  if (!macrosValidas.includes(macro)) {
    erros.push(`macro desconhecida: ${macro}`);
  }

  // Se teve erro, retorna sem normalizado
  if (erros.length) {
    return { ok: false, erros };
  }

  // Sucesso: retorna normalizado
  return {
    ok: true,
    erros: [],
    normalizado: {
      dataISO,
      valorCents,
      natureza,
      macro,
      sub: campos.sub || null,
      descricao: campos.descricao || null,
    },
  };
}
