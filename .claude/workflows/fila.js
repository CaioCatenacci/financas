export const meta = {
  name: 'fila',
  description: 'Consome a fila do financas: PM apura, coder implementa, reviewer valida, PR aberta e, no degrau 2, entrega no ar — até o limite',
  whenToUse: 'Quando o Caio disser "roda a fila" ou "ensaia a fila". args: {limite, degrau, ensaio, data}',
  phases: [
    { title: 'Pré-voo', detail: 'conta do gh, CI do master, candidatos' },
    { title: 'Itens', detail: 'um por vez: PM, coder, escopo, reviewer, PR, degrau 2' },
    { title: 'Relatório', detail: 'grava .superpowers/fila/<data>.md' },
  ],
}

// As regras de parada moram aqui, em código: "até N", "para na primeira
// falha", "devolução não é falha". O julgamento fica com os agentes; a
// decisão exata (candidatos, escopo, degrau 2) fica com tools/fila.mjs.
const A = args || {}
const LIMITE = A.limite ?? 3
const DEGRAU = A.degrau ?? 2 // o Caio pediu o máximo de automação: merge e deploy sem migração são automáticos
const ENSAIO = A.ensaio === true
const DATA = A.data || 'sem-data' // o script não tem relógio: a sessão passa a data

const S = (props, required = Object.keys(props)) => ({ type: 'object', properties: props, required })
const str = { type: 'string' }
const bool = { type: 'boolean' }
const int = { type: 'integer' }
const strs = { type: 'array', items: str }
const um = (...v) => ({ type: 'string', enum: v })

const PRE = S({ ok: bool, motivo: str,
  prontos: { type: 'array', items: S({ id: str, nome: str, toca: strs }) },
  bloqueados: { type: 'array', items: S({ id: str, motivo: str }) },
  em_pr: strs })
const PARECER = S({ veredito: um('segue', 'devolve'), motivo: str, achados: str, aceite_interpretado: strs })
const CODER = S({ status: um('pronto', 'precisa_decisao', 'falhou'), motivo: str, worktree: str, branch: str, commits: strs })
const ESCOPO = S({ declarado: strs, derivado: strs, nao_classificados: strs, fora_do_declarado: strs })
const REV = S({ veredito: um('aprova', 'reprova'), achados: strs,
  evidencia_por_aceite: { type: 'array', items: S({ aceite: str, evidencia: str }) },
  migracao_ensaiada: bool })
const PR = S({ numero: int, url: str, ci: um('verde', 'vermelho'), detalhe: str })
const D2 = S({ ok: bool, motivos: strs })
const ENTREGA = S({ entregue: bool, migracao_aplicada: str, deploy: str, verificacao: str })
const ARQ = S({ caminho: str })

const lista = (xs) => xs.map((x) => `- ${x}`).join('\n')
const resultados = []
const registrar = (r) => {
  resultados.push(r)
  log(`${r.id}: ${r.resultado}${r.motivo ? ' — ' + r.motivo : ''}`)
}

phase('Pré-voo')
const pre = await agent('Pré-voo da rodada da fila. Siga a seção "Pré-voo" das suas instruções.',
  { agentType: 'pm-financas', schema: PRE, label: 'pré-voo', phase: 'Pré-voo' })

let parou = null
if (!pre) parou = 'o agente do pré-voo morreu'
else if (!pre.ok) parou = `pré-voo recusou: ${pre.motivo}`

