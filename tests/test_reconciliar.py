from tools.reconciliar import linha_hash, reconciliar_linha

def test_linha_hash_estavel_e_sensivel():
    h1 = linha_hash("011638-2", "2025-12-10", "PIX QRS X10/12", 19478, 0)
    h2 = linha_hash("011638-2", "2025-12-10", "PIX QRS X10/12", 19478, 0)
    h3 = linha_hash("011638-2", "2025-12-10", "PIX QRS X10/12", 19478, 1)  # ordinal difere
    assert h1 == h2 and h1 != h3

def test_casa_um_candidato_na_janela():
    linha = {"data": "2025-12-10", "valor_cents": 19478}
    ex = [{"id": "t1", "data": "2025-12-11", "valor_cents": 19478}]  # 1 dia de diferença
    r = reconciliar_linha(linha, ex)
    assert r["status"] == "casado" and r["match_id"] == "t1"

def test_ambiguo_com_dois_candidatos():
    linha = {"data": "2025-12-10", "valor_cents": 5000}
    ex = [{"id": "a", "data": "2025-12-10", "valor_cents": 5000},
          {"id": "b", "data": "2025-12-12", "valor_cents": 5000}]
    assert reconciliar_linha(linha, ex)["status"] == "ambiguo"

def test_novo_quando_fora_da_janela_ou_valor_diferente():
    linha = {"data": "2025-12-10", "valor_cents": 5000}
    ex = [{"id": "a", "data": "2025-12-20", "valor_cents": 5000},   # fora da janela
          {"id": "b", "data": "2025-12-10", "valor_cents": 9999}]   # valor diferente
    assert reconciliar_linha(linha, ex)["status"] == "novo"
