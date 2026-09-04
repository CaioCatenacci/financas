"""Importa um extrato Itaú (PDF): parse → checksum → classifica → reconcilia → preview → grava.
Sem --commit, é dry-run (só mostra o preview). Roda local (pypdf + psycopg)."""
import os, sys
from pypdf import PdfReader
from tools.extrato_itau import parse_extrato, conferir_checksum
from tools.classificar_linha import classificar, normalizar_descritor
from tools.reconciliar import linha_hash, reconciliar_linha
from tools.categorias import carregar_catalogo, resolver_categoria
from tools.contraparte import normalizar_nome

def ler_texto(caminho):
    return "\n".join((p.extract_text() or "") for p in PdfReader(caminho).pages)

def carregar_associacoes(cur):
    # associacoes por 'nome' → {categoria_nome, sub_nome} (join p/ nomes), chaveado por normalizar_nome
    cur.execute("""select a.chave, c.nome, s.nome from associacoes a
                   left join categorias c on c.id=a.categoria_id
                   left join subcategorias s on s.id=a.subcategoria_id
                   where a.tipo_chave='nome'""")
    return {normalizar_nome(ch): {"categoria_nome": cn, "sub_nome": sn} for ch, cn, sn in cur.fetchall()}

def carregar_existentes(cur, de, ate):
    cur.execute("""select id, to_char(data,'YYYY-MM-DD'), round(valor_final*100)::bigint,
                          linha_hash from transacoes where data between %s and %s""", (de, ate))
    return [{"id": str(i), "data": d, "valor_cents": int(v), "linha_hash": h} for i, d, v, h in cur.fetchall()]

def main(caminho, conta, commit):
    import psycopg
    texto = ler_texto(caminho)
    ext = parse_extrato(texto)
    chk = conferir_checksum(ext["linhas"], ext["saldos"])
    if not chk["ok"]:
        print(f"❌ CHECKSUM não bate (dif {chk['diferenca_cents']} cents). Abortado — não gravei nada.")
        return 1
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        catalogo = carregar_catalogo(cur)
        assoc = carregar_associacoes(cur)
        datas = [l["data"] for l in ext["linhas"]]
        existentes = carregar_existentes(cur, min(datas), max(datas))
        hashes_existentes = {e["linha_hash"] for e in existentes if e["linha_hash"]}
        novos, casados, nao_gasto, ambiguos, jatem = [], [], [], [], []
        for l in ext["linhas"]:
            lh = linha_hash(conta, l["data"], l["descricao"], l["valor_cents"], l["ordinal"])
            if lh in hashes_existentes:
                jatem.append(l); continue
            info = classificar(l["descricao"], catalogo, assoc)
            rec = reconciliar_linha(l, existentes) if info["computa_resumo"] else {"status": "novo", "match_id": None}
            registro = {**l, "linha_hash": lh, **info}
            if rec["status"] == "casado":
                registro["match_id"] = rec["match_id"]; casados.append(registro)
            elif rec["status"] == "ambiguo":
                ambiguos.append(registro)
            elif not info["computa_resumo"]:
                nao_gasto.append(registro)
            else:
                novos.append(registro)
        _preview(novos, casados, nao_gasto, ambiguos, jatem, chk)
        if not commit:
            print("\n(dry-run — rode com --commit p/ gravar; ambíguos NÃO são gravados)")
            return 0
        _gravar(cur, catalogo, conta, novos, nao_gasto, casados)
        conn.commit()
        print(f"\n✅ gravado: {len(novos)} novos, {len(nao_gasto)} não-gasto, {len(casados)} conciliados.")
        if ambiguos:
            print(f"⚠ {len(ambiguos)} ambíguos NÃO gravados — concilie no app ou reimporte após ajustar.")
    return 0

def _preview(novos, casados, nao_gasto, ambiguos, jatem, chk):
    tot = lambda xs: sum(x["valor_cents"] for x in xs) / 100
    print(f"CHECKSUM ok. novos={len(novos)} (R$ {tot(novos):.2f}) | conciliados={len(casados)} | "
          f"não-gasto={len(nao_gasto)} (R$ {tot(nao_gasto):.2f}) | ambíguos={len(ambiguos)} | já-tinha={len(jatem)}")
    for x in ambiguos:
        print(f"  ambíguo: {x['data']} {x['descricao']} R$ {x['valor_cents']/100:.2f}")

def _gravar(cur, catalogo, conta, novos, nao_gasto, casados):
    # conciliados: só carimba o linha_hash na transação existente (não duplica)
    for x in casados:
        cur.execute("update transacoes set linha_hash=%s where id=%s and linha_hash is null",
                    (x["linha_hash"], x["match_id"]))
    # novos + não-gasto: inserem transação por id
    for x in novos + nao_gasto:
        nome_cat = x["categoria_org"] or x["categoria_nome"] or "Outros"
        cat_id, sub_id = resolver_categoria(nome_cat, x.get("sub_nome"), catalogo)
        cur.execute(
            """insert into transacoes
               (data, natureza, esfera, valor_total, valor_reembolso, categoria_id, subcategoria_id,
                descricao, fonte, origem_categoria, contraparte_nome, computa_resumo, linha_hash)
               values (%s,%s,'pessoal',%s,0,%s,%s,%s,'extrato',%s,%s,%s,%s)""",
            (x["data"], x["natureza"], x["valor_cents"]/100.0, cat_id, sub_id, x["descricao"],
             ("regra" if x.get("categoria_nome") else "modelo"), x["contraparte_nome"],
             x["computa_resumo"], x["linha_hash"]))

if __name__ == "__main__":
    args = sys.argv[1:]
    commit = "--commit" in args
    conta = args[args.index("--conta") + 1] if "--conta" in args else "conta"
    pdf = next(a for a in args if not a.startswith("--") and a != conta)
    sys.exit(main(pdf, conta, commit))
