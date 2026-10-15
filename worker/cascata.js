// A3: cascata do mês — salário PJ → − despesas da empresa → disponível para a casa → + outras
// receitas → − despesas pessoais → saldo. Puro (sem banco, sem rede): as somas chegam prontas do
// SQL (db.somasPorEsfera, conta_no_resumo) e o salário de alocarSalario (G1). Só soma e subtrai
// inteiros em centavos.
//
// A identidade que importa: salario + outras_receitas − (empresa + pessoal) é exatamente o saldo
// do /api/saldo-mensal, que soma receita e despesa por natureza. Por isso as outras receitas são
// TODAS as receitas que contam (de qualquer esfera): uma receita que ficasse fora de todos os
// degraus faria a cascata divergir do card "Saldo do mês".
export function montarCascata(salario, somas, pessoais = []) {
  // antes do primeiro salario_param o G1 devolve brl_cents null: aqui vira 0 (o degrau desenha 0)
  const salario_cents = Number(salario?.brl_cents ?? 0);
  const despesa_empresa_cents = Number(somas?.despesa_empresa_cents || 0);
  const outras_receitas_cents = Number(somas?.outras_receitas_cents || 0);
  const despesa_pessoal_cents = Number(somas?.despesa_pessoal_cents || 0);
  const disponivel_cents = salario_cents - despesa_empresa_cents;
  return {
    salario_cents,
    despesa_empresa_cents,
    disponivel_cents,
    outras_receitas_cents,
    despesa_pessoal_cents,
    saldo_cents: disponivel_cents + outras_receitas_cents - despesa_pessoal_cents,
    estimado: !!salario?.estimado,
    // despesas pessoais por categoria (macro), centavos: os degraus do waterfall
    pessoais: pessoais.map(p => ({ macro: p.macro, total_cents: Number(p.total_cents) })),
  };
}
