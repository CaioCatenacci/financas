# fila/ — um arquivo por item do backlog

A fonte da fila autônoma. A rodada lê esta pasta pelo `tools/fila.mjs`, sempre de
`origin/master`. Ver `docs/superpowers/specs/2026-09-26-fila-autonoma-receita.md`.

- Um `<id>.md` por item aberto, no formato do [`_modelo.md`](_modelo.md): sete seções
  fixas, nesta ordem.
- A ordem mora no [`ORDEM.md`](ORDEM.md), em três faixas (Agora, Próximo, Depois); só a
  faixa Agora tem ordem exata, e é a ordem da rodada.
- O histórico dos entregues mora no `feitos.js`, escrito só por
  `node tools/fila.mjs concluir <id> "<meta>"`. Não se edita à mão.
- No Obsidian, edite as listas do frontmatter no texto (`exige: [B2]`): o painel de
  Propriedades as regrava em bloco, e o `checar` recusa.
- **O repositório é público.** Nada de valor real, contraparte, chave Pix ou comprovante
  aqui: exemplos com números inventados.
- Ideia ainda sem card fica no `BACKLOG.md`; quando vira card aqui, a linha sai de lá.
