"""Parser da fatura Itaú (texto do PDF, extraído em modo layout do pypdf).
A fatura tem layout de 2 colunas; em modo layout cada linha de lançamento vira
'DATA   ESTABELECIMENTO   VALOR   [ruído da coluna da direita: juros etc]'.
Regra: uma linha de item é a que COMEÇA (após strip) com 'DD/MM'; o valor do
lançamento é o PRIMEIRO token de dinheiro que aparece depois da data — ruído da
coluna da direita (ex.: juros) vem depois e tem que ser ignorado. O estabelecimento
é o texto entre a data e esse primeiro valor. Ano vem do período da fatura (parâmetro).
Parcela 'x/y' extraída do texto do estabelecimento."""
import re

_LINHA_DATA = re.compile(r"^(\d{2})/(\d{2})\s+(.*)$")
_MONEY = re.compile(r"\d{1,3}(?:\.\d{3})*,\d{2}")
_PARCELA = re.compile(r"PARCELA\s+(\d{2}/\d{2})", re.I)
# ".", não "ç"/"ã" diretamente: o texto extraído pode carregar acentuação estranha
_TOTAL_LABEL = re.compile(r"total\s+dos\s+lan.amentos\s+atuais", re.I)
_IGNORAR = re.compile(r"total\s+dos\s+lan.amentos|lan.amentos\s+no\s+cart.o|^data\s+estabelecimento", re.I)


def _cents(v):
    return int(v.replace(".", "").replace(",", ""))


def parse_fatura(texto, ano):
    itens = []
    total_cents = 0
    for raw in texto.splitlines():
        linha = raw.strip()
        if not linha:
            continue

        mt = _TOTAL_LABEL.search(linha)
        if mt:
            mv = _MONEY.search(linha[mt.end():])
            if mv:
                total_cents = _cents(mv.group(0))
            continue

        if _IGNORAR.search(linha):
            continue

        md = _LINHA_DATA.match(linha)
        if not md:
            continue
        dd, mm, resto = md.groups()

        mv = _MONEY.search(resto)
        if not mv:
            continue  # linha começa com data mas não tem valor reconhecível — ignora

        estabelecimento = re.sub(r"\s{2,}", " ", resto[:mv.start()]).strip()
        parc = _PARCELA.search(estabelecimento)
        itens.append({
            "data": f"{ano}-{mm}-{dd}",
            "descricao": estabelecimento,
            "valor_cents": _cents(mv.group(0)),
            "parcela": parc.group(1) if parc else None,
        })
    return {"itens": itens, "total_cents": total_cents}
