"""Testes de agrupamento de contrapartes por chave única."""
from tools.ensino_extrair import agrupar_por_contraparte


def test_agrupa_por_contraparte_unica():
    """Agrupa por contraparte única: mesma chave/tipo contam junto, mantém primeira sugestão."""
    rows = [
        {
            "contraparte_nome": "VIVIANE FERRER BORGATO",
            "contraparte_chave": "+5519995783408",
            "macro": "Educação",
            "sub": "Inglês Particular"
        },
        {
            "contraparte_nome": "VIVIANE FERRER BORGATO",
            "contraparte_chave": "+5519995783408",
            "macro": "Educação",
            "sub": "Inglês Particular"
        },
        {
            "contraparte_nome": "PADARIA X",
            "contraparte_chave": None,
            "macro": "Casa",
            "sub": None
        },
    ]
    g = agrupar_por_contraparte(rows)

    # Verifica Viviane (pix_cpf)
    viv = [x for x in g if x["chave"] == "5519995783408"][0]
    assert viv["tipo"] == "pix_cpf"
    assert viv["n"] == 2
    assert viv["sugestao_macro"] == "Educação"
    assert viv["sugestao_sub"] == "Inglês Particular"

    # Verifica Padaria (nome)
    assert any(
        x["tipo"] == "nome" and x["chave"] == "PADARIA X" and x["n"] == 1
        for x in g
    )
