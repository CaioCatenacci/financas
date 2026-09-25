// Inc 4.6: regras de grupo (duplicatas explícitas com representante). PURO: sem banco, sem
// rede — as linhas entram por parâmetro no formato {id, fonte, criado_em, grupo_id,
// representante, valor_final}. Cada função devolve { ok:true, mudancas:[...] } ou
// { ok:false, erro } com mensagem legível (o Worker responde 400 com ela).
//
// `mudancas` é a lista MÍNIMA de linhas a atualizar ({id, grupo_id, representante}), NA ORDEM
// em que devem ser gravadas: o índice único "um representante por grupo" exige tirar a flag do
// atual antes de pôr no novo, e o db grava a lista em sequência numa única transação.

const ehBanco = (l) => l.fonte === "extrato" || l.fonte === "fatura";
const maisAntiga = (a, b) => (String(a.criado_em) <= String(b.criado_em) ? a : b);

// Quem representa um grupo novo: a linha que NÃO veio do banco — é onde mora o contexto que o
// Caio escreveu na hora (categoria, pessoa, descrição). Havendo várias, a mais antiga. Se todas
// vieram do banco, a mais antiga.
export function escolherRepresentante(linhas) {
  const manuais = linhas.filter((l) => !ehBanco(l));
  const pool = manuais.length ? manuais : linhas;
  return pool.reduce(maisAntiga);
}

export function decidirAgrupar(linhas, novoGrupoId) {
  if (!Array.isArray(linhas) || linhas.length < 2) {
    return { ok: false, erro: "selecione pelo menos 2 lançamentos pra agrupar" };
  }
  const grupos = [...new Set(linhas.map((l) => l.grupo_id).filter(Boolean))];
  if (grupos.length > 1) return { ok: false, erro: "desagrupe antes: a seleção tem linhas de grupos diferentes" };

  const soltas = linhas.filter((l) => !l.grupo_id);
  if (grupos.length === 1) {
    // entra no grupo existente; o representante fica quem era
    if (!soltas.length) return { ok: false, erro: "essas linhas já estão no mesmo grupo" };
    const grupo_id = grupos[0];
    const rep = linhas.find((l) => l.grupo_id === grupo_id && l.representante);
    return {
      ok: true, grupo_id, representante_id: rep ? rep.id : null,
      mudancas: soltas.map((l) => ({ id: l.id, grupo_id, representante: false })),
    };
  }
  const rep = escolherRepresentante(linhas);
  return {
    ok: true, grupo_id: novoGrupoId, representante_id: rep.id,
    mudancas: linhas.map((l) => ({ id: l.id, grupo_id: novoGrupoId, representante: l.id === rep.id })),
  };
}

export function decidirRepresentar(membros, novoId) {
  const novo = membros.find((m) => m.id === novoId);
  if (!novo) return { ok: false, erro: "esse lançamento não está no grupo" };
  const atual = membros.find((m) => m.representante);
  if (atual && atual.id === novoId) return { ok: true, mudancas: [] };
  const mudancas = [];
  if (atual) mudancas.push({ id: atual.id, grupo_id: atual.grupo_id, representante: false }); // tira ANTES
  mudancas.push({ id: novo.id, grupo_id: novo.grupo_id, representante: true });             // põe DEPOIS
  return { ok: true, mudancas };
}

export function decidirTirar(membros, id) {
  const alvo = membros.find((m) => m.id === id);
  if (!alvo) return { ok: false, erro: "esse lançamento não está no grupo" };
  if (alvo.representante && membros.length > 1) {
    return { ok: false, erro: "escolha outro representante antes de tirar este" };
  }
  const restantes = membros.filter((m) => m.id !== id);
  const mudancas = [{ id, grupo_id: null, representante: false }];
  // grupo de 1 não é grupo: dissolve
  if (restantes.length === 1) mudancas.push({ id: restantes[0].id, grupo_id: null, representante: false });
  return { ok: true, mudancas, dissolveu: restantes.length <= 1 };
}

export function decidirDesagrupar(membros) {
  return { ok: true, mudancas: membros.map((m) => ({ id: m.id, grupo_id: null, representante: false })) };
}

// Apagar uma transação que representa um grupo com outros membros deixaria o grupo sem quem
// conta (e sem linha na tela) → recusa; o Caio escolhe outro representante antes.
export function podeApagar(membros, id) {
  if (!membros.length) return { ok: true, mudancas: [] };
  const alvo = membros.find((m) => m.id === id);
  if (!alvo) return { ok: true, mudancas: [] };
  if (alvo.representante && membros.length > 1) {
    return { ok: false, erro: "escolha outro representante antes de apagar este" };
  }
  const restantes = membros.filter((m) => m.id !== id);
  const mudancas = restantes.length === 1 ? [{ id: restantes[0].id, grupo_id: null, representante: false }] : [];
  return { ok: true, mudancas };
}

// Só informa (selo na tela): duplicata com valor diferente do representante é o caso
// "salário + repasse na mesma entrada" — intencional, mas vale o aviso.
export function valoresDiferem(representante, membros) {
  const v = Number(representante.valor_final);
  return membros.some((m) => Number(m.valor_final) !== v);
}
