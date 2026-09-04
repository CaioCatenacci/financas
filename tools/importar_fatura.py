"""Importa uma fatura Itaú (PDF): itens viram despesas (fonte=fatura), categorizados/idempotentes.
E marca o pagamento correspondente no extrato como não-gasto (computa_resumo=false).
Dry-run por padrão; --commit grava. Reusa helpers do importar_extrato."""
import os, sys, re
import datetime
from pypdf import PdfReader
from tools.fatura_itau import parse_fatura
from tools.classificar_linha import classificar
from tools.reconciliar import linha_hash
from tools.categorias import carregar_catalogo, resolver_categoria
from tools.importar_extrato import carregar_associacoes

def ler_texto(caminho):
    # modo layout preserva colunas (data/estabelecimento/valor na mesma linha);
    # o modo padrão do pypdf embaralha o layout de 2 colunas da fatura Itaú.
    return "\n".join((p.extract_text(extraction_mode="layout") or "") for p in PdfReader(caminho).pages)

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
            # Remove "PARCELA XX/YY" (case-insensitive) from establishment text to avoid duplication
            desc_limpo = re.sub(r'\bPARCELA\s+\d{2}/\d{2}\b', '', item["descricao"], flags=re.IGNORECASE).strip()
            desc = desc_limpo + (f" (parc {item['parcela']})" if item["parcela"] else "")
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
        # Marca o pagamento da fatura no extrato como não-gasto
        # Primeiro: identifica candidatos dentro da janela de data (fatura date até ~62 dias depois)
        primeiro_dia = datetime.date(int(ano), int(mes), 1)
        janela_fim = primeiro_dia + datetime.timedelta(days=62)
        cur.execute(
            """select id from transacoes
               where fonte='extrato' and natureza='despesa' and computa_resumo=true
                 and round(valor_final*100)::bigint=%s
                 and data >= %s and data <= %s""",
            (fat["total_cents"], primeiro_dia, janela_fim))
        candidatos = [row[0] for row in cur.fetchall()]
        if len(candidatos) == 1:
            # Exatamente 1 candidato: marcar como não-gasto
            cur.execute("update transacoes set computa_resumo=false where id=%s", (candidatos[0],))
            conn.commit()
            print(f"✅ gravados {len(novos)} itens; pagamento no extrato marcado não-gasto: 1 linha.")
        elif len(candidatos) == 0:
            # Nenhum candidato: aviso (não critica, pois encargos podem divergir)
            conn.commit()
            print(f"✅ gravados {len(novos)} itens; nenhum pagamento correspondente encontrado no extrato na janela — marque manualmente no app se necessário.")
        else:
            # Múltiplos candidatos: aviso e sem marcar nada (deixa para manual)
            conn.commit()
            print(f"✅ gravados {len(novos)} itens; ⚠ {len(candidatos)} possíveis pagamentos encontrados (ids: {candidatos}) — marque o correto manualmente no app.")
    return 0

if __name__ == "__main__":
    a = sys.argv[1:]
    kv = {a[i]: a[i+1] for i in range(len(a)-1) if a[i].startswith("--") and not a[i+1].startswith("--")}
    pdf = next(x for x in a if not x.startswith("--") and x not in kv.values())
    sys.exit(main(pdf, kv.get("--ano"), kv.get("--mes"), "--commit" in a))
