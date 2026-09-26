"""Testes da resolução nome→id dos tools (espelha worker/categorias.test.mjs)."""
from tools.categorias import resolver_categoria

CATALOGO = {
    "categorias": [
        {"id": "cE", "nome": "Educação"},
        {"id": "cS", "nome": "Saúde"},
        {"id": "cO", "nome": "Outros"},
    ],
    "subcategorias": [
        {"id": "sEsc", "categoria_id": "cE", "nome": "Escola"},
        {"id": "sPla", "categoria_id": "cS", "nome": "Plano de saúde"},
    ],
}


def test_categoria_e_sub_existentes():
    assert resolver_categoria("Educação", "Escola", CATALOGO) == ("cE", "sEsc")


def test_sub_inexistente_vira_none():
    assert resolver_categoria("Educação", "Inexistente", CATALOGO) == ("cE", None)


def test_sub_vazia_vira_none():
    assert resolver_categoria("Saúde", None, CATALOGO) == ("cS", None)


def test_macro_inexistente_cai_em_outros():
    assert resolver_categoria("Marte", "Foguete", CATALOGO) == ("cO", None)


def test_sub_nao_vaza_entre_categorias():
    # "Plano de saúde" é de Saúde; pedir sob Educação não casa
    assert resolver_categoria("Educação", "Plano de saúde", CATALOGO) == ("cE", None)


def test_sem_outros_e_macro_inexistente_vira_none():
    cat = {"categorias": [{"id": "cE", "nome": "Educação"}], "subcategorias": []}
    assert resolver_categoria("Marte", None, cat) == (None, None)


# Categoria padrão por FLAG, não por nome (bug de 25/09/2026: "Outros" renomeada quebrou o fallback).
CATALOGO_PADRAO = {
    "categorias": [
        {"id": "cE", "nome": "Educação", "padrao": False},
        {"id": "cO", "nome": "Outros", "padrao": False},
        {"id": "cNI", "nome": "Não Identificado", "padrao": True},
    ],
    "subcategorias": [],
}


def test_macro_inexistente_ou_nula_cai_na_padrao_por_flag_nao_em_outros():
    assert resolver_categoria("Marte", None, CATALOGO_PADRAO) == ("cNI", None)
    assert resolver_categoria(None, None, CATALOGO_PADRAO) == ("cNI", None)


def test_outros_explicito_resolve_outros():
    assert resolver_categoria("Outros", None, CATALOGO_PADRAO) == ("cO", None)
