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
export async function extrairTextoPDF(arrayBuffer, modo) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) {
    throw new Error("pdfjsLib não carregado (CDN)");
  }

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
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
