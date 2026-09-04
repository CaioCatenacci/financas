from tools.classificar_linha import normalizar_descritor, reconhecer_nao_gasto, classificar
from tools.contraparte import normalizar_nome

def test_normaliza_colapsa_mesmo_estabelecimento_entre_meses():
    a = normalizar_descritor("PIX QRS AMAZON.COM.30/12")
    b = normalizar_descritor("PIX QRS AMAZON.COM.28/11")
    assert a == b and "amazon" in a and "30/12" not in a

def test_reconhece_nao_gasto():
    assert reconhecer_nao_gasto("PIX TRANSF CAIO CA10/12") == "Transferências"
    assert reconhecer_nao_gasto("APLICACAO PERSONDIF INT") == "Investimentos"
    assert reconhecer_nao_gasto("COR COMP CDB BAN") == "Investimentos"
    assert reconhecer_nao_gasto("PIX QRS MAGALUPAY10/12") is None  # gasto normal

def test_reconhece_fatura_de_cartao():
    # Padrão: PAGAMENTO ... CARTAO ou DEB ... CARTAO
    assert reconhecer_nao_gasto("PAGAMENTO CARTAO 7857") == "Fatura de cartão"
    assert reconhecer_nao_gasto("PAGAMENTO FATURA CARTAO 2024") == "Fatura de cartão"
    assert reconhecer_nao_gasto("DEB CARTAO FATURA") == "Fatura de cartão"

def test_classificar_nao_gasto_marca_flag_e_categoria_org():
    r = classificar("PIX TRANSF CAIO CA10/12", catalogo={}, associacoes={})
    assert r["computa_resumo"] is False and r["categoria_org"] == "Transferências"

def test_classificar_gasto_usa_associacao_aprendida():
    # Fixture usa normalizar_nome (uppercase) para casar a chave da tabela
    assoc = {normalizar_nome(normalizar_descritor("PIX QRS MAGALUPAY10/12")): {"categoria_nome": "Casa", "sub_nome": "Mercado"}}
    r = classificar("PIX QRS MAGALUPAY10/12", catalogo={}, associacoes=assoc)
    assert r["computa_resumo"] is True
    assert r["categoria_nome"] == "Casa" and r["sub_nome"] == "Mercado"
    assert "magalupay" in r["contraparte_nome"]

def test_classificar_gasto_sem_associacao_fica_none():
    r = classificar("PIX QRS DESCONHECIDO01/01", catalogo={}, associacoes={})
    assert r["computa_resumo"] is True and r["categoria_nome"] is None
