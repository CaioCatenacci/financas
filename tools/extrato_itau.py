"""Parser determinístico do extrato Itaú (texto do PDF). Puro: entra texto, sai estrutura.
Linha: 'DD/MM/AAAA <descrição> <valor>'. 'SALDO DO DIA' é marcador (vira saldo, não lançamento).
Valor negativo = saída (despesa); positivo = entrada (receita)."""
import re

_LINHA = re.compile(r"^(\d{2})/(\d{2})/(\d{4})\s+(.+?)\s+(-?[\d.]+,\d{2})$")

def _cents(valor):
    # '-1.574,52' -> -157452 ; '30.000,00' -> 3000000
    neg = valor.strip().startswith("-")
    s = valor.replace("-", "").replace(".", "").replace(",", "")
    n = int(s)
    return -n if neg else n

def parse_extrato(texto):
    linhas, saldos = [], []
    ordinais = {}  # data -> próximo ordinal
    for raw in texto.splitlines():
        m = _LINHA.match(raw.strip())
        if not m:
            continue
        dd, mm, aaaa, descricao, valor = m.groups()
        data = f"{aaaa}-{mm}-{dd}"
        descricao = descricao.strip()
        cents = _cents(valor)
        if descricao.upper() == "SALDO DO DIA":
            saldos.append({"data": data, "saldo_cents": cents})
            continue
        o = ordinais.get(data, 0)
        ordinais[data] = o + 1
        linhas.append({
            "data": data, "descricao": descricao, "valor_cents": abs(cents),
            "natureza": "receita" if cents > 0 else "despesa", "ordinal": o,
        })
    return {"linhas": linhas, "saldos": saldos}

def conferir_checksum(linhas, saldos):
    # entre cada par de SALDO DO DIA consecutivos (ordenados por data), a variação de saldo
    # deve igualar a soma (com sinal) dos lançamentos daquele dia/intervalo.
    if len(saldos) < 2:
        return {"ok": True, "diferenca_cents": 0}  # sem dois saldos não dá p/ conferir
    porData = {}
    for l in linhas:
        v = l["valor_cents"] if l["natureza"] == "receita" else -l["valor_cents"]
        porData[l["data"]] = porData.get(l["data"], 0) + v
    s = sorted(saldos, key=lambda x: x["data"])
    dif = 0
    for i in range(1, len(s)):
        esperado = s[i]["saldo_cents"] - s[i - 1]["saldo_cents"]
        real = porData.get(s[i]["data"], 0)
        dif += esperado - real
    return {"ok": dif == 0, "diferenca_cents": dif}
