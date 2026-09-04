"""Reconciliação (puro): chave estável da linha e matching por valor+data(±3d)."""
import hashlib
from datetime import date

def linha_hash(conta, data, descricao, valor_cents, ordinal):
    base = f"{conta}|{data}|{descricao}|{valor_cents}|{ordinal}"
    return hashlib.sha256(base.encode("utf-8")).hexdigest()

def _dias(a, b):
    ya, ma, da = (int(x) for x in a.split("-"))
    yb, mb, db = (int(x) for x in b.split("-"))
    return abs((date(ya, ma, da) - date(yb, mb, db)).days)

def reconciliar_linha(linha, existentes):
    cand = [e for e in existentes
            if e["valor_cents"] == linha["valor_cents"] and _dias(linha["data"], e["data"]) <= 3]
    if len(cand) == 1:
        return {"status": "casado", "match_id": cand[0]["id"]}
    if len(cand) > 1:
        return {"status": "ambiguo", "match_id": None}
    return {"status": "novo", "match_id": None}