let prs = 0
if (!parou) {
  phase('Itens')
  for (const c of pre.prontos) {
    if (prs >= LIMITE) { log(`limite de ${LIMITE} atingido`); break }

    // 1. PM apura
    const par = await agent(`Apure o item ${c.id} (${c.nome}). Siga a seção "Apuração de um item" das suas instruções.`,
      { agentType: 'pm-financas', schema: PARECER, label: `${c.id} · PM`, phase: 'Itens' })
    if (!par) { parou = `${c.id}: o PM morreu`; registrar({ id: c.id, resultado: 'falha', motivo: 'PM morreu' }); break }
    if (par.veredito === 'devolve') {
      registrar({ id: c.id, resultado: 'devolvido', motivo: par.motivo, achados: par.achados })
      continue
    }
    if (ENSAIO) {
      registrar({ id: c.id, resultado: 'ensaio: seguiria', motivo: par.motivo, achados: par.achados, aceite: par.aceite_interpretado })
      prs++
      continue
    }

    const devolver = (motivo, extra = {}) => registrar({ id: c.id, resultado: 'devolvido', motivo, ...extra })
    const falha = (onde, motivo, extra = {}) => {
      parou = `${c.id}: ${onde}`
      registrar({ id: c.id, resultado: 'falha', motivo: `${onde} — ${motivo}`, ...extra })
    }

    // 2. coder implementa
    const pedidoCoder = `Implemente o item ${c.id} (${c.nome}) da fila. Toca declarado: ${JSON.stringify(c.toca)}.\n` +
      `Aceite como o PM interpretou:\n${lista(par.aceite_interpretado)}\n\nApurado pelo PM:\n${par.achados}`
    let cod = await agent(pedidoCoder, { agentType: 'coder-financas', schema: CODER, label: `${c.id} · coder`, phase: 'Itens' })
    if (!cod) { falha('coder morreu', 'sem retorno'); break }
    const wt = cod.worktree
    const br = cod.branch
    if (cod.status === 'precisa_decisao') { devolver(`coder precisa de decisão: ${cod.motivo}`, { worktree: wt }); continue }
    if (cod.status === 'falhou') { falha('coder não fechou as suítes', cod.motivo, { worktree: wt }); break }

    // 3. escopo derivado do diff, em código
    const escopo = () => agent(
      `Na raiz do repositório (não na worktree), rode exatamente:\n  node tools/fila.mjs --ref origin/master toca ${c.id} origin/master ${br}\n` +
      'e devolva o JSON que ele imprimir, campo a campo, sem interpretar.',
      { schema: ESCOPO, label: `${c.id} · escopo`, phase: 'Itens', effort: 'low' })
    let esc = await escopo()
    if (!esc) { falha('conferência de escopo morreu', 'sem retorno', { worktree: wt }); break }
    if (esc.fora_do_declarado.length) {
      devolver(`tocou fora do declarado: ${esc.fora_do_declarado.join(', ')}`, { worktree: wt })
      continue
    }

    // 4. reviewer, com uma rodada de correção
    const pedidoRev = (e) => `Revise a entrega do item ${c.id} (${c.nome}) na worktree ${wt} (branch ${br}).\n` +
      `Toca derivado do diff: ${JSON.stringify(e.derivado)}. Não classificados: ${JSON.stringify(e.nao_classificados)}.\n` +
      `Aceite:\n${lista(par.aceite_interpretado)}`
    let rev = await agent(pedidoRev(esc), { agentType: 'reviewer-financas', schema: REV, label: `${c.id} · reviewer`, phase: 'Itens' })
    const dePrimeira = rev?.veredito === 'aprova'
    if (rev && rev.veredito === 'reprova') {
      cod = await agent(`${pedidoCoder}\n\nCORREÇÃO: a worktree ${wt} já existe. O reviewer reprovou com estes achados — corrija todos:\n${lista(rev.achados)}`,
        { agentType: 'coder-financas', schema: CODER, label: `${c.id} · correção`, phase: 'Itens' })
      // Esbarrar numa escolha no meio da correção é o mesmo que na primeira
      // passada: devolução ao Caio, não falha que para a rodada.
      if (cod && cod.status === 'precisa_decisao') { devolver(`coder precisa de decisão na correção: ${cod.motivo}`, { worktree: wt }); continue }
      if (!cod || cod.status !== 'pronto') { falha('correção não fechou', cod ? cod.motivo : 'coder morreu', { worktree: wt }); break }
      esc = await escopo()
      if (!esc) { falha('conferência de escopo morreu', 'sem retorno', { worktree: wt }); break }
      if (esc.fora_do_declarado.length) {
        devolver(`a correção tocou fora do declarado: ${esc.fora_do_declarado.join(', ')}`, { worktree: wt })
        continue
      }
      rev = await agent(pedidoRev(esc), { agentType: 'reviewer-financas', schema: REV, label: `${c.id} · reviewer 2`, phase: 'Itens' })
    }
    if (!rev) { falha('reviewer morreu', 'sem retorno', { worktree: wt }); break }
    if (rev.veredito !== 'aprova') { falha('reprovado duas vezes', rev.achados.join(' | '), { worktree: wt }); break }

    // 5. PR — só depois da aprovação; o coder nunca faz push
    const temMig = esc.derivado.includes('migracao')
    const titulo = `${c.id}: ${c.nome}`
    const corpo = [
      `Item **${c.id}** da fila autônoma — ${c.nome}.`,
      '',
      '## Aceite',
      ...rev.evidencia_por_aceite.map((e) => `- [x] ${e.aceite} — ${e.evidencia}`),
      '',
      `**Toca (derivado do diff):** ${esc.derivado.join(', ') || 'nada do vocabulário'}`,
      esc.nao_classificados.length ? `**Não classificados:** ${esc.nao_classificados.join(', ')}` : null,
      temMig ? `**Tem migração** — ensaiada com rollback pelo reviewer (${rev.migracao_ensaiada ? 'sim' : 'NÃO'}); aplicar só pelo "entrega a #N".` : null,
      '',
      '## Apurado pelo PM',
      par.achados,
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ].filter((l) => l !== null).join('\n')
    const pr = await agent(
      `Publique a branch ${br} como PR. Na raiz do repositório:\n` +
      `1. git push -u origin ${br}\n` +
      // Título e corpo vão por arquivo: nome de item com aspas, crase ou $
      // quebraria a linha de comando.
      `2. Grave o TÍTULO abaixo, exatamente, em .superpowers/fila/pr-${c.id}-titulo.txt e o CORPO em .superpowers/fila/pr-${c.id}.md. Rode:\n` +
      `   gh pr create --base master --head ${br} --title "$(cat .superpowers/fila/pr-${c.id}-titulo.txt)" --body-file .superpowers/fila/pr-${c.id}.md --label fila${temMig ? ' --label "tem migração"' : ''}\n` +
      '3. gh pr checks <numero> --watch --fail-fast. Se ele responder que nenhum check apareceu ainda, espere 20 s e repita, por até 5 minutos: check que ainda não apareceu não é vermelho. ' +
      'Devolva ci "verde" se todos passaram, ou "vermelho" com o check que falhou em detalhe.\n' +
      'Nunca faça merge.\n\nTÍTULO:\n' + titulo + '\n\nCORPO:\n' + corpo,
      { schema: PR, label: `${c.id} · PR`, phase: 'Itens', effort: 'low' })
    if (!pr) { falha('abrir a PR morreu', 'sem retorno', { worktree: wt }); break }
    if (pr.ci !== 'verde') { falha(`CI vermelho na #${pr.numero}`, pr.detalhe, { pr: pr.numero, url: pr.url, worktree: wt }); break }
    prs++
    const reg = { id: c.id, resultado: 'PR verde', pr: pr.numero, url: pr.url, migracao: temMig, worktree: wt }

    // 6. degrau 2: a regra é do tools/fila.mjs, não de um agente
    if (DEGRAU === 2) {
      const ctx = JSON.stringify({ degrau: 2, derivado: esc.derivado, nao_classificados: esc.nao_classificados, aprovou_de_primeira: dePrimeira })
      const d2 = await agent(`Na raiz do repositório, grave o JSON abaixo, exatamente, em .superpowers/fila/d2-${c.id}.json e rode:\n` +
        `  node tools/fila.mjs --ref origin/master degrau2 ${c.id} < .superpowers/fila/d2-${c.id}.json\n` +
        `Devolva ok e motivos exatamente como impressos.\n\nJSON:\n${ctx}`,
        { schema: D2, label: `${c.id} · degrau 2`, phase: 'Itens', effort: 'low' })
      if (d2 && d2.ok) {
        const ent = await agent(`Veio do degrau 2: entregue a PR #${pr.numero} (item ${c.id}). Siga as suas instruções.`,
          { agentType: 'entrega-financas', schema: ENTREGA, label: `${c.id} · entrega`, phase: 'Itens' })
        if (!ent || !ent.entregue) { falha('entrega do degrau 2 parou', ent ? ent.verificacao : 'agente morreu', { pr: pr.numero, url: pr.url }); break }
        reg.resultado = 'entregue (degrau 2)'
        reg.motivo = `${ent.deploy} · ${ent.verificacao}`
      } else {
        reg.degrau2 = d2 ? d2.motivos : ['a conferência do degrau 2 morreu']
      }
    }
    registrar(reg)
  }
}

