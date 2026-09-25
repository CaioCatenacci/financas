"""Inc 2.5 Fase B: resolução nome→id p/ os tools (import e ensino).

Espelha worker/categorias.js: o modelo/planilha traz NOMES; ao gravar, resolvemos
para ids do catálogo (fallback na categoria padrão — flag `padrao`; 'Outros' só por
compatibilidade — quando a categoria não existe).
Puro (a parte de resolução) + um helper que lê o catálogo do banco.
"""


def resolver_categoria(nome_macro, nome_sub, catalogo):
    """(nome_macro, nome_sub, catalogo) -> (categoria_id, subcategoria_id).

    catalogo = {"categorias":[{"id","nome"}], "subcategorias":[{"id","categoria_id","nome"}]}
    macro inexistente/nula cai na categoria padrão; sub que não casa dentro da categoria vira None.
    """
    cats = catalogo.get("categorias", [])
    cat = next((c for c in cats if c["nome"] == nome_macro), None)
    if cat is None:
        cat = categoria_padrao(catalogo)
    categoria_id = cat["id"] if cat else None

    subcategoria_id = None
    if categoria_id and nome_sub:
        sub = next(
            (s for s in catalogo.get("subcategorias", [])
             if s["categoria_id"] == categoria_id and s["nome"] == nome_sub),
            None,
        )
        if sub:
            subcategoria_id = sub["id"]
    return categoria_id, subcategoria_id


def categoria_padrao(catalogo):
    """Categoria com flag `padrao`; sem flag, 'Outros' por compatibilidade; senão None.

    Espelha worker/categorias.js::categoriaPadrao — o padrão é por flag porque o nome pode ser
    renomeado na aba Ajustes (foi o que quebrou o Telegram em 25/09/2026).
    """
    cats = catalogo.get("categorias", [])
    return (next((c for c in cats if c.get("padrao")), None)
            or next((c for c in cats if c["nome"] == "Outros"), None))


def carregar_catalogo(cur):
    """Lê categorias/subcategorias ativas do banco (psycopg cursor) -> dict do catálogo."""
    cur.execute("select id, nome, padrao from categorias where ativa")
    categorias = [{"id": r[0], "nome": r[1], "padrao": r[2]} for r in cur.fetchall()]
    cur.execute("select id, categoria_id, nome from subcategorias where ativa")
    subcategorias = [{"id": r[0], "categoria_id": r[1], "nome": r[2]} for r in cur.fetchall()]
    return {"categorias": categorias, "subcategorias": subcategorias}
