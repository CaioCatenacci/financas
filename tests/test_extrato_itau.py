from tools.extrato_itau import parse_extrato, conferir_checksum

TEXTO = """10/12/2025 SALDO DO DIA 38.681,68
10/12/2025 PIX QRS MAGALUPAY10/12 -194,78
10/12/2025 PIX TRANSF CAIO CA10/12 30.000,00
09/12/2025 SALDO DO DIA 8.876,46
09/12/2025 PIX TRANSF QUINTOA09/12 0,01
"""

def test_ignora_saldo_do_dia_e_parseia_linhas():
    r = parse_extrato(TEXTO)
    descr = [l["descricao"] for l in r["linhas"]]
    assert "SALDO DO DIA" not in descr
    assert len(r["linhas"]) == 3

def test_sinal_define_natureza_e_valor_em_cents():
    r = parse_extrato(TEXTO)
    saida = next(l for l in r["linhas"] if "MAGALUPAY" in l["descricao"])
    assert saida["valor_cents"] == 19478 and saida["natureza"] == "despesa"
    entrada = next(l for l in r["linhas"] if "CAIO CA" in l["descricao"])
    assert entrada["valor_cents"] == 3000000 and entrada["natureza"] == "receita"

def test_data_iso_e_ordinal_por_dia():
    r = parse_extrato(TEXTO)
    d10 = [l for l in r["linhas"] if l["data"] == "2025-12-10"]
    assert [l["ordinal"] for l in d10] == [0, 1]   # ordem de aparição no dia

def test_checksum_bate():
    r = parse_extrato(TEXTO)
    # saldos: 09/12=8.876,46 → 10/12=38.681,68 ; soma dos lançamentos de 10/12 = -194,78+30.000,00 = 29.805,22
    # (o intervalo do checksum é entre SALDOs consecutivos)
    c = conferir_checksum(r["linhas"], r["saldos"])
    assert c["ok"] is True

def test_checksum_detecta_diferenca():
    r = parse_extrato(TEXTO)
    r["linhas"][0]["valor_cents"] += 100   # corrompe
    c = conferir_checksum(r["linhas"], r["saldos"])
    assert c["ok"] is False and c["diferenca_cents"] != 0

def test_checksum_atribui_por_intervalo():
    # Testa atribuição por INTERVALO: há lançamentos em datas SEM "SALDO DO DIA"
    # próprio, mas que caem no intervalo (prev_date, cur_date]. Anteriormente isso
    # causaria queda falsa de checksum.
    # Cenário: saldos 2025-01-01 (100,00) e 2025-01-03 (70,00);
    # lançamentos: 2025-01-02 (-20,00) e 2025-01-03 (-10,00).
    # Delta esperado = 70,00 - 100,00 = -30,00 = (-20,00) + (-10,00) ✓
    texto_intervalo = """01/01/2025 SALDO DO DIA 100,00
02/01/2025 COMPRA -20,00
03/01/2025 COMPRA -10,00
03/01/2025 SALDO DO DIA 70,00
"""
    r = parse_extrato(texto_intervalo)
    c = conferir_checksum(r["linhas"], r["saldos"])
    assert c["ok"] is True, f"Checksum deveria passar com atribuição por intervalo, mas dif={c['diferenca_cents']}"

def test_checksum_ignora_saldo_de_emissao():
    # Testa que saldos datados APÓS o último lançamento (ex.: "saldo do dia" da
    # data de emissão) são ignorados, pois não há transações nesse intervalo.
    # Cenário: lançamentos até 2025-01-03; saldo fictício em 2025-09-03 (data de
    # emissão do extrato). Esse último saldo é descartado e checksum segue ok.
    texto_emissao = """01/01/2025 SALDO DO DIA 100,00
02/01/2025 COMPRA -20,00
03/01/2025 COMPRA -10,00
03/01/2025 SALDO DO DIA 70,00
03/09/2025 SALDO DO DIA 65,50
"""
    r = parse_extrato(texto_emissao)
    c = conferir_checksum(r["linhas"], r["saldos"])
    assert c["ok"] is True, f"Checksum deveria ignorar saldo de emissão, mas dif={c['diferenca_cents']}"