phase('Relatório')
const linhas = [`# Rodada da fila — ${DATA}`, '', `Degrau ${DEGRAU} · limite ${LIMITE}${ENSAIO ? ' · **ENSAIO**' : ''}`, '']
if (parou) linhas.push(`**Parou:** ${parou}`, '')
if (pre && pre.em_pr.length) linhas.push(`**Já em PR:** ${pre.em_pr.join(', ')}`, '')
if (pre && pre.bloqueados.length) linhas.push('**Bloqueados:**', ...pre.bloqueados.map((b) => `- ${b.id}: ${b.motivo}`), '')
for (const r of resultados) {
  linhas.push(`## ${r.id} — ${r.resultado}`)
  if (r.pr) linhas.push(`PR #${r.pr} ${r.url || ''}${r.migracao ? ' · **tem migração** (entrega a #N)' : ''}`)
  if (r.degrau2) linhas.push(`Degrau 2 não se aplicou: ${r.degrau2.join('; ')}`)
  if (r.motivo) linhas.push(`**Motivo:** ${r.motivo}`)
  if (r.worktree) linhas.push(`Worktree: \`${r.worktree}\``)
  if (r.achados) linhas.push('', '**Apurado pelo PM:**', '', r.achados)
  if (r.aceite) linhas.push('', '**Aceite como seria conferido:**', lista(r.aceite))
  linhas.push('')
}
if (!resultados.length && !parou) linhas.push('Nenhum item pronto para pegar.')
const relatorio = linhas.join('\n')
const arq = await agent(
  `Grave o texto abaixo, exatamente, em .superpowers/fila/${DATA}.md (crie a pasta se faltar; se o arquivo já existir, use ${DATA}-2.md, -3 e assim por diante). Devolva o caminho.\n\n${relatorio}`,
  { schema: ARQ, label: 'relatório', phase: 'Relatório', effort: 'low' })
return { parou, prs, resultados, relatorio, arquivo: arq ? arq.caminho : null }
