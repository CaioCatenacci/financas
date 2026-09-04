"""Parser da fatura Itaú (texto do PDF). Puro. Linha de item: 'DD/MM <estab> <valor>'.
Ano vem do período da fatura (passado por parâmetro). Parcela 'x/y' extraída do texto do estab."""
import re

_ITEM = re.compile(r"^(\d{2})/(\d{2})\s+(.+?)\s+([\d.]+,\d{2})$")
_PARCELA = re.compile(r"PARCELA\s+(\d{2}/\d{2})", re.I)
_TOTAL = re.compile(r"Total dos lançamentos atuais\s+([\d.]+,\d{2})", re.I)
_IGNORAR = re.compile(r"Total dos lançamentos|Lançamentos no cartão|DATA\s+ESTABELECIMENTO", re.I)

def _cents(v):
    return int(v.replace(".", "").replace(",", ""))

def parse_fatura(texto, ano):
    itens = []
    total_cents = 0
    for raw in texto.splitlines():
        linha = raw.strip()
        mt = _TOTAL.search(linha)
        if mt:
            total_cents = _cents(mt.group(1)); continue
        if _IGNORAR.search(linha):
            continue
        m = _ITEM.match(linha)
        if not m:
            continue
        dd, mm, descricao, valor = m.groups()
        parc = _PARCELA.search(descricao)
        itens.append({"data": f"{ano}-{mm}-{dd}", "descricao": descricao.strip(),
                      "valor_cents": _cents(valor), "parcela": parc.group(1) if parc else None})
    return {"itens": itens, "total_cents": total_cents}
