"""Lê contrapartes.csv (revisado pelo Caio) e faz upsert em associacoes (por id, Fase B)."""
import csv
import os
import sys
import psycopg

from tools.categorias import carregar_catalogo, resolver_categoria


def aplicar(caminho_csv, database_url):
    """Lê CSV revisado e faz upsert em associacoes, resolvendo macro/sub → ids (Fase B)."""
    n = 0
    with (
        psycopg.connect(database_url) as conn,
        conn.cursor() as cur,
        open(caminho_csv, encoding="utf-8") as f
    ):
        catalogo = carregar_catalogo(cur)
        for row in csv.DictReader(f):
            macro = (row.get("sugestao_macro") or "").strip()
            if not macro:
                # Linhas sem categoria confirmada são puladas
                continue
            sub = (row.get("sugestao_sub") or "").strip() or None
            categoria_id, subcategoria_id = resolver_categoria(macro, sub, catalogo)
            cur.execute(
                """insert into associacoes (chave, tipo_chave, categoria_id, subcategoria_id, n, atualizado_em)
                   values (%s,%s,%s,%s,1,now())
                   on conflict (chave, tipo_chave) do update
                     set categoria_id=excluded.categoria_id, subcategoria_id=excluded.subcategoria_id,
                         n=associacoes.n+1, atualizado_em=now()""",
                (row["chave"], row["tipo"], categoria_id, subcategoria_id)
            )
            n += 1
        conn.commit()
    print(f"{n} associações aplicadas")


if __name__ == "__main__":
    aplicar(sys.argv[1], os.environ["DATABASE_URL"])
