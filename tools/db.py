"""tools/db.py — acesso ao banco para os papéis da fila autônoma.

Não há Neon MCP nesta máquina; o que existe é a DATABASE_URL em .dev.vars. Este
script é a única porta dos agentes para o banco, e cada comando tem a trava
embutida — não é regra de prompt:

  select  "<consulta>"                         leitura: SET TRANSACTION READ ONLY + ROLLBACK
  ensaiar <arquivo.sql> [--consulta "<sel>"]   roda o arquivo numa transação e dá ROLLBACK
                                               (prova que a migração roda e que as consultas
                                               das rotas rodam contra o schema novo)
  aplicar <arquivo.sql>                        roda o arquivo e COMMITA — só a entrega, com
                                               o Caio presente (fora do allow de propósito)

Cada comando imprime UMA linha de JSON e sai 1 quando ok=false. A URL nunca é
impressa. Sem parâmetros, o psycopg manda o texto como uma query simples, então um
arquivo com vários comandos roda de uma vez.
"""
import datetime
import decimal
import json
import os
import re
import sys
import uuid
from pathlib import Path

LIMITE_LINHAS = 200
USO = ('uso: python tools/db.py select "<consulta>" | ensaiar <arquivo.sql> [--consulta "<select>"]... '
       "| aplicar <arquivo.sql>")


def ler_dev_vars(texto):
    """KEY=valor por linha; vazias e # ignoradas; CRLF e aspas toleradas; o primeiro = separa."""
    campos = {}
    for bruta in texto.splitlines():
        linha = bruta.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        k, v = linha.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        campos[k.strip()] = v
    return campos


def url_do_banco(env=None, raiz=None):
    env = os.environ if env is None else env
    if env.get("DATABASE_URL"):
        return env["DATABASE_URL"]
    arquivo = Path(raiz or ".") / ".dev.vars"
    if arquivo.exists():
        url = ler_dev_vars(arquivo.read_text(encoding="utf-8")).get("DATABASE_URL")
        if url:
            return url
    raise SystemExit("DATABASE_URL: nem no ambiente nem em .dev.vars")


def so_leitura(sql):
    """Primeira barreira (a segunda é a transação read-only): uma consulta só, começando
    por SELECT/WITH/EXPLAIN. Ponto-e-vírgula no meio recusa — "select 1; delete" não passa."""
    limpo = re.sub(r"--[^\n]*|/\*.*?\*/", "", sql or "", flags=re.S).strip().rstrip(";")
    if ";" in limpo:
        return False
    return re.match(r"^(select|with|explain)\b", limpo, re.I) is not None


def fase_pos_deploy(texto):
    """Só a primeira linha não vazia marca a fase: comando destrutivo vive em arquivo à parte."""
    primeira = next((l.strip() for l in texto.splitlines() if l.strip()), "")
    return primeira.lower().startswith("-- fase: pos-deploy")


def para_json(v):
    if isinstance(v, (datetime.date, datetime.datetime, datetime.time)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, uuid.UUID):
        return str(v)
    raise TypeError(f"não sei serializar {type(v).__name__}")


def _linhas(cur):
    if cur.description is None:
        return []
    colunas = [d.name for d in cur.description]
    return [dict(zip(colunas, linha)) for linha in cur.fetchmany(LIMITE_LINHAS)]


def _erro(e):
    return f"{type(e).__name__}: {e}"


def cmd_select(sql):
    if not so_leitura(sql):
        return {"ok": False, "erro": "select: só SELECT/WITH/EXPLAIN, uma consulta por chamada"}
    import psycopg
    r = {"ok": True, "linhas": [], "n": 0}
    try:
        with psycopg.connect(url_do_banco(), autocommit=True) as conn:
            with conn.transaction():
                conn.execute("set transaction read only")
                cur = conn.execute(sql)
                r["linhas"] = _linhas(cur)
                r["n"] = cur.rowcount
                raise psycopg.Rollback()
    except Exception as e:
        r = {"ok": False, "erro": _erro(e)}
    return r


def cmd_ensaiar(arquivo, consultas):
    for c in consultas:
        if not so_leitura(c):
            return {"ok": False, "arquivo": arquivo, "pos_deploy": False, "consultas": [],
                    "erro": f"--consulta só aceita SELECT: {c[:80]}"}
    import psycopg
    texto = Path(arquivo).read_text(encoding="utf-8")
    r = {"ok": True, "arquivo": arquivo, "pos_deploy": fase_pos_deploy(texto), "consultas": [], "erro": ""}
    try:
        with psycopg.connect(url_do_banco(), autocommit=True) as conn:
            with conn.transaction():
                conn.execute(texto)
                for c in consultas:
                    r["consultas"].append({"sql": c, "linhas": _linhas(conn.execute(c))})
                raise psycopg.Rollback()   # o ensaio nunca persiste
    except Exception as e:
        r["ok"] = False
        r["erro"] = _erro(e)
    return r


def cmd_aplicar(arquivo):
    import psycopg
    texto = Path(arquivo).read_text(encoding="utf-8")
    r = {"ok": True, "arquivo": arquivo, "erro": ""}
    try:
        with psycopg.connect(url_do_banco(), autocommit=True) as conn:
            with conn.transaction():
                conn.execute(texto)
    except Exception as e:
        r["ok"] = False
        r["erro"] = _erro(e)
    return r


def main(argv):
    # Quem lê a saída é um agente, por JSON: UTF-8 sempre, mesmo no console cp1252 do Windows.
    for fluxo in (sys.stdout, sys.stderr):
        if hasattr(fluxo, "reconfigure"):
            fluxo.reconfigure(encoding="utf-8")
    if not argv:
        print(USO, file=sys.stderr)
        sys.exit(1)
    cmd, *args = argv
    if cmd == "select" and len(args) == 1:
        r = cmd_select(args[0])
    elif cmd == "ensaiar" and args:
        arquivo, resto, consultas = args[0], args[1:], []
        while resto:
            if resto[0] == "--consulta" and len(resto) > 1:
                consultas.append(resto[1])
                resto = resto[2:]
            else:
                print(USO, file=sys.stderr)
                sys.exit(1)
        r = cmd_ensaiar(arquivo, consultas)
    elif cmd == "aplicar" and len(args) == 1:
        r = cmd_aplicar(args[0])
    else:
        print(USO, file=sys.stderr)
        sys.exit(1)
    print(json.dumps(r, ensure_ascii=False, default=para_json))
    sys.exit(0 if r["ok"] else 1)


if __name__ == "__main__":
    main(sys.argv[1:])
