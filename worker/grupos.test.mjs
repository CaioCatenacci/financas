import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escolherRepresentante, decidirAgrupar, decidirRepresentar, decidirTirar, decidirDesagrupar,
  podeApagar, valoresDiferem,
} from "./grupos.js";

// fixture: lançamento do Caio (manual), foto, e a linha do extrato que duplica o aluguel
const manual  = { id: "m1", fonte: "manual",  criado_em: "2026-09-02T10:00:00Z", grupo_id: null, representante: false, valor_final: "2500.00" };
const foto    = { id: "f1", fonte: "imagem",  criado_em: "2026-09-01T09:00:00Z", grupo_id: null, representante: false, valor_final: "2500.00" };
const extrato = { id: "e1", fonte: "extrato", criado_em: "2026-09-30T20:00:00Z", grupo_id: null, representante: false, valor_final: "2500.00" };
const extrato2 = { id: "e2", fonte: "extrato", criado_em: "2026-09-30T20:01:00Z", grupo_id: null, representante: false, valor_final: "2500.00" };

test("escolherRepresentante: prefere quem não veio do banco; empate → o mais antigo", () => {
  // a foto é mais antiga que o manual → representa; o extrato nunca ganha de um lançamento do Caio
  assert.equal(escolherRepresentante([extrato, manual, foto]).id, "f1");
  assert.equal(escolherRepresentante([extrato, manual]).id, "m1");
});

test("escolherRepresentante: só linhas do banco → a mais antiga", () => {
  assert.equal(escolherRepresentante([extrato2, extrato]).id, "e1");
});

test("escolherRepresentante: criado_em como Date objects (driver Neon) — pega o cronologicamente mais antigo", () => {
  // O driver Neon devolve Date objects. String(Date) não é cronologicamente ordenável:
  // "Wed Oct 01 …" < "Wed Sep 02 …" lexicograficamente, mas Oct é depois. Precisa comparar .getTime().
  const set1 = [
    { ...manual, criado_em: new Date("2026-10-01T09:00:00Z") },
    { ...foto, criado_em: new Date("2026-09-02T10:00:00Z") },
  ];
  // Foto é setembro, mais antiga → deve representar (manual é não-banco, mas foto é anterior)
  assert.equal(escolherRepresentante(set1).id, "f1");

  // Só banco: mais antigo (set a setembro) deve ganhar
  const set2 = [
    { ...extrato, criado_em: new Date("2026-10-01T20:00:00Z") },
    { ...extrato2, criado_em: new Date("2026-09-30T20:00:00Z") },
  ];
  assert.equal(escolherRepresentante(set2).id, "e2");
});

test("escolherRepresentante: misto (string ISO + Date objects) — compara cronologicamente", () => {
  // O driver pode devolver um misto num mesmo grupo (p.ex. uma linha vem do app, outra do db).
  // A comparação precisa funcionar misturado.
  const misto = [
    { ...manual, criado_em: "2026-10-01T09:00:00Z" },           // string ISO (outubro)
    { ...foto, criado_em: new Date("2026-09-02T10:00:00Z") },   // Date object (setembro)
  ];
  // Foto é setembro, mais antiga
  assert.equal(escolherRepresentante(misto).id, "f1");
});

test("decidirAgrupar: nenhuma em grupo → grupo novo, representante não-extrato, todas com grupo_id", () => {
  const d = decidirAgrupar([extrato, manual], "G1");
  assert.equal(d.ok, true);
  assert.equal(d.grupo_id, "G1");
  assert.equal(d.representante_id, "m1");
  assert.deepEqual(d.mudancas, [
    { id: "e1", grupo_id: "G1", representante: false },
    { id: "m1", grupo_id: "G1", representante: true },
  ]);
});

test("decidirAgrupar: uma já em grupo → as soltas entram nele e o representante NÃO muda", () => {
  const rep = { ...manual, grupo_id: "G0", representante: true };
  const d = decidirAgrupar([rep, extrato], "G-novo-ignorado");
  assert.equal(d.ok, true);
  assert.equal(d.grupo_id, "G0");
  assert.equal(d.representante_id, "m1");
  // só a linha solta muda; a que já estava no grupo não aparece nas mudanças
  assert.deepEqual(d.mudancas, [{ id: "e1", grupo_id: "G0", representante: false }]);
});

test("decidirAgrupar: linhas de dois grupos diferentes → erro 'desagrupe antes'", () => {
  const a = { ...manual, grupo_id: "G0", representante: true };
  const b = { ...extrato, grupo_id: "G9", representante: true };
  const d = decidirAgrupar([a, b], "Gx");
  assert.equal(d.ok, false);
  assert.match(d.erro, /desagrupe antes/i);
});

test("decidirAgrupar: todas já no mesmo grupo → erro (nada a fazer)", () => {
  const a = { ...manual, grupo_id: "G0", representante: true };
  const b = { ...extrato, grupo_id: "G0" };
  const d = decidirAgrupar([a, b], "Gx");
  assert.equal(d.ok, false);
  assert.match(d.erro, /já estão no mesmo grupo/i);
});

