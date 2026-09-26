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
impressa (nem em erro: ver redigir).

Três camadas contra escrita por onde não deve (achados da revisão de 26/09: um
COMMIT contrabandeado numa string ou num arquivo derrubava a guarda de texto e o
ROLLBACK do ensaio):
  1. guarda de texto — so_leitura/controla_transacao, com strings e comentários
     removidos antes de olhar; dollar-quoting é recusado;
  2. protocolo estendido (prepare=True) para o select e as consultas do ensaio: o
     servidor recusa mais de um comando por chamada;
  3. sessão com default_transaction_read_only=on no select: mesmo que algo escape,
     a transação é read-only.
O arquivo de migração (ensaiar/aplicar) segue pelo protocolo simples (vários
comandos de uma vez), por isso não pode controlar a transação — o script controla.
"""
import datetime
import decimal
import json
import os
import re
import subprocess
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


class DevVarsAusente(Exception):
    """Exceção comum (não SystemExit): os comandos a transformam em JSON ok:false."""


def _url_de(pasta):
    arquivo = Path(pasta) / ".dev.vars"
    if arquivo.exists():
        return ler_dev_vars(arquivo.read_text(encoding="utf-8")).get("DATABASE_URL")
    return None


def _git_common_dir(raiz):
    try:
        r = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=raiz, capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None
    except OSError:
        return None


def url_do_banco(env=None, raiz=None, git_common_dir="auto"):
    """Ambiente → .dev.vars da pasta atual → .dev.vars do checkout principal (o pai do
    git-common-dir): o reviewer roda dentro de uma worktree, onde o .dev.vars não existe."""
    env = os.environ if env is None else env
    if env.get("DATABASE_URL"):
        return env["DATABASE_URL"]
    raiz = Path(raiz or ".")
    url = _url_de(raiz)
    if url:
        return url
    comum = _git_common_dir(raiz) if git_common_dir == "auto" else git_common_dir
    if comum:
        url = _url_de(Path(raiz, comum).resolve().parent)
        if url:
            return url
    raise DevVarsAusente("DATABASE_URL: nem no ambiente nem em .dev.vars (da pasta atual ou do checkout principal)")


def _limpar(sql):
    """Tira strings ('...' com '' escapado) e comentários, nessa ordem: um "--" dentro de
    string não é comentário, e o que vem depois dele não pode sumir da inspeção."""
    sem_strings = re.sub(r"'(?:[^']|'')*'", "''", sql or "")
    return re.sub(r"--[^\n]*|/\*.*?\*/", "", sem_strings, flags=re.S)


def controla_transacao(sql):
    """True se algum comando (separado por ;) começa com BEGIN/START/COMMIT/END/ROLLBACK/
    SAVEPOINT/RELEASE/PREPARE/ABORT. O script é quem abre e fecha a transação; um
    COMMIT no meio persistiria o ensaio e tiraria o select da transação read-only."""
    for comando in _limpar(sql).split(";"):
        if re.match(r"^\s*(begin|start|commit|end|rollback|savepoint|release|prepare|abort)\b", comando, re.I):
            return True
    return False


def so_leitura(sql):
    """Primeira barreira (as outras são o protocolo estendido e a sessão read-only): uma
    consulta só, começando por SELECT/WITH/EXPLAIN, sem controle de transação e sem
    dollar-quoting (que esconderia um ; de outra forma)."""
    limpo = _limpar(sql).strip().rstrip(";")
    if ";" in limpo or re.search(r"\$\w*\$", limpo) or controla_transacao(limpo):
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


def redigir(texto, url):
    """Nem a URL nem a senha aparecem em erro: o psycopg ecoa a URL malformada e a senha
    com espaço na mensagem, e a saída deste script vai para relatório e PR."""
    if not url:
        return texto
    texto = texto.replace(url, "<DATABASE_URL>")
    m = re.match(r"[a-z]+://[^:/@]*:([^@]*)@", url)
    if m and m.group(1):
        texto = texto.replace(m.group(1), "***")
    return texto


def _erro(e, url=None):
    return redigir(f"{type(e).__name__}: {e}", url)


def cmd_select(sql):
    if not so_leitura(sql):
        return {"ok": False, "erro": "select: só SELECT/WITH/EXPLAIN, uma consulta por chamada"}
    import psycopg
    r = {"ok": True, "linhas": [], "n": 0}
    url = None
    try:
        url = url_do_banco()
        with psycopg.connect(url, autocommit=True, options="-c default_transaction_read_only=on") as conn:
            with conn.transaction():
                conn.execute("set transaction read only")
                cur = conn.execute(sql, prepare=True)   # estendido: um comando só, o servidor garante
                r["linhas"] = _linhas(cur)
                r["n"] = cur.rowcount
                raise psycopg.Rollback()
    except Exception as e:
        r = {"ok": False, "erro": _erro(e, url)}
    return r


def cmd_ensaiar(arquivo, consultas):
    for c in consultas:
        if not so_leitura(c):
            return {"ok": False, "arquivo": arquivo, "pos_deploy": False, "consultas": [],
                    "erro": f"--consulta só aceita SELECT: {c[:80]}"}
    import psycopg
    texto = Path(arquivo).read_text(encoding="utf-8")
    r = {"ok": True, "arquivo": arquivo, "pos_deploy": fase_pos_deploy(texto), "consultas": [], "erro": ""}
    if controla_transacao(texto):
        return {**r, "ok": False, "erro": "o arquivo controla a transação (begin/commit/rollback): o ensaio faz isso sozinho, tire esses comandos"}
    url = None
    try:
        url = url_do_banco()
        with psycopg.connect(url, autocommit=True) as conn:
            with conn.transaction():
                conn.execute(texto)
                for c in consultas:
                    r["consultas"].append({"sql": c, "linhas": _linhas(conn.execute(c, prepare=True))})
                raise psycopg.Rollback()   # o ensaio nunca persiste
    except Exception as e:
        r["ok"] = False
        r["erro"] = _erro(e, url)
    return r


def cmd_aplicar(arquivo):
    import psycopg
    texto = Path(arquivo).read_text(encoding="utf-8")
    r = {"ok": True, "arquivo": arquivo, "erro": ""}
    if controla_transacao(texto):
        return {**r, "ok": False, "erro": "o arquivo controla a transação (begin/commit/rollback): o aplicar faz isso sozinho, tire esses comandos"}
    url = None
    try:
        url = url_do_banco()
        with psycopg.connect(url, autocommit=True) as conn:
            with conn.transaction():
                conn.execute(texto)
    except Exception as e:
        r["ok"] = False
        r["erro"] = _erro(e, url)
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
