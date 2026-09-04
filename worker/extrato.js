/**
 * Parser determinístico do extrato Itaú (texto do PDF). Puro: entra texto, sai estrutura.
 * Linha: 'DD/MM/AAAA <descrição> <valor>'. 'SALDO DO DIA' é marcador (vira saldo, não lançamento).
 * Valor negativo = saída (despesa); positivo = entrada (receita)
 */

const _LINHA = /^(\d{2})\/(\d{2})\/(\d{4})\s+(.+?)\s+(-?[\d.]+,\d{2})$/;

/**
 * Converte valor em formato brasileiro para centavos.
 * '-1.574,52' -> -157452 ; '30.000,00' -> 3000000
 */
function _cents(valor) {
  const neg = valor.trim().startsWith("-");
  const s = valor.replace("-", "").replace(/\./g, "").replace(",", "");
  const n = parseInt(s, 10);
  return neg ? -n : n;
}

/**
 * Parseia o texto do extrato Itaú.
 * Retorna { linhas: [...], saldos: [...] }
 * Linhas excluem "SALDO DO DIA" e incluem valorCents (absoluto), natureza (por sinal), ordinal (por data).
 * Saldos contêm apenas as linhas com "SALDO DO DIA".
 */
export function parseExtrato(texto) {
  const linhas = [];
  const saldos = [];
  const ordinais = {}; // data -> próximo ordinal

  for (const raw of texto.split("\n")) {
    const m = _LINHA.exec(raw.trim());
    if (!m) {
      continue;
    }

    const [, dd, mm, aaaa, descricao, valor] = m;
    const data = `${aaaa}-${mm}-${dd}`;
    const descricaoTrim = descricao.trim();
    const cents = _cents(valor);

    if (descricaoTrim.toUpperCase() === "SALDO DO DIA") {
      saldos.push({ data, saldoCents: cents });
      continue;
    }

    // Rastreia ordinal por data
    const o = ordinais[data] || 0;
    ordinais[data] = o + 1;

    linhas.push({
      data,
      descricao: descricaoTrim,
      valorCents: Math.abs(cents),
      natureza: cents > 0 ? "receita" : "despesa",
      ordinal: o,
    });
  }

  return { linhas, saldos };
}

/**
 * Valida o checksum do extrato usando atribuição por intervalo.
 * Entre saldos consecutivos, a variação de saldo deve igualar a soma (com sinal) dos
 * lançamentos no intervalo (prev, cur] — atribui por INTERVALO (não por dia exato), pois
 * há dias com lançamento sem "SALDO DO DIA". Descarta saldos após o último lançamento
 * (ex.: o "saldo do dia" da data de emissão, fora do período).
 */
export function conferirChecksum(linhas, saldos) {
  if (saldos.length < 2 || linhas.length === 0) {
    return { ok: true, diferencaCents: 0 };
  }

  // Encontra a data máxima dos lançamentos (compare as strings)
  const maxlanc = linhas.reduce((max, l) => (l.data > max ? l.data : max), linhas[0].data);

  // Filtra e ordena saldos até maxlanc
  const s = saldos
    .filter(x => x.data <= maxlanc)
    .sort((a, b) => a.data.localeCompare(b.data));

  if (s.length < 2) {
    return { ok: true, diferencaCents: 0 };
  }

  // Ordena lançamentos por data
  const lo = [...linhas].sort((a, b) => a.data.localeCompare(b.data));

  let dif = 0;
  for (let i = 1; i < s.length; i++) {
    const de = s[i - 1].data;
    const ate = s[i].data;
    const esperado = s[i].saldoCents - s[i - 1].saldoCents;

    // Soma dos lançamentos no intervalo (de, ate] com sinal (receita +, despesa -)
    const real = lo
      .filter(l => de < l.data && l.data <= ate)
      .reduce((sum, l) => {
        const signed = l.natureza === "receita" ? l.valorCents : -l.valorCents;
        return sum + signed;
      }, 0);

    dif += esperado - real;
  }

  return { ok: dif === 0, diferencaCents: dif };
}
