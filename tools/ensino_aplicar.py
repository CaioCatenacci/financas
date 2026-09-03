"""Lê contrapartes.csv (revisado pelo Caio) e faz upsert em associacoes."""
import csv
import os
import sys
import psycopg


def aplicar(caminho_csv, database_url):
    """Lê CSV revisado e faz upsert em associacoes (macro/sub confirmados)."""
    n = 0
    with (
        psycopg.connect(database_url) as conn,
        conn.cursor() as cur,
        open(caminho_csv, encoding="utf-8") as f
    ):
        for row in csv.DictReader(f):
            macro = (row.get("sugestao_macro") or "").strip()
            if not macro:
                # Linhas sem categoria confirmada são puladas
                continue
            sub = (row.get("sugestao_sub") or "").strip() or None
            cur.execute(
                """insert into associacoes (chave, tipo_chave, macro, sub, n, atualizado_em)
                   values (%s,%s,%s,%s,1,now())
                   on conflict (chave, tipo_chave) do update
                     set macro=excluded.macro, sub=excluded.sub, n=associacoes.n+1, atualizado_em=now()""",
                (row["chave"], row["tipo"], macro, sub)
            )
            n += 1
        conn.commit()
    print(f"{n} associações aplicadas")


if __name__ == "__main__":
    aplicar(sys.argv[1], os.environ["DATABASE_URL"])
