"""Importa o histórico de Gastos.xlsx para o Neon. Idempotente na fonte='importacao'."""
from collections import Counter

MACRO_DE = {
    "Casa": "Casa", "Educação": "Educação", "Saúde": "Saúde", "Pessoal": "Pessoal",
    "Empresa": "Empresa", "Receita": "Receita", "Carro": "Carro",
    "Cidadania Italiana": "Cidadania Italiana", "Compra": "Compra", "Outros": "Outros",
}

def corrigir_mojibake(s):
    """Corrige mojibake quando arquivo foi lido como latin1 sobre bytes utf8."""
    if not isinstance(s, str):
        return s
    try:
        # o xlsx foi lido como latin1 sobre bytes utf8; desfaz quando possível
        return s.encode("latin1").decode("utf8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s

def natureza_de(tipo, valor_final):
    """Mapeia tipo e valor para natureza (receita ou despesa)."""
    if tipo == "Receita":
        return "receita"
    if valor_final is not None and valor_final > 0 and tipo not in MACRO_DE:
        return "receita"
    return "despesa"

def esfera_de(tipo):
    """Mapeia tipo para esfera (empresa ou pessoal)."""
    return "empresa" if tipo == "Empresa" else "pessoal"

def subs_recorrentes(gastos, min_ocorrencias):
    """Identifica gastos recorrentes que ocorrem >= min_ocorrencias vezes."""
    c = Counter(g for g in gastos if g)
    return {g for g, n in c.items() if n >= min_ocorrencias}

def montar_import(rows, min_ocorrencias=3):
    """
    Monta estrutura de importação a partir de linhas da planilha.

    Retorna: (transacoes, categorias, relatorio)
    - transacoes: list[dict] com campos para insert
    - categorias: list[dict] com (macro, sub) únicos
    - relatorio: dict com estatísticas da importação

    Regra: gastos recorrentes (>= min_ocorrencias) viram sub; one-offs
    mantêm descricao com sub=None.
    """
    rows = [{**r, "Tipo": corrigir_mojibake(r["Tipo"]), "Gasto": corrigir_mojibake(r.get("Gasto"))} for r in rows]
    recorrentes = subs_recorrentes([r.get("Gasto") for r in rows], min_ocorrencias)
    txs, pares = [], set()
    for r in rows:
        tipo = r["Tipo"]
        macro = MACRO_DE.get(tipo, "Outros")
        gasto = r.get("Gasto")
        sub = gasto if gasto in recorrentes else None
        nat = natureza_de(tipo, r.get("ValorFinal"))
        txs.append({
            "data": str(r["Data"])[:10], "natureza": nat, "esfera": esfera_de(tipo),
            "valor_total": abs(float(r["ValorTotal"] or 0)),
            "valor_reembolso": abs(float(r.get("ValorReembolso") or 0)),
            "macro": macro, "sub": sub, "descricao": gasto, "pessoa": r.get("Pessoa") or None,
            "fonte": "importacao", "origem_categoria": "manual",
        })
        pares.add((macro, sub))
        if sub:
            pares.add((macro, None))
    cats = [{"macro": m, "sub": s} for (m, s) in sorted(pares, key=lambda p: (p[0], p[1] or ""))]
    relatorio = {
        "n_transacoes": len(txs),
        "por_macro": dict(Counter(t["macro"] for t in txs)),
        "n_categorias": len(cats),
        "receitas": sum(1 for t in txs if t["natureza"] == "receita"),
    }
    return txs, cats, relatorio

def _ler_xlsx(caminho):
    """Lê Gastos.xlsx e retorna lista de dicts com as colunas esperadas."""
    import openpyxl
    wb = openpyxl.load_workbook(caminho, data_only=True, read_only=True)
    ws = wb["Gastos"]
    it = ws.iter_rows(values_only=True)
    hdr = list(next(it))
    idx = {h: i for i, h in enumerate(hdr)}
    def val(row, nome):
        i = idx.get(nome)
        return row[i] if i is not None and i < len(row) else None
    return [{c: val(row, c) for c in ["Tipo", "Gasto", "Pessoa", "Data", "ValorTotal", "ValorReembolso", "ValorFinal"]}
            for row in it if val(row, "Tipo")]

def main(caminho_xlsx, database_url, min_ocorrencias=3):
    """
    Importa histórico do Excel para o Neon.

    Idempotência: deleta registros com fonte='importacao' antes de inserir.
    """
    import psycopg
    rows = _ler_xlsx(caminho_xlsx)
    txs, cats, rel = montar_import(rows, min_ocorrencias)
    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        cur.execute("delete from transacoes where fonte = 'importacao'")  # idempotência
        for c in cats:
            cur.execute(
                "insert into categorias (macro, sub) values (%s, %s) on conflict (macro, sub) do nothing",
                (c["macro"], c["sub"]))
        for t in txs:
            cur.execute(
                """insert into transacoes
                   (data, natureza, esfera, valor_total, valor_reembolso, macro, sub, descricao, pessoa, fonte, origem_categoria)
                   values (%(data)s,%(natureza)s,%(esfera)s,%(valor_total)s,%(valor_reembolso)s,%(macro)s,%(sub)s,%(descricao)s,%(pessoa)s,%(fonte)s,%(origem_categoria)s)""",
                t)
        conn.commit()
    print("Import concluído:", rel)
    return rel

if __name__ == "__main__":
    import os, sys
    main(sys.argv[1], os.environ["DATABASE_URL"])
