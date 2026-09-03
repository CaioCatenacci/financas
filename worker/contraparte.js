// Normalização da contraparte p/ servir de chave de aprendizado.
// Por quê: a mesma pessoa aparece com grafias/formatos diferentes; normalizar
// evita criar regras duplicadas e faz o lookup casar.

export function normalizarNome(s) {
  if (!s || typeof s !== "string") return null;
  const n = s.normalize("NFD").replace(/[̀-ͯ]/g, "") // tira acento
    .toUpperCase().replace(/\s+/g, " ").trim();
  return n || null;
}

export function normalizarChave(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  if (t.includes("@")) return t.toLowerCase();      // e-mail
  if (/[a-z]/i.test(t)) return t.toLowerCase();      // chave aleatória (EVP/UUID): tem letra → preserva
  const d = t.replace(/\D/g, "");                     // telefone/CPF: só dígitos
  return d || null;
}

export function derivarChave({ contraparte_nome, contraparte_chave } = {}) {
  const ch = normalizarChave(contraparte_chave);
  if (ch) return { chave: ch, tipo: "pix_cpf" };
  const nm = normalizarNome(contraparte_nome);
  if (nm) return { chave: nm, tipo: "nome" };
  return null;
}
