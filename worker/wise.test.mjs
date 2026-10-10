// G1: CSV da conta em USD da Wise. Cabeçalho real do export; ids, datas e valores inventados.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseWiseCsv, parseCsv, centsUS, hashWise } from "./wise.js";

const CAB = '"TransferWise ID",Date,"Date Time",Amount,Currency,Description,"Payment Reference","Running Balance","Exchange From","Exchange To","Exchange Rate","Payer Name","Payee Name","Payee Account Number",Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,"Total fees","Exchange To Amount","Transaction Type","Transaction Details Type"';

// uma linha de cada tipo que o export traz: depósito (entrada em USD), conversão USD→BRL, transferência
const DEPOSIT = 'BALANCE-111,04-08-2026,"04-08-2026 09:00:00.000",8000.00,USD,"Received money",,8000.00,,,,"Empresa Exemplo",,,,,,,,0.00,,CREDIT,DEPOSIT';
const CONV1 = 'BALANCE-222,04-08-2026,"04-08-2026 10:00:00.000",-8000.00,USD,"Converted USD to BRL",,0.00,USD,BRL,5.00000,,,,,,,,,12.34,40000.00,DEBIT,CONVERSION';
const CONV2 = 'BALANCE-333,14-08-2026,"14-08-2026 10:00:00.000",-5000.00,USD,"Converted USD to BRL",,0.00,USD,BRL,5.20000,,,,,,,,,8.00,26000.00,DEBIT,CONVERSION';
const TRANSFER = 'TRANSFER-444,18-08-2026,"18-08-2026 12:00:00.000",-100.00,USD,"Sent money to Alguém",,0.00,,,,,"Alguém",,,,,,,1.00,,DEBIT,TRANSFER';
const CONV_EUR = 'BALANCE-555,20-08-2026,"20-08-2026 10:00:00.000",-100.00,USD,"Converted USD to EUR",,0.00,USD,EUR,0.90000,,,,,,,,,1.00,90.00,DEBIT,CONVERSION';

const CSV = [CAB, DEPOSIT, CONV1, CONV2, TRANSFER, CONV_EUR].join("\r\n") + "\r\n";

test("parseWiseCsv: só as conversões USD→BRL viram conversões; DEPOSIT, TRANSFER e outra moeda são ignorados", () => {
  const r = parseWiseCsv(CSV);
  assert.equal(r.conversoes.length, 2);
  assert.equal(r.ignoradas, 3);
  assert.deepEqual(r.erros, []);
});

test("parseWiseCsv: usd_cents = |Amount|, brl_cents = Exchange To Amount, taxa = Exchange Rate, data em ISO", () => {
  const [c1, c2] = parseWiseCsv(CSV).conversoes;
  assert.deepEqual([c1.data, c1.usd_cents, c1.brl_cents, c1.taxa], ["2026-08-04", 800000, 4000000, 5]);
  assert.deepEqual([c2.data, c2.usd_cents, c2.brl_cents, c2.taxa], ["2026-08-14", 500000, 2600000, 5.2]);
});

test("parseWiseCsv: linha_hash = sha256 do TransferWise ID (reimportar o mesmo CSV gera a mesma chave)", () => {
  const [c1] = parseWiseCsv(CSV).conversoes;
  assert.equal(c1.linhaHash, createHash("sha256").update("BALANCE-222").digest("hex"));
  assert.equal(hashWise("BALANCE-222"), c1.linhaHash);
  assert.equal(parseWiseCsv(CSV).conversoes[0].linhaHash, c1.linhaHash);
});

test("parseWiseCsv: BOM e CRLF do export do Windows não atrapalham; CSV sem as colunas dá erro, não exceção", () => {
  assert.equal(parseWiseCsv("﻿" + CSV).conversoes.length, 2);
  const r = parseWiseCsv("a,b\n1,2\n");
  assert.equal(r.conversoes.length, 0);
  assert.match(r.erros[0], /colunas/);
  assert.equal(parseWiseCsv("").conversoes.length, 0);
});

test("parseCsv: campo entre aspas com vírgula e aspas dobradas", () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""e"""\n1,2,3'), [["a", "b, c", 'd "e"'], ["1", "2", "3"]]);
});

test("centsUS: formato americano (ponto decimal, sem milhar), em módulo — não é parseBRtoCents de propósito", () => {
  assert.equal(centsUS("-8000.00"), 800000);
  assert.equal(centsUS("40000.00"), 4000000);
  assert.equal(centsUS("5.125"), 513);
  assert.equal(centsUS(""), null);
  assert.equal(centsUS("1,000.00"), null);
});
