// fila/feitos.js — itens entregues. Histórico: não se edita à mão;
// `node tools/fila.mjs concluir <id> "<meta>"` acrescenta o item que a PR entrega.
const ITENS = [
  {"id":"E5","camada":0,"e":"feito","quem":"feito","nome":"Branch redesign-dashboard: apagar","meta":"entregue 27/09 · branch redesign-dashboard apagada (já estava mergeada)","desc":"A branch local `redesign-dashboard` continua existindo. Apurado em 26/09: ela não tem nenhum commit que não esteja no master (já foi mergeada). Menos ruído na lista de branches.","exige":[],"destrava":[]},
  {"id":"E4","camada":0,"e":"feito","quem":"feito","nome":"Docs desatualizados: roadmap, estrutura do README, seção do Inc 3","meta":"entregue 28/09 · roadmap com 1, 1.5 e 3 implementados, seção do Inc 3 no CLAUDE.md e árvore do README batendo com o repo","desc":"O roadmap do `CLAUDE.md` ainda mostra 1.5 como fast-follow e 3 como futuro, apesar de entregues. A estrutura no `README.md` cita arquivos que mudaram, e o `CLAUDE.md` não tem seção do Inc 3. Quem abre o projeto (inclusive os agentes da fila) lê o estado real.","exige":[],"destrava":[]}
];
