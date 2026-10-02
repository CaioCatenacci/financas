// Extração de texto de PDF no navegador (pdf.js via CDN) + reconstrução de linhas.
// O PDF nunca sai do navegador: aqui só extraímos texto e mandamos texto pro Worker
// (worker/extrato.js parseExtrato / worker/fatura.js parseFatura), que fazem o parsing.
//
// pdf.js entrega os textos da página como itens soltos ({str, transform}), sem quebra
// de linha — cada item carrega sua posição (x, y) via transform[4]/transform[5]. Pra
// virar linhas de texto (que é o que os parsers do Worker esperam), reagrupamos por y
// (mesma altura = mesma linha visual, com tolerância pro rounding sub-pixel do pdf.js)
// e ordenamos por x dentro da linha (esquerda pra direita).
//
// Dois modos, porque o Worker espera formatos diferentes:
// - "simples" (extrato): uma coluna só, junta os tokens da linha com espaço único.
// - "layout" (fatura): duas colunas (item à esquerda, "Juros"/outros à direita).
//   Preserva o espaçamento proporcional ao gap em x pra manter as colunas legíveis,
//   mas o que garante o parsing correto é a ORDEM por x — o valor da coluna do item
//   fica com x menor que o ruído da coluna da direita, então aparece primeiro na
//   linha reconstruída, e é isso que parseFatura pega (primeiro token de dinheiro
//   depois da data).

const TOLERANCIA_Y = 2; // pdf.js às vezes varia +-1 unidade de y por rounding/glyph baseline

/**
 * Agrupa itens {str,x,y} em linhas visuais (mesma faixa de y) ordenadas de cima pra
 * baixo (y maior primeiro — origem do PDF é canto inferior-esquerdo). Dentro de cada
 * linha, ordena os itens por x crescente (esquerda pra direita).
 */
function agruparLinhas(itens) {
  const validos = itens.filter(it => it.str && it.str.trim() !== "");
  const ordenados = [...validos].sort((a, b) => b.y - a.y);

  const linhas = [];
  for (const it of ordenados) {
    let linha = linhas.find(l => Math.abs(l.y - it.y) <= TOLERANCIA_Y);
    if (!linha) {
      linha = { y: it.y, itens: [] };
      linhas.push(linha);
    }
    linha.itens.push(it);
  }

  linhas.sort((a, b) => b.y - a.y);
  for (const l of linhas) l.itens.sort((a, b) => a.x - b.x);
  return linhas;
}

/**
 * Junta os tokens de uma linha em texto. modo "layout" espaça proporcional ao gap de x
 * (pra manter as colunas visualmente separadas); modo "simples" junta com espaço único.
 */
function construirLinha(itensLinha, modo) {
  if (modo === "layout") {
    let out = itensLinha[0].str.trim();
    for (let i = 1; i < itensLinha.length; i++) {
      const gap = itensLinha[i].x - itensLinha[i - 1].x;
      const nEspacos = Math.min(20, Math.max(1, Math.round(gap / 5)));
      out += " ".repeat(nEspacos) + itensLinha[i].str.trim();
    }
    return out;
  }
  return itensLinha.map(it => it.str.trim()).filter(Boolean).join(" ");
}

/**
 * Reconstrói o texto de uma página (ou de todo o PDF, se `itens` já vier de páginas
 * concatenadas) a partir dos itens de texto do pdf.js, normalizados como {str,x,y}.
 * Pura: sem I/O, testável direto com fixtures sintéticas.
 * @param {{str:string,x:number,y:number}[]} itens
 * @param {"simples"|"layout"} modo
 * @returns {string}
 */
export function reconstruirTexto(itens, modo = "simples") {
  const linhas = agruparLinhas(itens);
  return linhas.map(l => construirLinha(l.itens, modo)).join("\n");
}

/**
 * Extrai o texto de um PDF (ArrayBuffer) usando pdf.js carregado do CDN (window.pdfjsLib).
 * Só roda no navegador — não é testado em node (por isso o acesso a window.pdfjsLib fica
 * só aqui dentro, nunca no topo do módulo, senão importar este arquivo em node quebraria).
 * @param {ArrayBuffer} arrayBuffer
 * @param {"simples"|"layout"} modo
 * @returns {Promise<string>}
 */
export async function extrairTextoPDF(arrayBuffer, modo, opcoesSenha = {}) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) {
    throw new Error("pdfjsLib não carregado (CDN)");
  }

  const pdf = await abrirPdf(pdfjsLib, arrayBuffer, opcoesSenha);
  const textoPorPagina = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const itens = content.items.map(it => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
    }));
    textoPorPagina.push(reconstruirTexto(itens, modo));
  }

  return textoPorPagina.join("\n");
}

// C1: o PDF do C6 vem com senha. pdf.js lança PasswordException (name) quando a senha falta
// (code 1, NEED_PASSWORD) ou não abre (code 2, INCORRECT_PASSWORD).
function ehErroDeSenha(err) {
  return !!err && (err.name === "PasswordException" || err.code === 1 || err.code === 2);
}

/**
 * Abre o PDF no pdf.js tentando, em ordem: a `senha` recebida (a do secret C6_PDF_SENHA, se
 * houver) e, se ela faltar ou não abrir, o que `pedirSenha()` devolver (o app pede num campo).
 * `pedirSenha` devolve a senha digitada ou null (desistiu). Pura quanto a estado: a senha só vive
 * nesta chamada — nada vai para localStorage, cookie ou mensagem de erro.
 * Cada tentativa recebe uma CÓPIA dos bytes: o pdf.js transfere o buffer pro worker dele e o
 * original fica inutilizável para uma segunda tentativa.
 * @param {{getDocument: Function}} pdfjsLib
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {{senha?: string|null, pedirSenha?: (motivo: string) => Promise<string|null>}} opcoes
 */
export async function abrirPdf(pdfjsLib, bytes, { senha = null, pedirSenha = null } = {}) {
  const original = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const tentar = (password) => {
    const opts = { data: original.slice() };
    if (password) opts.password = password;
    return pdfjsLib.getDocument(opts).promise;
  };

  let tentativa = senha || null;
  let motivo = null;
  for (let i = 0; i < 5; i++) {
    try {
      return await tentar(tentativa);
    } catch (err) {
      if (!ehErroDeSenha(err)) throw err;
      motivo = tentativa ? "a senha não abriu o PDF" : "o PDF pede senha";
      const digitada = pedirSenha ? await pedirSenha(motivo) : null;
      if (!digitada) break;
      tentativa = digitada;
    }
  }
  // mensagem fixa: nunca ecoa a senha tentada
  throw new Error(`Não abriu o PDF: ${motivo ?? "senha"}.`);
}
