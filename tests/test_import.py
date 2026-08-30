from tools.import_planilha import (
    corrigir_mojibake, natureza_de, esfera_de, subs_recorrentes, montar_import,
)

def test_corrige_mojibake():
    # cenário real: "Educação" em UTF-8 lido como latin1 vira "EducaÃ§Ã£o";
    # corrigir_mojibake deve reverter isso.
    mojibake = "EducaÃ§Ã£o"
    assert corrigir_mojibake(mojibake) == "Educação"
    assert corrigir_mojibake(mojibake) != mojibake  # confirma que mudou
    # UTF-8 já correto permanece igual
    assert corrigir_mojibake("Educação") == "Educação"
    # entrada com caractere de substituição (ilegível) volta inalterada, sem quebrar
    assert corrigir_mojibake("Test�") == "Test�"

def test_natureza():
    assert natureza_de("Receita", 100) == "receita"
    assert natureza_de("Casa", -50) == "despesa"

def test_esfera():
    assert esfera_de("Empresa") == "empresa"
    assert esfera_de("Casa") == "pessoal"

def test_subs_recorrentes_respeita_limiar():
    gastos = ["Limpeza", "Limpeza", "Limpeza", "Cama nova", "Luz", "Luz"]
    assert subs_recorrentes(gastos, 3) == {"Limpeza"}
    assert subs_recorrentes(gastos, 2) == {"Limpeza", "Luz"}

def test_montar_import_mapeia_e_preserva_descricao():
    rows = [
        {"Tipo": "Casa", "Gasto": "Limpeza", "Pessoa": None, "Data": "2026-01-10",
         "ValorTotal": 170, "ValorReembolso": 0, "ValorFinal": -170},
        {"Tipo": "Casa", "Gasto": "Limpeza", "Pessoa": None, "Data": "2026-01-17",
         "ValorTotal": 170, "ValorReembolso": 0, "ValorFinal": -170},
        {"Tipo": "Casa", "Gasto": "Limpeza", "Pessoa": None, "Data": "2026-01-24",
         "ValorTotal": 170, "ValorReembolso": 0, "ValorFinal": -170},
        {"Tipo": "Compra", "Gasto": "Cama nova", "Pessoa": None, "Data": "2026-02-01",
         "ValorTotal": 2000, "ValorReembolso": 0, "ValorFinal": -2000},
    ]
    txs, cats, rel = montar_import(rows, min_ocorrencias=3)
    # Limpeza recorrente -> vira sub; Cama nova -> sub None, mas descricao preservada
    limpeza = [t for t in txs if t["descricao"] == "Limpeza"][0]
    cama = [t for t in txs if t["descricao"] == "Cama nova"][0]
    assert limpeza["sub"] == "Limpeza"
    assert limpeza["macro"] == "Casa"
    assert cama["sub"] is None
    assert cama["descricao"] == "Cama nova"
    assert all(t["fonte"] == "importacao" for t in txs)
    assert {"macro": "Casa", "sub": "Limpeza"} in cats
    assert rel["n_transacoes"] == 4
