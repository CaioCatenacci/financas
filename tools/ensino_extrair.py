"""Varre comprovantes do Dropbox, extrai contraparte (Gemini), agrupa por contraparte
única e escreve contrapartes.csv p/ o Caio revisar. Uma linha por contraparte."""
import csv
import os
import sys
import json
import base64
import urllib.request
from collections import OrderedDict

from tools.contraparte import derivar_chave


def agrupar_por_contraparte(rows):
    """Agrupa por contraparte única: mesma (chave, tipo) contam junto.

    Mantém: primeira sugestão de macro/sub, conta de ocorrências (n).
    """
    ac = OrderedDict()
    for r in rows:
        d = derivar_chave(r)
        if not d:
            continue
        k = (d["chave"], d["tipo"])
        if k not in ac:
            ac[k] = {
                "chave": d["chave"],
                "tipo": d["tipo"],
                "nome": r.get("contraparte_nome") or "",
                "n": 0,
                "sugestao_macro": r.get("macro") or "",
                "sugestao_sub": r.get("sub") or ""
            }
        ac[k]["n"] += 1
    return list(ac.values())


def _gemini(img_bytes, key, cats):
    """Chama Gemini com a imagem e retorna JSON com macro/sub/contraparte."""
    prompt = (
        'Leia o comprovante e responda SOMENTE JSON com '
        '{"macro":string,"sub":string|null,'
        '"contraparte_nome":string|null,"contraparte_chave":string|null}. '
        "Escolha macro/sub desta lista: " + "; ".join(cats)
    )
    body = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inline_data": {
                            "mime_type": "image/jpeg",
                            "data": base64.b64encode(img_bytes).decode()
                        }
                    }
                ]
            }
        ],
        "generationConfig": {"responseMimeType": "application/json"}
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key={key}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req) as r:
        j = json.loads(r.read())
        return json.loads(j["candidates"][0]["content"]["parts"][0]["text"])


def main(pasta, key, cats, saida="contrapartes.csv"):
    """Varre pasta, extrai contrapartes via Gemini, agrupa e escreve CSV."""
    rows = []
    for dirpath, _, files in os.walk(pasta):
        for f in files:
            if not f.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            caminho = os.path.join(dirpath, f)
            with open(caminho, "rb") as fp:
                b = fp.read()
            try:
                rows.append(_gemini(b, key, cats))
            except Exception as e:
                print(f"falhou: {f} {e}")

    grupos = agrupar_por_contraparte(rows)
    with open(saida, "w", newline="", encoding="utf-8") as o:
        w = csv.DictWriter(
            o,
            fieldnames=["chave", "tipo", "nome", "n", "sugestao_macro", "sugestao_sub"]
        )
        w.writeheader()
        w.writerows(grupos)
    print(f"{len(rows)} comprovantes → {len(grupos)} contrapartes únicas em {saida}")


if __name__ == "__main__":
    key = os.environ["GEMINI_KEY"]
    cats = os.environ.get(
        "CATS",
        "Casa; Educação; Saúde; Pessoal; Empresa; Carro; Outros"
    ).split("; ")
    main(sys.argv[1], key, cats)
