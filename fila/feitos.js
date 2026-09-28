// fila/feitos.js — itens entregues. Histórico: não se edita à mão;
// `node tools/fila.mjs concluir <id> "<meta>"` acrescenta o item que a PR entrega.
const ITENS = [
  {"id":"E5","camada":0,"e":"feito","quem":"feito","nome":"Branch redesign-dashboard: apagar","meta":"entregue 27/09 · branch redesign-dashboard apagada (já estava mergeada)","desc":"A branch local `redesign-dashboard` continua existindo. Apurado em 26/09: ela não tem nenhum commit que não esteja no master (já foi mergeada). Menos ruído na lista de branches.","exige":[],"destrava":[]},
  {"id":"F3","camada":0,"e":"feito","quem":"feito","nome":"Entrada malformada nas rotas de grupo vira 500","meta":"entregue 28/09 · rotas /api/grupos respondem 400 para id não-uuid e ids não-lista (ehUuid em worker/validar.js)","desc":"Id que não é uuid ou `ids` que não é lista nas rotas `/api/grupos` estoura no cast do SQL e responde 500. Erro de entrada responde 400 com mensagem, não 500.","exige":[],"destrava":[]}
];
