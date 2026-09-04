"""Classificação de linha de extrato/fatura (puro). Deriva o descritor do estabelecimento,
reconhece não-gasto por padrões, e resolve categoria via associações aprendidas (Inc 2)."""
import re
from tools.contraparte import normalizar_nome

# padrões de NÃO-GASTO (conservador; editável). Ordem importa.
_NAO_GASTO = [
    (re.compile(r"\bAPLICACAO\b|PERSONDIF|COR COMP CDB|\bCDB\b|PERS BLACK", re.I), "Investimentos"),
    (re.compile(r"PIX TRANSF (CAIO|PAOLA)\b", re.I), "Transferências"),  # contas próprias
    (re.compile(r"PAGAMENTO.*(CARTAO|FATURA)|DEB.*CARTAO", re.I), "Fatura de cartão"),
]
_DATA_SUFIXO = re.compile(r"\s*\d{2}/\d{2}\s*$")            # '…30/12' no fim
_PREFIXOS = re.compile(r"^(PIX QRS|PIX TRANSF|PAG BOLETO|DA|TED|DOC)\b\s*", re.I)  # DA = débito automático (Itaú)

def normalizar_descritor(descricao):
    s = _DATA_SUFIXO.sub("", descricao.strip())
    s = _PREFIXOS.sub("", s)
    s = re.sub(r"\d{3,}", " ", s)          # números longos (docs/contas) viram espaço
    s = re.sub(r"[.\-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s

def reconhecer_nao_gasto(descricao):
    for rx, cat in _NAO_GASTO:
        if rx.search(descricao):
            return cat
    return None

def classificar(descricao, catalogo, associacoes):
    org = reconhecer_nao_gasto(descricao)
    descritor = normalizar_descritor(descricao)
    if org:
        return {"contraparte_nome": descritor, "categoria_nome": None, "sub_nome": None,
                "computa_resumo": False, "categoria_org": org}
    # Lookup associação usa normalizar_nome para casar a chave (tipo='nome') na tabela
    a = associacoes.get(normalizar_nome(descritor))
    return {"contraparte_nome": descritor,
            "categoria_nome": a["categoria_nome"] if a else None,
            "sub_nome": a["sub_nome"] if a else None,
            "computa_resumo": True, "categoria_org": None}
