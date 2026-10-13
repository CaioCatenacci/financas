import { validarExtracao, normalizarData } from "./validar.js";
import { parseBRtoCents } from "./money.js";
import { FAMILIAS, NIVEIS, PERIODOS, normalizarConta } from "./patrimonio.js";

// modos do extrator: o comprovante (padrão, desde a v1) e o print de patrimônio (A2)
export const MODOS = ["comprovante", "patrimonio"];

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

// A2: print da tela de investimentos do app do banco. Prompt próprio: não há categoria; cada
// produto vem no menor grão que o print mostrar, com a família do vocabulário fechado.
export function PROMPT_PATRIMONIO() {
  return [
    "Você lê um print da tela de investimentos/saldo do app de um banco ou corretora (Itaú, C6, Nubank, Mercado Pago).",
    "Responda SOMENTE um JSON com as chaves:",
    '{ "data": "AAAA-MM-DD"|null, "conta": "itau"|"c6"|"nubank"|"mercadopago"|null, "pessoa": string|null,',
    '  "produtos": [ { "produto": string, "familia": "fundos"|"renda_fixa"|"caixa"|"outros",',
    '    "nivel": "titulo"|"agregado", "saldo": número, "vencimento": "AAAA-MM-DD"|null, "taxa": string|null,',
    '    "rendimento": número|null, "periodo": "mes"|"ano"|"12m"|"desde_inicio"|null } ],',
    '  "confianca": número entre 0 e 1 }.',
    "data = a data que o print mostra (posição em/atualizado em); se não houver data visível, null.",
    "pessoa = o primeiro nome do titular, se aparecer; senão null.",
    "Um produto por linha, no MENOR grão que o print mostrar: cada título (CDB com taxa e vencimento, Tesouro) com nivel='titulo';",
    "o total de um grupo (Fundos, Renda Fixa/CDB, Cofrinhos/Caixinhas) com nivel='agregado'. Se o print mostrar o grupo E os títulos dele, devolva os dois.",
    "familia: Fundos → fundos; CDB, Tesouro, LCI/LCA, Renda Fixa → renda_fixa; Cofrinhos, Caixinhas, conta remunerada → caixa; o resto → outros.",
    "saldo e rendimento em reais (número, ponto decimal). rendimento = o que o print mostra de rendimento do produto, com o período (mes = no mês; ano = no ano; 12m = 12 meses; desde_inicio = desde a aplicação); sem rendimento, null nos dois.",
    "Não some nem invente valores: copie o que está na tela.",
  ].join("\n");
}

// número do modelo (500000.5) ou texto BR ("R$ 500.000,50", "-1.234,00") → centavos; inválido → null
function centavosDe(v, { negativo = false } = {}) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  const neg = negativo && s.startsWith("-");
  const c = parseBRtoCents(neg ? s.slice(1) : s);
  return c == null ? null : (neg ? -c : c);
}

/**
 * Valida a leitura de um print de patrimônio. Puro. Família, nível e período fora do vocabulário
 * recusam (gravariam lixo que o CHECK do banco barraria depois); conta desconhecida, pessoa e data
 * ausentes não recusam — a legenda e a data da mensagem completam.
 * @returns {{ok: boolean, erros: string[], normalizado?: {dataISO, conta, pessoa, produtos}}}
 */
