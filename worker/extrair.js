import { validarExtracao } from "./validar.js";

export function PROMPT(categorias) {
  const lista = categorias
    .map((c) => (c.sub ? `${c.macro} > ${c.sub}` : c.macro))
    .join("; ");
  return [
    "Você lê um comprovante de pagamento (pix/transferência) em imagem ou PDF.",
    "Responda SOMENTE um JSON com as chaves:",
    '{ "data": "AAAA-MM-DD", "valor": número, "descricao": string,',
    '  "natureza": "despesa"|"receita", "macro": string, "sub": string|null,',
    '  "contraparte_nome": string|null, "contraparte_chave": string|null,',
    '  "confianca": número entre 0 e 1 }.',
    "contraparte_nome = quem RECEBE (despesa) ou quem PAGA (receita) — o outro lado.",
    "contraparte_chave = chave Pix, CPF/CNPJ ou agência/conta do outro lado, se houver; senão null.",
    "Escolha macro e sub EXCLUSIVAMENTE desta lista (não invente rótulo):",
    lista,
    "Se não tiver certeza do sub, use null. 'confianca' é sua certeza global na leitura.",
  ].join("\n");
}

function macrosDe(categorias) {
  return [...new Set(categorias.map((c) => c.macro))];
}

async function tentar(call, bytes, mime, categorias, macros, quem) {
  const { campos, confianca } = await call(bytes, mime, categorias);
  const v = validarExtracao(campos, macros);
  return { v, confianca, quem };
}

export async function extrair(imagemBytes, mime, categorias, deps) {
  const macros = macrosDe(categorias);
  const errosAcum = [];

  // 1) Gemini
  let geminiOk = null;
  try {
    const g = await tentar(deps.callGemini, imagemBytes, mime, categorias, macros, "gemini");
    if (g.v.ok && g.confianca >= deps.limiar) {
      return { ok: true, normalizado: g.v.normalizado, extraido_por: "gemini", confianca: g.confianca };
    }
    geminiOk = g; // guarda p/ eventual uso se Claude também falhar
    if (!g.v.ok) errosAcum.push(...g.v.erros.map((e) => `gemini: ${e}`));
  } catch (e) {
    errosAcum.push(`gemini: ${e?.message ?? String(e)}`);
  }

  // 2) Claude (fallback)
  try {
    const c = await tentar(deps.callClaude, imagemBytes, mime, categorias, macros, "claude");
    if (c.v.ok) {
      return { ok: true, normalizado: c.v.normalizado, extraido_por: "claude", confianca: c.confianca };
    }
    errosAcum.push(...c.v.erros.map((e) => `claude: ${e}`));
  } catch (e) {
    errosAcum.push(`claude: ${e?.message ?? String(e)}`);
  }

  // 3) último recurso: Gemini válido mas de baixa confiança ainda serve
  if (geminiOk && geminiOk.v.ok) {
    return { ok: true, normalizado: geminiOk.v.normalizado, extraido_por: "gemini", confianca: geminiOk.confianca };
  }
  return { ok: false, erros: errosAcum };
}

// ---- Adaptadores HTTP reais (não usados nos testes unitários) ----

function b64(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

// Claude usa bloco `document` p/ PDF e `image` p/ imagem (o Gemini aceita o mime direto no inline_data).
export function blocoConteudoClaude(mime, dataB64) {
  if (mime === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: mime, data: dataB64 } };
  }
  return { type: "image", source: { type: "base64", media_type: mime, data: dataB64 } };
}

export async function callGeminiHTTP(bytes, mime, categorias, key) {
  // gemini-flash-latest: alias estável do flash atual (barato). O 'gemini-2.5-flash'
  // foi descontinuado p/ novos usuários (404), o que jogava tudo no fallback Claude.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [
      { text: PROMPT(categorias) },
      { inline_data: { mime_type: mime, data: b64(bytes) } },
    ] }],
    generationConfig: { responseMimeType: "application/json" },
  };
  const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`gemini ${resp.status}`);
  const j = await resp.json();
  const txt = j.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const campos = JSON.parse(txt);
  return { campos, confianca: Number(campos.confianca ?? 0) };
}

export async function callClaudeHTTP(bytes, mime, categorias, key) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: [
        blocoConteudoClaude(mime, b64(bytes)),
        { type: "text", text: PROMPT(categorias) + "\nResponda só o JSON." },
      ] }],
    }),
  });
  if (!resp.ok) throw new Error(`claude ${resp.status}`);
  const j = await resp.json();
  const txt = (j.content?.[0]?.text ?? "{}").replace(/^```json\s*|\s*```$/g, "");
  const campos = JSON.parse(txt);
  return { campos, confianca: Number(campos.confianca ?? 0) };
}
