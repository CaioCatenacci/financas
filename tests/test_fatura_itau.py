from tools.fatura_itau import parse_fatura

# Layout-style: colunas alinhadas por espaços (como o pypdf devolve em extraction_mode="layout"),
# não uma linha "limpa" por item — é assim que a fatura real do Itaú sai.
TEXTO = """                          Lançamentos: compras e saques
                          DATA       ESTABELECIMENTO                                   VALOR EM R$
                          29/05      PARK E CO. ESTACIONAME                                      17,00
                          03/05      LOJA XPTO PARCELA 03/10                                     150,00
                          Lançamentos no cartão (final 7857)                                     167,00
                      L   Total dos lançamentos atuais                                           167,00
"""


def test_parseia_itens_com_ano_do_periodo():
    r = parse_fatura(TEXTO, ano=2025)
    assert r["itens"][0]["data"] == "2025-05-29"
    assert r["itens"][0]["valor_cents"] == 1700


def test_captura_parcela():
    r = parse_fatura(TEXTO, ano=2025)
    parc = next(i for i in r["itens"] if "XPTO" in i["descricao"])
    assert parc["parcela"] == "03/10" and parc["valor_cents"] == 15000


def test_total():
    assert parse_fatura(TEXTO, ano=2025)["total_cents"] == 16700


def test_checksum_itens_vs_total():
    r = parse_fatura(TEXTO, ano=2025)
    assert sum(i["valor_cents"] for i in r["itens"]) == r["total_cents"]


def test_ignora_ruido_da_coluna_da_direita_apos_o_valor():
    # linha real: depois do valor do lançamento, a coluna da direita pode trazer
    # outro valor (juros etc) — tem que pegar o PRIMEIRO valor após a data, não o último.
    texto = "   29/05   PARK E CO ESTACIONAME    17,00    Juros Máximos do contrato    10,50\n"
    r = parse_fatura(texto, ano=2025)
    assert len(r["itens"]) == 1
    assert r["itens"][0]["valor_cents"] == 1700
