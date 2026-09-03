"""Testes de paridade com worker/contraparte.js — normalização de contrapartes."""
from tools.contraparte import normalizar_nome, normalizar_chave, derivar_chave


def test_normalizar_nome():
    """Normaliza nome: strip, remove acentos, uppercase, colapsa espaços."""
    assert normalizar_nome("  Viviane   Ferrer  Borgato ") == "VIVIANE FERRER BORGATO"
    assert normalizar_nome("Educação") == "EDUCACAO"
    assert normalizar_nome("") is None
    assert normalizar_nome(None) is None


def test_normalizar_chave():
    """Normaliza chave: telefone/CPF → dígitos, email → minúsculas, outro → minúsculas."""
    assert normalizar_chave("+55 (19) 99578-3408") == "5519995783408"
    assert normalizar_chave("***.923.318-**") == "923318"
    assert normalizar_chave("  Fulano@Email.COM ") == "fulano@email.com"
    assert normalizar_chave("") is None
    assert normalizar_chave(None) is None


def test_derivar_chave():
    """Deriva chave: prioridade pix_cpf > nome."""
    # Com chave válida → pix_cpf
    assert derivar_chave({"contraparte_chave": "+5519995783408", "contraparte_nome": "X"}) == {
        "chave": "5519995783408",
        "tipo": "pix_cpf"
    }
    # Sem chave, com nome → nome
    assert derivar_chave({"contraparte_chave": None, "contraparte_nome": "Viviane Ferrer"}) == {
        "chave": "VIVIANE FERRER",
        "tipo": "nome"
    }
    # Sem chave nem nome → None
    assert derivar_chave({"contraparte_chave": None, "contraparte_nome": None}) is None
    # Dict vazio → None
    assert derivar_chave({}) is None
    # None → None
    assert derivar_chave(None) is None
