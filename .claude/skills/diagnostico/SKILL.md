---
name: diagnostico
description: Escreve e grava o diagnóstico mensal do financas (G3). Use quando o Caio disser "roda o diagnóstico de <mês>", "diagnóstico de setembro", "atualiza o diagnóstico" ou parecido. Lê o banco e o app no ar, escreve o texto no roteiro fixo de 6 seções e grava na tabela `diagnosticos` pelo tools/db.py, com ensaio antes.
---

# Diagnóstico mensal

O texto é opinativo: diz o que os números significam e o que fazer. O app só guarda e mostra
(aba Diagnóstico). Roteiro e porquê: `CONTEXTO.md` §20.

## 1. Conferir se o mês está fechado

`node tools/app.mjs "api/fechamento?ate=<AAAA-MM>"` — se o mês não estiver `fechado`, diga ao Caio
o que falta (fonte e até que dia) e pergunte se escreve assim mesmo. O app já mostra "mês parcial".

## 2. Levantar os números (só leitura)

- Saldo: `node tools/app.mjs "api/saldo-mensal?ate=<AAAA-MM>"` (receita, despesa, saldo, `estimado`).
- Orçamento: `node tools/app.mjs "api/metas?mes=<AAAA-MM>"` (alvo × realizado por categoria).
- Por categoria, o mês contra o anterior e a média dos 3 anteriores, e os maiores lançamentos:
  `python tools/db.py select "<consulta>"`, sempre filtrando `conta_no_resumo` (nunca `computa_resumo`).
- Pendências: categoria padrão (`categorias.padrao`), lançamentos grandes sem explicação.

## 3. Escrever no roteiro fixo, nesta ordem

1. `## 1. Fechou no azul?` — saldo do mês contra a média dos 3 anteriores; selo de estimado se for.
2. `## 2. O que puxou o gasto` — categorias que mais pesaram e as que mais cresceram, com a causa.
3. `## 3. O que estourou o orçamento` — tabela categoria × alvo × realizado; alvo irreal é achado.
4. `## 4. Oportunidades de economia` — onde cortar, com o valor por mês; separe escolha de prioridade
   (saúde, escola) de desperdício.
5. `## 5. Pendências do fechamento` — o que falta importar, sem categoria, lançamento estranho.
6. `## 6. O caminho da casa` — contribuição do mês para a meta (quando A2/G4 existirem).

Markdown simples (o app renderiza `##`, parágrafo, lista `-` e `**negrito**`; tabela markdown aparece como texto cru — use lista). Valores
em R$ arredondados a mil (R$ 7,1 mil). Opine: recomendação, não só descrição.

## 4. Gravar

O texto tem valores reais, então **nunca** vai para o repositório. Escreva em
`dados/diag_<AAAA-MM>.sql` (ignorado pelo git):

```sql
insert into diagnosticos (mes, texto) values ('<AAAA-MM>', $diag$<texto>$diag$)
on conflict (mes) do update set texto = excluded.texto, atualizado_em = now();
```

Depois `python tools/db.py ensaiar dados/diag_<AAAA-MM>.sql --consulta "select mes, length(texto) from diagnosticos where mes='<AAAA-MM>'"`,
e só então `python tools/db.py aplicar dados/diag_<AAAA-MM>.sql`. Confira com
`node tools/app.mjs "api/diagnostico?mes=<AAAA-MM>"` e mostre ao Caio o resumo do texto no chat.
