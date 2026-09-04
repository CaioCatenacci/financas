"""Importa uma fatura Itaú (PDF): itens viram despesas (fonte=fatura), categorizados/idempotentes.
E marca o pagamento correspondente no extrato como não-gasto (computa_resumo=false).
Dry-run por padrão; --commit grava. Reusa helpers do importar_extrato."""
import os, sys
from pypdf import PdfReader
from tools.fatura_itau import parse_fatura
from tools.classificar_linha import classificar
from tools.reconciliar import linha_hash
from tools.categorias import carregar_catalogo, resolver_categoria
from tools.importar_extrato import carregar_associacoes

def ler_texto(caminho):
    return "\n".join((p.extract_text() or "") for p in PdfReader(caminho).pages)

def main(caminho, ano, mes, commit):
    import psycopg
    fat = parse_fatura(ler_texto(caminho), ano=int(ano))
    soma = sum(i["valor_cents"] for i in fat["itens"])
    if fat["total_cents"] and soma != fat["total_cents"]:
        print(f"❌ CHECKSUM fatura: itens={soma} ≠ total={fat['total_cents']}. Abortado."); return 1
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        catalogo = carregar_catalogo(cur)
        assoc = carregar_associacoes(cur)
        cur.execute("select linha_hash from transacoes where linha_hash is not null")
        existentes = {h for (h,) in cur.fetchall()}
        novos = []
        for i, item in enumerate(fat["itens"]):
            lh = linha_hash(f"fatura-{ano}{mes}", item["data"], item["descricao"], item["valor_cents"], i)
            if lh in existentes:
                continue
            info = classificar(item["descricao"], catalogo, assoc)  # fatura = sempre gasto
            desc = item["descricao"] + (f" (parc {item['parcela']})" if item["parcela"] else "")
            novos.append({**item, "linha_hash": lh, "descricao_final": desc, **info})
        print(f"fatura {mes}/{ano}: {len(novos)} itens novos (R$ {sum(x['valor_cents'] for x in novos)/100:.2f}); "
              f"total fatura R$ {fat['total_cents']/100:.2f}")
        if not commit:
            print("(dry-run — rode com --commit p/ gravar)"); return 0
        for x in novos:
            nome_cat = x["categoria_nome"] or "Outros"
            cat_id, sub_id = resolver_categoria(nome_cat, x.get("sub_nome"), catalogo)
            cur.execute(
                """insert into transacoes
                   (data, natureza, esfera, valor_total, valor_reembolso, categoria_id, subcategoria_id,
                    descricao, fonte, origem_categoria, contraparte_nome, computa_resumo, linha_hash)
                   values (%s,'despesa','pessoal',%s,0,%s,%s,%s,'fatura',%s,%s,true,%s)""",
                (x["data"], x["valor_cents"]/100.0, cat_id, sub_id, x["descricao_final"],
                 ("regra" if x["categoria_nome"] else "modelo"), x["contraparte_nome"], x["linha_hash"]))
        # marca o pagamento da fatura no extrato como não-gasto (mesmo total, natureza despesa, ainda não marcado)
        cur.execute("""update transacoes set computa_resumo=false
                       where fonte='extrato' and natureza='despesa'
                         and round(valor_final*100)::bigint=%s and computa_resumo=true""",
                    (fat["total_cents"],))
        marcadas = cur.rowcount
        conn.commit()
        print(f"✅ gravados {len(novos)} itens; pagamento no extrato marcado não-gasto: {marcadas} linha(s).")
        if marcadas != 1:
            print("⚠ confira: esperava marcar exatamente 1 pagamento no extrato (valor pode divergir por encargos).")
    return 0

if __name__ == "__main__":
    a = sys.argv[1:]
    kv = {a[i]: a[i+1] for i in range(len(a)-1) if a[i].startswith("--") and not a[i+1].startswith("--")}
    pdf = next(x for x in a if not x.startswith("--") and x not in kv.values())
    sys.exit(main(pdf, kv.get("--ano"), kv.get("--mes"), "--commit" in a))
