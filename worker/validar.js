import { parseBRtoCents } from "./money.js";

/**
 * Normaliza data em formato BR (DD/MM/AAAA) ou ISO (AAAA-MM-DD).
 * Aceita dados não-padronizados (ex: 5/1/2026) e zero-preenche o ISO.
 * Rejeita datas impossíveis (ex: 32/13).
 * Retorna string ISO "AAAA-MM-DD" ou null se inválida.
 */
function normalizarData(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let ano, mes, dia;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { [, ano, mes, dia] = m; }
  else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    [, dia, mes, ano] = m;
  }
  // normaliza para 2 dígitos: modelos de visão às vezes devolvem "5/1/2026"
  mes = String(mes).padStart(2, "0");
  dia = String(dia).padStart(2, "0");
  const d = new Date(`${ano}-${mes}-${dia}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  // round-trip rejeita data impossível (ex.: 32/13)
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
