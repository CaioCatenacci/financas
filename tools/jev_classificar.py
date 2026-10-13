#!/usr/bin/env python
"""H1 — spike: o JEV acerta categoria e subcategoria das transações pendentes?

Por que existe: há ~1.300 transações na categoria padrão ("Não Identificado"),
todas contando no resumo. Classificar à mão é inviável; o JEV (TypeSafe) responde
escolhas (Choice) com probabilidade a uma fração do custo de um modelo gerativo. O
spike mede, contra um gabarito feito à mão pelo Caio, quanto ele acerta e a partir
de qual confiança daria para aplicar sem revisão.

É só o experimento: NÃO grava no banco (a conexão abre em modo só-leitura e só há
SELECT). Gravar a classificação é o H3, depois do relatório e do limiar escolhido.

    python tools/jev_classificar.py amostra [--n 60]   # pergunta ao JEV e grava a planilha
    python tools/jev_classificar.py amostra --gabarito dados/jev/amostra.csv --csv <nova>
                                                       # H2: mesmos ids, gabarito copiado
    python tools/jev_classificar.py relatorio          # lê a planilha com o gabarito

H2 (segunda rodada): o estado explica a fonte, categorias e subs podem ter descrição
escrita à mão, a sub genérica substitui "sem subcategoria" e "IFD*" vira iFood por
regra, sem chamar o JEV (a planilha marca a `origem`: `regra` ou `jev`).

A planilha (`dados/jev/amostra.csv`, fora do git: tem descrição e contraparte reais)
sai com separador `;` e vírgula decimal, que é o que o Excel brasileiro abre sem
estragar. O Caio preenche `gabarito_categoria` e `gabarito_subcategoria` com os nomes
do catálogo ("nenhuma serve" e sub vazia valem).

Credenciais: DATABASE_URL e TYPESAFE_API_KEY, do ambiente ou do `.dev.vars`. A chave
vai direto para o cliente da TypeSafe e nunca é impressa nem gravada. O SDK
(`pip install typesafe-sdk`) só é importado na hora de criar o cliente: o CI não o
tem, e os testes usam um cliente falso.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import pathlib
import random
import sys
import time
from decimal import ROUND_HALF_UP, Decimal

ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

CSV_PADRAO = ROOT / "dados" / "jev" / "amostra.csv"

# O spike inteiro não pode passar disto (decisão do card).
TETO_USD = Decimal("2")

# Preço do JEV por MILHÃO de tokens de entrada; a saída é grátis. Fonte:
# docs.typesafe.ai/models (jev-1.13.0, US$ 42 por bilhão), lida em 03/10/2026 no
# spike B81 do LM Ateliê. A API devolve os tokens (`usage.input_tokens`).
JEV_USD_POR_MTOK = Decimal("0.042")
JEV_MODELO = "jev-latest"
_MILHAO = Decimal("1000000")

# Semente fixa: a mesma amostra em toda execução, para o gabarito do Caio não se
# perder quando o script roda de novo.
SEMENTE = 20261013

NENHUMA = "nenhuma serve"
SEM_SUB = "sem subcategoria"

FONTES = ("extrato", "fatura", "imagem", "importacao", "manual")

# O que a fonte quer dizer, para o JEV. No H1 o estado mandava só "fatura", e o
# modelo puxava qualquer compra de cartão para "Banco → Fatura de cartão" (11 erros
# em 11): o nome da fonte parecia o nome da sub.
FONTE_EXPLICADA = {
    "extrato": "movimento da conta corrente (linha do extrato bancário)",
    "fatura": "compra feita no cartão de crédito (linha da fatura)",
    "imagem": "comprovante fotografado (Pix, boleto ou recibo)",
    "importacao": "lançamento trazido da planilha antiga de controle",
    "manual": "lançamento digitado à mão",
}

# Descrição escrita à mão por categoria; tem precedência sobre o "inclui: <subs>".
DESCRICAO_CATEGORIA = {
    "Banco": "tarifas, juros, IOF, anuidade e o pagamento da fatura em si — "
             "nunca uma compra feita no cartão",
}

# Descrição escrita à mão por (categoria, sub). Sem ela, a sub vai sem critério (ou
# com o critério da genérica).
DESCRICAO_SUB = {
    ("Alimentação", "Restaurante"): "comer ou beber no local: restaurante, bar, café",
    ("Alimentação", "Outros"): "delivery fora do iFood, padaria, sorveteria e o resto",
}

CRITERIO_GENERICA = "quando nenhuma outra subcategoria se aplica"

# Regra fixa antes do modelo: "IFD*" na fatura é sempre iFood (no H1 o JEV escolhia
# Restaurante/Mercado). Não gasta chamada.
PREFIXO_IFOOD = "IFD*"
REGRA_IFOOD = ("Alimentação", "Ifood")
# Crédito/estorno de extrato e fatura é receita sob categoria de despesa (ver
# naturezaAoReclassificar em worker/categorias.js): por isso essas receitas
# escolhem entre TODAS as categorias.
FONTES_COM_ESTORNO = ("extrato", "fatura")

LIMIARES = (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95)

COLUNAS = [
    "id", "data", "descricao", "contraparte", "valor", "natureza", "fonte",
    "categoria", "prob_categoria", "subcategoria", "prob_subcategoria",
    "tempo_ms", "custo_usd", "origem",
    "gabarito_categoria", "gabarito_subcategoria",
]


# ---------------------------------------------------------------------------
# Perguntas (puro)
# ---------------------------------------------------------------------------

def opcoes_categoria(natureza: str, fonte: str, catalogo: dict) -> list[dict]:
    """As categorias que o JEV pode escolher para esta transação.

    A padrão nunca entra: é dela que a transação quer sair, e o "nenhuma serve" faz
    o papel dela (mantê-la deixaria o resultado circular)."""
    ativas = [c for c in catalogo["categorias"] if c.get("ativa", True) and not c.get("padrao")]
    if natureza == "despesa":
        return [c for c in ativas if c["natureza"] == "despesa"]
    if fonte in FONTES_COM_ESTORNO:
        return ativas
    return [c for c in ativas if c["natureza"] == "receita"]


def subs_ativas(categoria_id, catalogo: dict) -> list[dict]:
    return [s for s in catalogo["subcategorias"]
            if s["categoria_id"] == categoria_id and s.get("ativa", True)]


def pergunta_categoria(transacao: dict, catalogo: dict) -> dict:
    """Choice da categoria. A descrição de cada opção lista as subs, que dizem ao
    modelo o que a categoria cobre melhor que o nome sozinho."""
    criterios = {}
    for c in opcoes_categoria(transacao["natureza"], transacao["fonte"], catalogo):
        if c["nome"] in DESCRICAO_CATEGORIA:
            criterios[c["nome"]] = DESCRICAO_CATEGORIA[c["nome"]]
            continue
        subs =[s["nome"] for s in subs_ativas(c["id"], catalogo)]
        criterios[c["nome"]] = f"inclui: {', '.join(subs)}" if subs else None
    criterios[NENHUMA] = "Nenhuma das outras categorias serve para esta transação."
    instrucoes = "Em qual categoria do orçamento doméstico esta transação se encaixa?"
    if transacao["natureza"] == "receita" and transacao["fonte"] in FONTES_COM_ESTORNO:
        instrucoes += (" Uma receita de extrato ou fatura costuma ser estorno ou crédito de "
                       "uma compra: nesse caso, escolha a categoria da compra.")
    return {"type": "choice", "instructions": instrucoes, "criteria": criterios}


def sub_generica(categoria: dict, catalogo: dict) -> str | None:
    """A sub "quando nada mais se aplica" da categoria: a de mesmo nome da categoria
    (Compras → Compras) ou, sem ela, "Outros". Com as duas, a de mesmo nome vence e
    "Outros" fica como opção comum. None se não há nenhuma."""
    nomes = [s["nome"] for s in subs_ativas(categoria["id"], catalogo)]
    for alvo in (categoria["nome"], "Outros"):
        achada = next((n for n in nomes if _norm(n) == _norm(alvo)), None)
        if achada is not None:
            return achada
    return None


def pergunta_subcategoria(categoria: dict, catalogo: dict) -> dict | None:
    """Choice da sub entre as subs ativas da categoria escolhida; None se ela não tem
    sub ativa (a pergunta não seria pergunta: só "sem subcategoria").

    Com sub genérica, "sem subcategoria" sai: no H1 o JEV fugia para ela quando não
    sabia, e o Caio usa a genérica. Descrição à mão vale mais que o critério da
    genérica (Alimentação → Outros diz o que cobre)."""
    subs = subs_ativas(categoria["id"], catalogo)
    if not subs:
        return None
    generica = sub_generica(categoria, catalogo)
    criterios = {}
    for s in subs:
        criterio = DESCRICAO_SUB.get((categoria["nome"], s["nome"]))
        if criterio is None and s["nome"] == generica:
            criterio = CRITERIO_GENERICA
        criterios[s["nome"]] = criterio
    if generica is None:
        criterios[SEM_SUB] = "A transação é desta categoria, mas nenhuma subcategoria se aplica."
    return {"type": "choice",
            "instructions": f"Dentro da categoria {categoria['nome']}, qual subcategoria?",
            "criteria": criterios}


def formatar_valor(centavos: int) -> str:
    """Centavos → "1.234,56", só com inteiros (nada de float no dinheiro)."""
    reais, cent = divmod(abs(int(centavos)), 100)
    milhar = f"{reais:,}".replace(",", ".")
    return f"{'-' if centavos < 0 else ''}{milhar},{cent:02d}"


def estado(transacao: dict) -> dict:
    """O que o JEV vê da transação. Contraparte pode ser nula (extrato não tem)."""
    if transacao["fonte"] not in FONTES:
        raise ValueError(f"fonte fora do vocabulário: {transacao['fonte']!r}")
    return {
        "descricao": transacao.get("descricao") or "",
        "contraparte": transacao.get("contraparte"),
        "valor": formatar_valor(transacao["valor_cents"]),
        "natureza": transacao["natureza"],
        "fonte": FONTE_EXPLICADA[transacao["fonte"]],
    }


def regra_fixa(transacao: dict) -> dict | None:
    """A resposta da regra fixa, ou None se nenhuma regra se aplica."""
    if (transacao.get("descricao") or "").strip().upper().startswith(PREFIXO_IFOOD):
        cat, sub = REGRA_IFOOD
        return {"categoria": cat, "prob_categoria": 1.0, "subcategoria": sub,
                "prob_subcategoria": 1.0, "tempo_ms": 0, "custo_usd": Decimal("0"),
                "origem": "regra"}
    return None


def amostra_do_gabarito(pendentes: list[dict], gabarito: list[dict]):
    """A amostra da rodada nova são os ids da planilha anterior (não se sorteia de
    novo: import novo muda a população e, com ela, o sorteio). Devolve as transações
    na ordem da planilha, o gabarito por id e quantos ids saíram por não estarem mais
    pendentes."""
    por_id = {str(t["id"]): t for t in pendentes}
    transacoes, gab, saidos = [], {}, 0
    for l in gabarito:
        i = str(l.get("id") or "").strip()
        if not i:
            continue
        if i not in por_id:
            saidos += 1
            continue
        transacoes.append(por_id[i])
        gab[i] = {"gabarito_categoria": l.get("gabarito_categoria") or "",
                  "gabarito_subcategoria": l.get("gabarito_subcategoria") or ""}
    return transacoes, gab, saidos


def sortear(ids: list, n: int, semente: int = SEMENTE) -> list:
    """Embaralha com semente fixa e pega os n primeiros: mesma entrada, mesma amostra
    (e uma amostra maior começa pela menor)."""
    ordem = sorted(ids, key=str)
    random.Random(semente).shuffle(ordem)
    return ordem[:n]


def selecionar(pendentes: list[dict], n: int, semente: int = SEMENTE) -> list[dict]:
    """As n transações da amostra, na ordem sorteada."""
    por_id = {str(t["id"]): t for t in pendentes}
    return [por_id[i] for i in sortear(list(por_id), n, semente)]


# ---------------------------------------------------------------------------
# Custo
# ---------------------------------------------------------------------------

def custo_jev(tokens: int) -> Decimal:
    return Decimal(tokens) * JEV_USD_POR_MTOK / _MILHAO


def tokens_estimados(est: dict, pergunta: dict) -> int:
    """~4 caracteres por token, por cima (quando a API não devolve `usage`)."""
    return math.ceil(len(json.dumps([est, pergunta], ensure_ascii=False)) / 4)


def estimar(transacoes: list[dict], catalogo: dict) -> Decimal:
    """O máximo que a amostra pode custar: por transação, a pergunta de categoria
    mais a maior pergunta de subcategoria das categorias que ela pode receber."""
    total = 0
    for t in transacoes:
        est = estado(t)
        if regra_fixa(t) is not None:
            continue  # a regra responde sem chamada
        total += tokens_estimados(est, pergunta_categoria(t, catalogo))
        subs = [pergunta_subcategoria(c, catalogo)
                for c in opcoes_categoria(t["natureza"], t["fonte"], catalogo)]
        total += max((tokens_estimados(est, p) for p in subs if p), default=0)
    return custo_jev(total)


# ---------------------------------------------------------------------------
# Classificar
# ---------------------------------------------------------------------------

def _perguntar(cliente, est: dict, nome: str, pergunta: dict, relogio):
    t0 = relogio()
    r = cliente.system_one(est, {nome: pergunta})
    ms = (relogio() - t0) * 1000
    resp = r.choices[nome]
    tokens = getattr(getattr(r, "usage", None), "input_tokens", None)
    if tokens is None:
        tokens = tokens_estimados(est, pergunta)
    return resp.choice, float(resp.confidence), ms, custo_jev(tokens)


def classificar(transacao: dict, catalogo: dict, cliente, relogio=time.perf_counter) -> dict:
    """Uma chamada por pergunta. A segunda só existe se a categoria escolhida tem sub
    ativa; "nenhuma serve" encerra ali. Regra fixa responde antes, sem chamada."""
    est = estado(transacao)
    regra = regra_fixa(transacao)
    if regra is not None:
        return regra
    cat, p_cat, ms, usd = _perguntar(cliente, est, "categoria",
                                     pergunta_categoria(transacao, catalogo), relogio)
    sub, p_sub = "", None
    escolhida = next((c for c in catalogo["categorias"] if c["nome"] == cat), None)
    if cat != NENHUMA and escolhida is not None:
        pergunta = pergunta_subcategoria(escolhida, catalogo)
        if pergunta is not None:
            sub, p_sub, ms2, usd2 = _perguntar(cliente, est, "subcategoria", pergunta, relogio)
            ms, usd = ms + ms2, usd + usd2
            if sub == SEM_SUB:
                sub = ""
    return {"categoria": cat, "prob_categoria": p_cat, "subcategoria": sub,
            "prob_subcategoria": p_sub, "tempo_ms": round(ms), "custo_usd": usd,
            "origem": "jev"}


def _num(v) -> str:
    """Vírgula decimal: o Excel brasileiro lê "0.93" como data ou texto."""
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.4f}".replace(".", ",")
    return str(v).replace(".", ",")


def linha_csv(t: dict, r: dict, gabarito: dict | None = None) -> dict:
    gab = gabarito or {}
    return {
        "id": str(t["id"]), "data": str(t["data"]), "descricao": t.get("descricao") or "",
        "contraparte": t.get("contraparte") or "", "valor": formatar_valor(t["valor_cents"]),
        "natureza": t["natureza"], "fonte": t["fonte"],
        "categoria": r["categoria"], "prob_categoria": _num(r["prob_categoria"]),
        "subcategoria": r["subcategoria"], "prob_subcategoria": _num(r["prob_subcategoria"]),
        "tempo_ms": str(r["tempo_ms"]), "custo_usd": _num(r["custo_usd"]),
        "origem": r.get("origem", "jev"),
        "gabarito_categoria": gab.get("gabarito_categoria", ""),
        "gabarito_subcategoria": gab.get("gabarito_subcategoria", ""),
    }


def gravar_csv(caminho: pathlib.Path, linhas: list[dict]) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with open(caminho, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUNAS, delimiter=";")
        w.writeheader()
        w.writerows(linhas)


def ler_csv(caminho: pathlib.Path) -> list[dict]:
    with open(caminho, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh, delimiter=";"))


def amostra(transacoes: list[dict], catalogo: dict, cliente, *, csv_saida=CSV_PADRAO,
            teto: Decimal = TETO_USD, saida=print, relogio=time.perf_counter,
            gabarito: dict | None = None):
    """Orça e só então pergunta. Devolve as linhas gravadas, ou None se a estimativa
    passou do teto (nenhuma chamada feita). `cliente` pode ser uma fábrica (callable
    sem argumentos): assim o SDK só é importado se o orçamento passar. `gabarito`
    (id → gabarito_categoria/gabarito_subcategoria) é copiado para a planilha."""
    est = estimar(transacoes, catalogo)
    saida(f"estimativa ({len(transacoes)} transações × até 2 perguntas): US$ {est:.6f}")
    if est > teto:
        saida(f"ABORTADO: a estimativa passa do teto de US$ {teto}; nada foi chamado.")
        return None
    if callable(cliente) and not hasattr(cliente, "system_one"):
        cliente = cliente()
    gabarito = gabarito or {}
    linhas = []
    for i, t in enumerate(transacoes, 1):
        linhas.append(linha_csv(t, classificar(t, catalogo, cliente, relogio),
                                gabarito.get(str(t["id"]))))
        saida(f"{i:3d}/{len(transacoes)}")
    gravar_csv(csv_saida, linhas)
    gasto = sum((_dec(l["custo_usd"]) for l in linhas), Decimal("0"))
    saida(f"planilha: {csv_saida} ({len(linhas)} linhas); gasto medido US$ {gasto:.6f}")
    return linhas


# ---------------------------------------------------------------------------
# Relatório (puro)
# ---------------------------------------------------------------------------

def _dec(v) -> Decimal:
    t = (v or "").strip().replace(",", ".")
    return Decimal(t) if t else Decimal("0")


def _norm(v) -> str:
    return " ".join((v or "").strip().lower().split())


def _sub(v) -> str:
    """Sub vazia e "sem subcategoria" são a mesma resposta."""
    n = _norm(v)
    return "" if n == SEM_SUB else n


def medir(linhas: list[dict], pendentes: int, limiares=LIMIARES) -> dict:
    """Os números do relatório, separados do texto para o teste conferir. Só entram
    no acerto as linhas com gabarito de categoria preenchido."""
    casos = []
    for l in linhas:
        if not _norm(l.get("gabarito_categoria")):
            continue
        acerta_cat = _norm(l["categoria"]) == _norm(l["gabarito_categoria"])
        acerta_sub = _sub(l.get("subcategoria")) == _sub(l.get("gabarito_subcategoria"))
        casos.append({"linha": l, "p": float(_dec(l.get("prob_categoria"))),
                      "cat": acerta_cat, "ambas": acerta_cat and acerta_sub})
    n = len(casos)
    curva = []
    for lim in limiares:
        cobertos = [c for c in casos if c["p"] >= lim]
        curva.append({"limiar": lim, "cobertos": len(cobertos),
                      "acerto_categoria": sum(c["cat"] for c in cobertos),
                      "acerto_ambas": sum(c["ambas"] for c in cobertos)})
    discordam = [c["linha"] for c in casos if not c["ambas"]]
    custo_medio = (sum((_dec(l.get("custo_usd")) for l in linhas), Decimal("0")) / len(linhas)
                   if linhas else Decimal("0"))
    return {"n": n, "acerto_categoria": sum(c["cat"] for c in casos),
            "acerto_ambas": sum(c["ambas"] for c in casos), "curva": curva,
            "discordam": discordam, "pendentes": pendentes,
            "custo_medio": custo_medio, "custo_pendentes": custo_medio * pendentes}


def _pct(a: int, n: int) -> str:
    return f"{(Decimal(100 * a) / n).quantize(Decimal('1'), ROUND_HALF_UP)}%" if n else "—"


def montar_relatorio(linhas: list[dict], pendentes: int) -> str:
    m = medir(linhas, pendentes)
    n = m["n"]
    out = [f"Amostra: {len(linhas)} transações, {n} com gabarito.", "",
           f"Acerto da categoria:            {m['acerto_categoria']}/{n} ({_pct(m['acerto_categoria'], n)})",
           f"Acerto de categoria e sub:      {m['acerto_ambas']}/{n} ({_pct(m['acerto_ambas'], n)})",
           "", "Curva por confiança da categoria (cobertura = quanto daria para aplicar sem revisão):",
           "  limiar  cobertura      acerto categoria  acerto cat+sub"]
    for c in m["curva"]:
        k = c["cobertos"]
        out.append(f"  >= {c['limiar']:.2f}  {k:3d}/{n} ({_pct(k, n):>4})  "
                   f"{c['acerto_categoria']:3d}/{k} ({_pct(c['acerto_categoria'], k):>4})  "
                   f"{c['acerto_ambas']:3d}/{k} ({_pct(c['acerto_ambas'], k):>4})")
    out += ["", f"Discordâncias ({len(m['discordam'])}):"]
    for l in m["discordam"]:
        jev = f"{l['categoria']} › {l.get('subcategoria') or '—'} ({l.get('prob_categoria')})"
        gab = f"{l['gabarito_categoria']} › {l.get('gabarito_subcategoria') or '—'}"
        out.append(f"  {l['descricao'][:50]:50}  JEV: {jev}  gabarito: {gab}")
    out += ["", f"Custo médio por transação: US$ {m['custo_medio']:.6f}; "
                f"para as {pendentes} pendentes: US$ {m['custo_pendentes']:.4f}"]
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Banco (só leitura) e credenciais
# ---------------------------------------------------------------------------

PENDENTES_SQL = """
select t.id, t.data, t.descricao, t.contraparte_nome, (t.valor_final * 100)::bigint,
       t.natureza, t.fonte
  from transacoes t join categorias c on c.id = t.categoria_id
 where c.padrao
 order by t.id