export function validarPatrimonio(campos) {
  const erros = [];
  const c = campos && typeof campos === "object" ? campos : {};
  const dataISO = c.data == null ? null : normalizarData(String(c.data));
  const conta = normalizarConta(c.conta);
  const pessoa = typeof c.pessoa === "string" && c.pessoa.trim() ? c.pessoa.trim() : null;
  const brutos = Array.isArray(c.produtos) ? c.produtos : [];
  if (!brutos.length) erros.push("nenhum produto lido");
  const produtos = brutos.map((p, i) => {
    const q = p && typeof p === "object" ? p : {};
    const onde = `produto ${i + 1}`;
    const produto = typeof q.produto === "string" && q.produto.trim() ? q.produto.trim() : null;
    if (!produto) erros.push(`${onde}: sem nome`);
    if (!FAMILIAS.includes(q.familia)) erros.push(`${onde}: família inválida: ${q.familia}`);
    if (!NIVEIS.includes(q.nivel)) erros.push(`${onde}: nível inválido: ${q.nivel}`);
    const periodo = q.periodo == null ? null : q.periodo;
    if (periodo !== null && !PERIODOS.includes(periodo)) erros.push(`${onde}: período inválido: ${periodo}`);
    const saldo_cents = centavosDe(q.saldo);
    if (saldo_cents == null || saldo_cents < 0) erros.push(`${onde}: saldo inválido`);
    const rendimento_print_cents = q.rendimento == null ? null : centavosDe(q.rendimento, { negativo: true });
    if (q.rendimento != null && rendimento_print_cents == null) erros.push(`${onde}: rendimento inválido`);
    return {
      produto, familia: q.familia, nivel: q.nivel, saldo_cents,
      vencimento: q.vencimento == null ? null : normalizarData(String(q.vencimento)),
      taxa: typeof q.taxa === "string" && q.taxa.trim() ? q.taxa.trim() : null,
      rendimento_print_cents,
      // período sem rendimento não diz nada: guarda null
      periodo_rendimento: rendimento_print_cents == null ? null : periodo,
    };
  });
  if (erros.length) return { ok: false, erros };
  return { ok: true, erros: [], normalizado: { dataISO, conta, pessoa, produtos } };
}

function macrosDe(categorias) {
  return [...new Set(categorias.map((c) => c.macro))];
}

async function tentar(call, bytes, mime, categorias, macros, quem, modo) {
  const { campos, confianca } = await call(bytes, mime, categorias, modo);
  const v = modo === "patrimonio" ? validarPatrimonio(campos) : validarExtracao(campos, macros);
  return { v, confianca, quem };
}

// modo 'comprovante' (padrão) ou 'patrimonio' (A2): muda o prompt (no adaptador HTTP) e o
// validador; a ordem Gemini → Claude → Gemini de baixa confiança é a mesma.
export async function extrair(imagemBytes, mime, categorias, deps, modo = "comprovante") {
  if (!MODOS.includes(modo)) throw new Error(`modo inválido: ${modo}`);
  const macros = macrosDe(categorias || []);
  const errosAcum = [];

  // 1) Gemini
  let geminiOk = null;
  try {
    const g = await tentar(deps.callGemini, imagemBytes, mime, categorias, macros, "gemini", modo);
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
    const c = await tentar(deps.callClaude, imagemBytes, mime, categorias, macros, "claude", modo);
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

const promptDo = (modo, categorias) => (modo === "patrimonio" ? PROMPT_PATRIMONIO() : PROMPT(categorias));

export async function callGeminiHTTP(bytes, mime, categorias, key, modo = "comprovante") {
  // gemini-flash-latest: alias estável do flash atual (barato). O 'gemini-2.5-flash'
  // foi descontinuado p/ novos usuários (404), o que jogava tudo no fallback Claude.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [
      { text: promptDo(modo, categorias) },
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

export async function callClaudeHTTP(bytes, mime, categorias, key, modo = "comprovante") {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      // o print de patrimônio traz vários produtos: 400 tokens cortaria o JSON no meio
      max_tokens: modo === "patrimonio" ? 2000 : 400,
      messages: [{ role: "user", content: [
        blocoConteudoClaude(mime, b64(bytes)),
        { type: "text", text: promptDo(modo, categorias) + "\nResponda só o JSON." },
      ] }],
    }),
  });
  if (!resp.ok) throw new Error(`claude ${resp.status}`);
  const j = await resp.json();
  const txt = (j.content?.[0]?.text ?? "{}").replace(/^```json\s*|\s*```$/g, "");
  const campos = JSON.parse(txt);
  return { campos, confianca: Number(campos.confianca ?? 0) };
}