test("decidirAgrupar: menos de 2 linhas → erro", () => {
  assert.equal(decidirAgrupar([manual], "G1").ok, false);
  assert.equal(decidirAgrupar([], "G1").ok, false);
});

// F2: entrar num grupo que não tem representante deixaria mais uma linha num grupo em que
// ninguém conta no Resumo. A checagem olha TODOS os membros do grupo (terceiro parâmetro), não
// só os selecionados — senão um representante que ficou fora da seleção daria recusa falsa.
test("decidirAgrupar: grupo existente sem representante → recusa 'o grupo não tem representante'", () => {
  const membroSemRep = { ...manual, grupo_id: "G0", representante: false };
  const membros = [membroSemRep, { ...foto, grupo_id: "G0", representante: false }];
  const d = decidirAgrupar([membroSemRep, extrato], "Gx", membros);
  assert.deepEqual(d, { ok: false, erro: "o grupo não tem representante" });
});

test("decidirAgrupar: representante do grupo fora da seleção segue aceito (olha todos os membros)", () => {
  const membroComum = { ...foto, grupo_id: "G0", representante: false };
  const rep = { ...manual, grupo_id: "G0", representante: true };
  const d = decidirAgrupar([membroComum, extrato], "Gx", [rep, membroComum]);
  assert.equal(d.ok, true);
  assert.equal(d.grupo_id, "G0");
  assert.equal(d.representante_id, "m1");
  assert.deepEqual(d.mudancas, [{ id: "e1", grupo_id: "G0", representante: false }]);
});

test("decidirRepresentar: troca atômica — tira do atual ANTES de pôr no novo (índice único)", () => {
  const membros = [
    { ...manual, grupo_id: "G0", representante: true },
    { ...extrato, grupo_id: "G0" },
  ];
  const d = decidirRepresentar(membros, "e1");
  assert.equal(d.ok, true);
  assert.deepEqual(d.mudancas, [
    { id: "m1", grupo_id: "G0", representante: false },
    { id: "e1", grupo_id: "G0", representante: true },
  ]);
});

test("decidirRepresentar: id fora do grupo → erro; já é o representante → sem mudanças", () => {
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  assert.equal(decidirRepresentar(membros, "zzz").ok, false);
  assert.deepEqual(decidirRepresentar(membros, "m1"), { ok: true, mudancas: [] });
});

test("decidirTirar: membro comum sai; sobrando 1, o grupo dissolve (o que sobrou também limpa)", () => {
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  const d = decidirTirar(membros, "e1");
  assert.equal(d.ok, true);
  assert.equal(d.dissolveu, true);
  assert.deepEqual(d.mudancas, [
    { id: "e1", grupo_id: null, representante: false },
    { id: "m1", grupo_id: null, representante: false },
  ]);
});

test("decidirTirar: com 3 membros, tirar um não dissolve", () => {
  const membros = [
    { ...manual, grupo_id: "G0", representante: true },
    { ...extrato, grupo_id: "G0" },
    { ...extrato2, grupo_id: "G0" },
  ];
  const d = decidirTirar(membros, "e2");
  assert.equal(d.dissolveu, false);
  assert.deepEqual(d.mudancas, [{ id: "e2", grupo_id: null, representante: false }]);
});

test("decidirTirar: tirar o representante com outros membros → erro; id fora do grupo → erro", () => {
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  const d = decidirTirar(membros, "m1");
  assert.equal(d.ok, false);
  assert.match(d.erro, /escolha outro representante/i);
  assert.equal(decidirTirar(membros, "nao-existe").ok, false);
});

test("decidirDesagrupar: limpa grupo_id e representante de todos", () => {
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  assert.deepEqual(decidirDesagrupar(membros), { ok: true, mudancas: [
    { id: "m1", grupo_id: null, representante: false },
    { id: "e1", grupo_id: null, representante: false },
  ] });
});

test("podeApagar: sem grupo → ok sem mudanças; representante com outros membros → erro", () => {
  assert.deepEqual(podeApagar([], "m1"), { ok: true, mudancas: [] });
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  const d = podeApagar(membros, "m1");
  assert.equal(d.ok, false);
  assert.match(d.erro, /escolha outro representante/i);
});

test("podeApagar: membro comum → ok; se sobra 1, o que sobrou limpa o grupo", () => {
  const membros = [{ ...manual, grupo_id: "G0", representante: true }, { ...extrato, grupo_id: "G0" }];
  assert.deepEqual(podeApagar(membros, "e1"), { ok: true, mudancas: [{ id: "m1", grupo_id: null, representante: false }] });
});

test("valoresDiferem: acusa 56.200 vs 36.200 e não acusa valores iguais (string ou número)", () => {
  const rep = { ...manual, valor_final: "36200.00" };
  assert.equal(valoresDiferem(rep, [{ ...extrato, valor_final: "56200.00" }]), true);
  assert.equal(valoresDiferem(rep, [{ ...extrato, valor_final: 36200 }]), false);
  assert.equal(valoresDiferem(rep, []), false);
});