"""
# Todas as linhas na padrão, não só as que contam no resumo: isto não é leitura
# agregada de dinheiro, é a lista do que precisa de categoria (membro escondido de
# grupo também precisa).
CONTAGEM_SQL = ("select count(*) from transacoes t join categorias c on c.id = t.categoria_id "
                "where c.padrao")


def ler_pendentes(cur) -> list[dict]:
    cur.execute(PENDENTES_SQL)
    return [{"id": r[0], "data": r[1], "descricao": r[2], "contraparte": r[3],
             "valor_cents": int(r[4]), "natureza": r[5], "fonte": r[6]} for r in cur.fetchall()]


def ler_catalogo(cur) -> dict:
    """Como tools/categorias.carregar_catalogo, com a natureza (que a regra das opções usa)."""
    cur.execute("select id, nome, natureza, padrao, ativa from categorias where ativa")
    cats = [{"id": r[0], "nome": r[1], "natureza": r[2], "padrao": r[3], "ativa": r[4]}
            for r in cur.fetchall()]
    cur.execute("select id, categoria_id, nome, ativa from subcategorias where ativa")
    subs = [{"id": r[0], "categoria_id": r[1], "nome": r[2], "ativa": r[3]} for r in cur.fetchall()]
    return {"categorias": cats, "subcategorias": subs}


def conectar():
    import psycopg
    from tools.db import url_do_banco

    conn = psycopg.connect(url_do_banco(raiz=ROOT))
    conn.read_only = True  # o spike não grava: o banco recusa qualquer escrita
    return conn


def chave_typesafe(env=None, raiz=ROOT) -> str:
    """Ambiente → .dev.vars da pasta → .dev.vars do checkout principal (worktree)."""
    from tools.db import _git_common_dir, ler_dev_vars

    env = os.environ if env is None else env
    if env.get("TYPESAFE_API_KEY", "").strip():
        return env["TYPESAFE_API_KEY"].strip()
    pastas = [pathlib.Path(raiz)]
    comum = _git_common_dir(raiz)
    if comum:
        pastas.append(pathlib.Path(raiz, comum).resolve().parent)
    for p in pastas:
        arq = p / ".dev.vars"
        if arq.exists():
            v = ler_dev_vars(arq.read_text(encoding="utf-8")).get("TYPESAFE_API_KEY", "").strip()
            if v:
                return v
    raise SystemExit("TYPESAFE_API_KEY: nem no ambiente nem em .dev.vars")


def cliente_jev_real():
    """O cliente do SDK oficial. Import aqui dentro: o CI não tem o typesafe-sdk."""
    from typesafe_sdk import TypeSafeClient

    return TypeSafeClient(api_key=chave_typesafe(), model=JEV_MODELO)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("amostra", help="pergunta ao JEV e grava a planilha")
    a.add_argument("--n", type=int, default=60, help="tamanho do sorteio (ignorado com --gabarito)")
    a.add_argument("--gabarito", type=pathlib.Path, default=None,
                   help="planilha anterior: usa os ids dela (sem sortear) e copia o gabarito por id")
    a.add_argument("--csv", type=pathlib.Path, default=CSV_PADRAO)
    r = sub.add_parser("relatorio", help="lê a planilha com o gabarito e imprime o relatório")
    r.add_argument("--csv", type=pathlib.Path, default=CSV_PADRAO)
    r.add_argument("--pendentes", type=int, default=None,
                   help="contagem para o custo estimado (sem ela, lê do banco)")
    args = ap.parse_args(argv)

    if args.cmd == "relatorio":
        pendentes = args.pendentes
        if pendentes is None:
            with conectar() as conn, conn.cursor() as cur:
                cur.execute(CONTAGEM_SQL)
                pendentes = cur.fetchone()[0]
        print(montar_relatorio(ler_csv(args.csv), pendentes))
        return

    with conectar() as conn, conn.cursor() as cur:
        todas = ler_pendentes(cur)
        catalogo = ler_catalogo(cur)
    gab = None
    if args.gabarito is not None:
        if args.gabarito.resolve() == args.csv.resolve():
            # a planilha nova sobrescreveria o gabarito do Caio antes de copiá-lo
            raise SystemExit("--csv não pode ser a planilha do --gabarito; escolha outro --csv")
        transacoes, gab, saidos = amostra_do_gabarito(todas, ler_csv(args.gabarito))
        print(f"gabarito: {len(transacoes)} ids ainda pendentes; "
              f"{saidos} saíram por não estarem mais pendentes")
    else:
        transacoes = selecionar(todas, args.n)
    print(f"pendentes: {len(todas)}; amostra: {len(transacoes)}")
    amostra(transacoes, catalogo, cliente_jev_real, csv_saida=args.csv, gabarito=gab)


if __name__ == "__main__":
    main()
