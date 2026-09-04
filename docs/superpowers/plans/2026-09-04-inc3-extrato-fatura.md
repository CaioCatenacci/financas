# Inc 3 — Bloco 2: ingestão de extrato + fatura (Itaú) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingerir extrato bancário e fatura de cartão (Itaú, PDF) como o registro completo do ledger, reconciliando contra o que já foi capturado (fotos/texto) e sem contar em dobro, com o "não-gasto" fora do Resumo.

**Architecture:** Parsing determinístico do texto (pypdf) em ferramentas locais `tools/` com preview p/ aprovar (padrão `import_planilha`). O extrato é a espinha dorsal; reconciliação por valor+data(±3d) casa com transações existentes; flag `computa_resumo` exclui transferências/investimentos/pagamento-de-fatura dos resumos. Categorização reusa as associações do Inc 2 (descritor do estabelecimento gravado em `contraparte_nome`).

**Tech Stack:** Python 3 (pypdf, psycopg) p/ os tools; Cloudflare Workers (JS ESM) p/ db/resumos/UI; Neon Postgres; `node --test` + `pytest`.

**Spec:** `docs/superpowers/specs/2026-09-04-inc3-extrato-fatura-design.md`

## Global Constraints

- Dinheiro em **centavos inteiros**; parsing converte string BR → cents (vírgula decimal, ponto milhar); agregação em SQL. Nada de float acumulado.
- Parsers (`extrato_itau.py`, `fatura_itau.py`, `classificar_linha.py`, `reconciliar.py`) são **puros**: sem rede/banco/I/O; tudo por parâmetro. O I/O (pypdf, psycopg) fica nos `importar_*.py`.
- Comentários e testes **em português**, explicando o *porquê*.
- Modelo por id: grava `categoria_id`/`subcategoria_id` (nunca colunas string). `fonte='extrato'|'fatura'` (já no vocabulário fixo). `natureza ∈ {despesa,receita}`.
- **Não-gasto** = `computa_resumo=false` + categoria organizacional ("Transferências"/"Investimentos"). A flag é a fonte da verdade; **todos os resumos filtram `and t.computa_resumo`**.
- **Checksum obrigatório:** soma dos lançamentos tem que bater com a variação de saldo (extrato) / total (fatura); não bateu → aborta sem gravar.
- **Idempotência:** `linha_hash` único (parcial, quando não-nulo). Reimport / meses sobrepostos não duplicam.
- Reconciliação nunca auto-casa com >1 candidato — ambíguo vai pro preview.
- `npm test` e `python -m pytest tests/` verdes antes de cada commit.

---

## Estrutura de arquivos

```
migrations/0006_computa_resumo.sql   NOVO — computa_resumo + linha_hash + seed categorias
schema.sql                           MOD  — reflete as colunas/categorias novas
worker/db.js                         MOD  — resumos filtram computa_resumo; atualizarTransacao aceita a flag
worker/db.test.mjs                   MOD  — testes dos resumos + flag
tools/extrato_itau.py                NOVO — parse_extrato + checksum (puro)
tools/fatura_itau.py                 NOVO — parse_fatura (puro)
tools/classificar_linha.py           NOVO — normalizar_descritor, reconhecer_nao_gasto, classificar (puro)
tools/reconciliar.py                 NOVO — linha_hash + reconciliar_linha (puro)
tools/importar_extrato.py            NOVO — orquestra: pypdf→parse→checksum→classifica→reconcilia→preview→grava
tools/importar_fatura.py             NOVO — idem p/ fatura + marca pagamento no extrato
tests/test_extrato_itau.py           NOVO
tests/test_fatura_itau.py            NOVO
tests/test_classificar_linha.py      NOVO
tests/test_reconciliar.py            NOVO
public/{index.html,app.js,app.test.mjs,shell.css}  MOD — Fase 3: selo/toggle/filtro "fora do resumo"
```

---

# FASE 1 — Extrato (espinha dorsal)

## Task 1: Migração 0006 (computa_resumo + linha_hash + categorias)

**Files:** Create `migrations/0006_computa_resumo.sql`; Modify `schema.sql`.
(Controller-authored; aplicada no Neon no checkpoint de infra, como nos Incs anteriores.)

- [ ] **Step 1: escrever `migrations/0006_computa_resumo.sql`**

```sql
-- Inc 3 bloco 2: flag de "não-gasto" + chave de linha p/ idempotência/reconciliação. Aditiva.
alter table transacoes add column if not exists computa_resumo boolean not null default true;
alter table transacoes add column if not exists linha_hash text;
create unique index if not exists idx_transacoes_linha_hash on transacoes (linha_hash)
  where linha_hash is not null;
-- categorias de organização p/ o não-gasto (a flag é que exclui do Resumo; a categoria é rótulo)
insert into categorias (nome, natureza) values ('Transferências','despesa'), ('Investimentos','despesa')
  on conflict (nome) do nothing;
```

- [ ] **Step 2: refletir no `schema.sql`** — na tabela `transacoes`, após `subcategoria_id`:

```sql
  computa_resumo   boolean not null default true,     -- Inc 3 b2: false = não entra no Resumo
  linha_hash       text,                              -- Inc 3 b2: chave estável da linha de extrato/fatura
```
E, após a definição de `transacoes`, o índice:
```sql
create unique index idx_transacoes_linha_hash on transacoes (linha_hash) where linha_hash is not null;
```

- [ ] **Step 3: commit** (a aplicação no Neon é no checkpoint de infra — controller/você roda o SQL)

```bash
git add migrations/0006_computa_resumo.sql schema.sql
git commit -m "feat: migração 0006 (computa_resumo + linha_hash + categorias de organização)"
```

---

## Task 2: worker/db.js — resumos filtram `computa_resumo`

**Files:** Modify `worker/db.js`, `worker/db.test.mjs`.

**Interfaces:**
- Consumes: coluna `computa_resumo` (Task 1).
- Produces: todos os `resumo*` passam a ignorar linhas com `computa_resumo=false`.

- [ ] **Step 1: RED** — adicionar em `worker/db.test.mjs`:

```js
test("resumoKPIs ignora não-gasto (computa_resumo)", async () => {
  const sql = fakeSql([{ receita: "0", despesa: "0", reembolso: "0" }]);
  const db = criarDb(sql);
  await db.resumoKPIs("2026-01-01", "2026-12-31");
  assert.match(sql.chamadas[0].text, /computa_resumo/i);
});

test("resumoPorCategoria ignora não-gasto", async () => {
  const sql = fakeSql([{ macro: "Casa", total: "1" }]);
  const db = criarDb(sql);
  await db.resumoPorCategoria("2026-01-01", "2026-12-31");
  assert.match(sql.chamadas[0].text, /computa_resumo/i);
});

test("resumoPorPessoa ignora não-gasto", async () => {
  const sql = fakeSql([{ pessoa: "Caio", natureza: "despesa", total: "1" }]);
  const db = criarDb(sql);
  await db.resumoPorPessoa("2026-01-01", "2026-12-31");
  assert.match(sql.chamadas[0].text, /computa_resumo/i);
});
```

- [ ] **Step 2: verificar falha** — `node --test worker/db.test.mjs` → FAIL (sem `computa_resumo` nas queries).

- [ ] **Step 3: GREEN** — em `worker/db.js`, adicionar `and t.computa_resumo` (ou `and computa_resumo` onde não há alias) no WHERE de **cada** resumo. Especificamente:
  - `resumoPorCategoria`: no `where t.data >= ... and t.data <= ...` acrescentar `and t.computa_resumo`.
  - `resumoMensal`: `where data >= ${de} and data <= ${ate} and computa_resumo`.
  - `resumoKPIs`: `where data >= ${de} and data <= ${ate} and computa_resumo`.
  - `resumoMesVsAnterior`: no `where t.natureza = 'despesa' and ...` acrescentar `and t.computa_resumo`.
  - `resumoReembolsoAno`: `where t.valor_reembolso > 0 and t.computa_resumo`.
  - `resumoPorPessoa`: no `where t.data >= ... and t.data <= ...` acrescentar `and t.computa_resumo`.

- [ ] **Step 4: PASS** — `node --test worker/db.test.mjs` e `npm test` verdes.

- [ ] **Step 5: commit**

```bash
git add worker/db.js worker/db.test.mjs
git commit -m "feat: resumos ignoram não-gasto (computa_resumo)"
```

---

## Task 3: `tools/extrato_itau.py` — parser + checksum (puro)

**Files:** Create `tools/extrato_itau.py`, `tests/test_extrato_itau.py`.

**Interfaces:**
- Produces: `parse_extrato(texto) -> {"linhas": [ {data:"AAAA-MM-DD", descricao:str, valor_cents:int, natureza:"despesa"|"receita", ordinal:int} ], "saldos": [ {data, saldo_cents} ]}`.
  `conferir_checksum(linhas, saldos) -> {"ok":bool, "diferenca_cents":int}` (variação de saldo entre o 1º e o último SALDO DO DIA deve igualar a soma dos lançamentos no intervalo).

- [ ] **Step 1: RED** — `tests/test_extrato_itau.py`:

```python
from tools.extrato_itau import parse_extrato, conferir_checksum

TEXTO = """10/12/2025 SALDO DO DIA 38.681,68
10/12/2025 PIX QRS MAGALUPAY10/12 -194,78
10/12/2025 PIX TRANSF CAIO CA10/12 30.000,00
09/12/2025 SALDO DO DIA 11.047,08
09/12/2025 PIX TRANSF QUINTOA09/12 0,01
"""

def test_ignora_saldo_do_dia_e_parseia_linhas():
    r = parse_extrato(TEXTO)
    descr = [l["descricao"] for l in r["linhas"]]
    assert "SALDO DO DIA" not in descr
    assert len(r["linhas"]) == 3

def test_sinal_define_natureza_e_valor_em_cents():
    r = parse_extrato(TEXTO)
    saida = next(l for l in r["linhas"] if "MAGALUPAY" in l["descricao"])
    assert saida["valor_cents"] == 19478 and saida["natureza"] == "despesa"
    entrada = next(l for l in r["linhas"] if "CAIO CA" in l["descricao"])
    assert entrada["valor_cents"] == 3000000 and entrada["natureza"] == "receita"

def test_data_iso_e_ordinal_por_dia():
    r = parse_extrato(TEXTO)
    d10 = [l for l in r["linhas"] if l["data"] == "2025-12-10"]
    assert [l["ordinal"] for l in d10] == [0, 1]   # ordem de aparição no dia

def test_checksum_bate():
    r = parse_extrato(TEXTO)
    # saldos: 09/12=11.047,08 → 10/12=38.681,68 ; soma dos lançamentos de 10/12 = -194,78+30.000,00
    # (o intervalo do checksum é entre SALDOs consecutivos)
    c = conferir_checksum(r["linhas"], r["saldos"])
    assert c["ok"] is True

def test_checksum_detecta_diferenca():
    r = parse_extrato(TEXTO)
    r["linhas"][0]["valor_cents"] += 100   # corrompe
    c = conferir_checksum(r["linhas"], r["saldos"])
    assert c["ok"] is False and c["diferenca_cents"] != 0
```

- [ ] **Step 2: verificar falha** — `python -m pytest tests/test_extrato_itau.py` → ImportError/fail.

- [ ] **Step 3: GREEN** — `tools/extrato_itau.py`:

```python
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
```

- [ ] **Step 4: PASS** — `python -m pytest tests/test_extrato_itau.py`.

- [ ] **Step 5: commit**

```bash
git add tools/extrato_itau.py tests/test_extrato_itau.py
git commit -m "feat: extrato_itau.py — parse determinístico + checksum (puro)"
```

---

## Task 4: `tools/classificar_linha.py` — descritor, não-gasto, categoria (puro)

**Files:** Create `tools/classificar_linha.py`, `tests/test_classificar_linha.py`.

**Interfaces:**
- `normalizar_descritor(descricao) -> str` — remove data-sufixo (`…30/12`), prefixos de meio conhecidos, números soltos; colapsa espaços; minúsculo. Mesmo estabelecimento em meses diferentes → mesma string.
- `reconhecer_nao_gasto(descricao) -> str|None` — retorna `"Transferências"` / `"Investimentos"` / `"Fatura de cartão"` se casar um padrão de não-gasto; senão `None`.
- `classificar(descricao, catalogo, associacoes) -> {"contraparte_nome":str, "categoria_nome":str|None, "sub_nome":str|None, "computa_resumo":bool, "categoria_org":str|None}` — junta tudo: descritor→contraparte; não-gasto→flag+categoria org; senão associação aprendida (por descritor normalizado) → categoria; senão None (o importador cai em Outros).
  `associacoes` = dict `chave_normalizada -> {"categoria_nome":str, "sub_nome":str|None}` (montado pelo importador a partir da tabela).

- [ ] **Step 1: RED** — `tests/test_classificar_linha.py`:

```python
from tools.classificar_linha import normalizar_descritor, reconhecer_nao_gasto, classificar

def test_normaliza_colapsa_mesmo_estabelecimento_entre_meses():
    a = normalizar_descritor("PIX QRS AMAZON.COM.30/12")
    b = normalizar_descritor("PIX QRS AMAZON.COM.28/11")
    assert a == b and "amazon" in a and "30/12" not in a

def test_reconhece_nao_gasto():
    assert reconhecer_nao_gasto("PIX TRANSF CAIO CA10/12") == "Transferências"
    assert reconhecer_nao_gasto("APLICACAO PERSONDIF INT") == "Investimentos"
    assert reconhecer_nao_gasto("COR COMP CDB BAN") == "Investimentos"
    assert reconhecer_nao_gasto("PIX QRS MAGALUPAY10/12") is None  # gasto normal

def test_classificar_nao_gasto_marca_flag_e_categoria_org():
    r = classificar("PIX TRANSF CAIO CA10/12", catalogo={}, associacoes={})
    assert r["computa_resumo"] is False and r["categoria_org"] == "Transferências"

def test_classificar_gasto_usa_associacao_aprendida():
    assoc = {normalizar_descritor("PIX QRS MAGALUPAY10/12"): {"categoria_nome": "Casa", "sub_nome": "Mercado"}}
    r = classificar("PIX QRS MAGALUPAY10/12", catalogo={}, associacoes=assoc)
    assert r["computa_resumo"] is True
    assert r["categoria_nome"] == "Casa" and r["sub_nome"] == "Mercado"
    assert "magalupay" in r["contraparte_nome"]

def test_classificar_gasto_sem_associacao_fica_none():
    r = classificar("PIX QRS DESCONHECIDO01/01", catalogo={}, associacoes={})
    assert r["computa_resumo"] is True and r["categoria_nome"] is None
```

- [ ] **Step 2: verificar falha** — `python -m pytest tests/test_classificar_linha.py`.

- [ ] **Step 3: GREEN** — `tools/classificar_linha.py`:

```python
"""Classificação de linha de extrato/fatura (puro). Deriva o descritor do estabelecimento,
reconhece não-gasto por padrões, e resolve categoria via associações aprendidas (Inc 2)."""
import re
from tools.contraparte import normalizar_nome

# padrões de NÃO-GASTO (conservador; editável). Ordem importa.
_NAO_GASTO = [
    (re.compile(r"\bAPLICACAO\b|PERSONDIF|COR COMP CDB|\bCDB\b|PERS BLACK", re.I), "Investimentos"),
    (re.compile(r"PIX TRANSF (CAIO|PAOLA)\b", re.I), "Transferências"),  # contas próprias
    (re.compile(r"PAGAMENTO.*(CARTAO|FATURA)|DEB.*CARTAO", re.I), "Fatura de cartão"),
]
_DATA_SUFIXO = re.compile(r"\s*\d{2}/\d{2}\s*$")            # '…30/12' no fim
_PREFIXOS = re.compile(r"^(PIX QRS|PIX TRANSF|PAG BOLETO|DA|TED|DOC)\b\s*", re.I)

def normalizar_descritor(descricao):
    s = _DATA_SUFIXO.sub("", descricao.strip())
    s = _PREFIXOS.sub("", s)
    s = re.sub(r"\d{3,}", " ", s)          # números longos (docs/contas) viram espaço
    s = re.sub(r"[.\-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s

def reconhecer_nao_gasto(descricao):
    for rx, cat in _NAO_GASTO:
        if rx.search(descricao):
            return cat
    return None

def classificar(descricao, catalogo, associacoes):
    org = reconhecer_nao_gasto(descricao)
    descritor = normalizar_descritor(descricao)
    if org:
        return {"contraparte_nome": descritor, "categoria_nome": None, "sub_nome": None,
                "computa_resumo": False, "categoria_org": org}
    chave = normalizar_nome(descritor)
    a = associacoes.get(chave)
    return {"contraparte_nome": descritor,
            "categoria_nome": a["categoria_nome"] if a else None,
            "sub_nome": a["sub_nome"] if a else None,
            "computa_resumo": True, "categoria_org": None}
```

- [ ] **Step 4: PASS** — `python -m pytest tests/test_classificar_linha.py`.

- [ ] **Step 5: commit**

```bash
git add tools/classificar_linha.py tests/test_classificar_linha.py
git commit -m "feat: classificar_linha.py — descritor + não-gasto + categoria aprendida (puro)"
```

---

## Task 5: `tools/reconciliar.py` — linha_hash + matching (puro)

**Files:** Create `tools/reconciliar.py`, `tests/test_reconciliar.py`.

**Interfaces:**
- `linha_hash(conta, data, descricao, valor_cents, ordinal) -> str` — sha256 hex estável.
- `reconciliar_linha(linha, existentes) -> {"status":"casado"|"ambiguo"|"novo", "match_id":str|None}` — `existentes` = lista de transações já no banco `[{id, data, valor_cents}]` no intervalo. Casa por `valor_cents` igual e `abs(dias(data, existente.data)) <= 3`. 1 candidato → casado; >1 → ambiguo; 0 → novo.

- [ ] **Step 1: RED** — `tests/test_reconciliar.py`:

```python
from tools.reconciliar import linha_hash, reconciliar_linha

def test_linha_hash_estavel_e_sensivel():
    h1 = linha_hash("011638-2", "2025-12-10", "PIX QRS X10/12", 19478, 0)
    h2 = linha_hash("011638-2", "2025-12-10", "PIX QRS X10/12", 19478, 0)
    h3 = linha_hash("011638-2", "2025-12-10", "PIX QRS X10/12", 19478, 1)  # ordinal difere
    assert h1 == h2 and h1 != h3

def test_casa_um_candidato_na_janela():
    linha = {"data": "2025-12-10", "valor_cents": 19478}
    ex = [{"id": "t1", "data": "2025-12-11", "valor_cents": 19478}]  # 1 dia de diferença
    r = reconciliar_linha(linha, ex)
    assert r["status"] == "casado" and r["match_id"] == "t1"

def test_ambiguo_com_dois_candidatos():
    linha = {"data": "2025-12-10", "valor_cents": 5000}
    ex = [{"id": "a", "data": "2025-12-10", "valor_cents": 5000},
          {"id": "b", "data": "2025-12-12", "valor_cents": 5000}]
    assert reconciliar_linha(linha, ex)["status"] == "ambiguo"

def test_novo_quando_fora_da_janela_ou_valor_diferente():
    linha = {"data": "2025-12-10", "valor_cents": 5000}
    ex = [{"id": "a", "data": "2025-12-20", "valor_cents": 5000},   # fora da janela
          {"id": "b", "data": "2025-12-10", "valor_cents": 9999}]   # valor diferente
    assert reconciliar_linha(linha, ex)["status"] == "novo"
```

- [ ] **Step 2: verificar falha** — `python -m pytest tests/test_reconciliar.py`.

- [ ] **Step 3: GREEN** — `tools/reconciliar.py`:

```python
"""Reconciliação (puro): chave estável da linha e matching por valor+data(±3d)."""
import hashlib
from datetime import date

def linha_hash(conta, data, descricao, valor_cents, ordinal):
    base = f"{conta}|{data}|{descricao}|{valor_cents}|{ordinal}"
    return hashlib.sha256(base.encode("utf-8")).hexdigest()

def _dias(a, b):
    ya, ma, da = (int(x) for x in a.split("-"))
    yb, mb, db = (int(x) for x in b.split("-"))
    return abs((date(ya, ma, da) - date(yb, mb, db)).days)

def reconciliar_linha(linha, existentes):
    cand = [e for e in existentes
            if e["valor_cents"] == linha["valor_cents"] and _dias(linha["data"], e["data"]) <= 3]
    if len(cand) == 1:
        return {"status": "casado", "match_id": cand[0]["id"]}
    if len(cand) > 1:
        return {"status": "ambiguo", "match_id": None}
    return {"status": "novo", "match_id": None}
```

- [ ] **Step 4: PASS** — `python -m pytest tests/test_reconciliar.py`.

- [ ] **Step 5: commit**

```bash
git add tools/reconciliar.py tests/test_reconciliar.py
git commit -m "feat: reconciliar.py — linha_hash + matching valor+data(±3d) (puro)"
```

---

## Task 6: `tools/importar_extrato.py` — orquestração + preview + gravação (I/O)

**Files:** Create `tools/importar_extrato.py`.
**Interfaces:** Consumes Tasks 3-5 + `tools/categorias.py` (`carregar_catalogo`, `resolver_categoria`) + `tools/contraparte.py` (`normalizar_nome`). CLI: `python tools/importar_extrato.py <pdf> [--conta X] [--commit]`.

- [ ] **Step 1: implementar** `tools/importar_extrato.py`:

```python
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
```

- [ ] **Step 2: smoke test (controller/você)** — `python tools/importar_extrato.py <pdf-exemplo> --conta 011638-2` (dry-run): checksum ok e o preview mostra contagens coerentes. **Não** roda no CI (precisa de PDF + DB).

- [ ] **Step 3: commit**

```bash
git add tools/importar_extrato.py
git commit -m "feat: importar_extrato.py — parse+checksum+reconciliação+preview+gravação (dry-run por padrão)"
```

---

# FASE 2 — Fatura

## Task 7: `tools/fatura_itau.py` — parser da fatura (puro)

**Files:** Create `tools/fatura_itau.py`, `tests/test_fatura_itau.py`.

**Interfaces:**
- `parse_fatura(texto, ano) -> {"itens": [ {data:"AAAA-MM-DD", descricao:str, valor_cents:int, parcela:str|None} ], "total_cents": int}` — data `dd/mm` + `ano`; `parcela` = "x/y" se aparecer no texto; ignora linhas de resumo/limite. `total_cents` = "Total dos lançamentos atuais".

- [ ] **Step 1: RED** — `tests/test_fatura_itau.py`:

```python
from tools.fatura_itau import parse_fatura

TEXTO = """Lançamentos: compras e saques
DATA ESTABELECIMENTO VALOR EM R$
29/05 PARK & CO. ESTACIONAME SOROCABA 17,00
03/05 LOJA XPTO PARCELA 03/10 150,00
Total dos lançamentos atuais 167,00
"""

def test_parseia_itens_com_ano_do_periodo():
    r = parse_fatura(TEXTO, ano=2025)
    assert r["itens"][0]["data"] == "2025-05-29"
    assert r["itens"][0]["valor_cents"] == 1700

def test_captura_parcela():
    r = parse_fatura(TEXTO, ano=2025)
    parc = next(i for i in r["itens"] if "XPTO" in i["descricao"])
    assert parc["parcela"] == "03/10" and parc["valor_cents"] == 15000

def test_total():
    assert parse_fatura(TEXTO, ano=2025)["total_cents"] == 16700

def test_checksum_itens_vs_total():
    r = parse_fatura(TEXTO, ano=2025)
    assert sum(i["valor_cents"] for i in r["itens"]) == r["total_cents"]
```

- [ ] **Step 2: verificar falha** — `python -m pytest tests/test_fatura_itau.py`.

- [ ] **Step 3: GREEN** — `tools/fatura_itau.py`:

```python
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
```

- [ ] **Step 4: PASS** — `python -m pytest tests/test_fatura_itau.py`.

- [ ] **Step 5: commit**

```bash
git add tools/fatura_itau.py tests/test_fatura_itau.py
git commit -m "feat: fatura_itau.py — parse determinístico da fatura (puro)"
```

---

## Task 8: `tools/importar_fatura.py` — itens + marca pagamento no extrato (I/O)

**Files:** Create `tools/importar_fatura.py`.
**Interfaces:** Consumes Task 7 + `classificar`/`resolver_categoria`/`carregar_catalogo`/`carregar_associacoes` (reusa de importar_extrato via import). CLI: `python tools/importar_fatura.py <pdf> --ano 2025 --mes 05 [--commit]`.

- [ ] **Step 1: implementar** `tools/importar_fatura.py`:

```python
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
```

- [ ] **Step 2: smoke test (controller/você)** — `python tools/importar_fatura.py <fatura-exemplo> --ano 2025 --mes 05` (dry-run): itens batem com o total; preview coerente.

- [ ] **Step 3: commit**

```bash
git add tools/importar_fatura.py
git commit -m "feat: importar_fatura.py — itens da fatura + marca pagamento no extrato (dry-run por padrão)"
```

---

# FASE 3 — App (selo/toggle/filtro "fora do resumo")

## Task 9: worker — `atualizarTransacao` aceita `computa_resumo`

**Files:** Modify `worker/db.js`, `worker/db.test.mjs`.

**Interfaces:** `atualizarTransacao(id, c)` passa a aceitar `c.computa_resumo` (boolean). `/api PATCH` já encaminha `request.json()` — sem mudança na rota.

- [ ] **Step 1: RED** — `worker/db.test.mjs`:

```js
test("atualizarTransacao alterna computa_resumo", async () => {
  const existente = { id: "t1", data: "2026-01-01", categoria_id: "cCasa", subcategoria_id: null,
    valor_total: "100.00", valor_reembolso: "0.00", pessoa_id: null, natureza: "despesa",
    esfera: "pessoal", computa_resumo: true };
  const sql = fakeSql([existente]);
  const db = criarDb(sql);
  await db.atualizarTransacao("t1", { computa_resumo: false });
  const upd = sql.chamadas[1];
  assert.match(upd.text, /computa_resumo/i);
  assert.ok(upd.values.includes(false));
});
```

- [ ] **Step 2: verificar falha** — `node --test worker/db.test.mjs`.

- [ ] **Step 3: GREEN** — em `worker/db.js` `atualizarTransacao`, na leitura read-modify-write, adicionar:
```js
      const computa_resumo = c.computa_resumo === undefined ? t.computa_resumo : !!c.computa_resumo;
```
e incluir `computa_resumo = ${computa_resumo}` no `update transacoes set ...`.

- [ ] **Step 4: PASS** — `node --test worker/db.test.mjs` e `npm test`.

- [ ] **Step 5: commit**

```bash
git add worker/db.js worker/db.test.mjs
git commit -m "feat: atualizarTransacao aceita computa_resumo (toggle fora-do-resumo)"
```

---

## Task 10: App — selo, toggle e filtro "fora do resumo"

**Files:** Modify `public/app.js`, `public/index.html`, `public/app.test.mjs`, `public/shell.css`.

**Interfaces:** `filtrarTransacoes(rows, filtro)` ganha a dimensão `computa` (`""`=tudo | `"gasto"` | `"naogasto"`), casando `t.computa_resumo`. `drawRows` mostra selo "fora do resumo" quando `!t.computa_resumo`, com toggle → `PATCH {computa_resumo}`.

- [ ] **Step 1: RED** — em `public/app.test.mjs`, estender os testes de `filtrarTransacoes`:

```js
test("filtrarTransacoes por computa: só gasto / só não-gasto / tudo", () => {
  const rows = [
    { id: 1, computa_resumo: true, descricao: "mercado" },
    { id: 2, computa_resumo: false, descricao: "transf" },
  ];
  assert.deepEqual(filtrarTransacoes(rows, { computa: "gasto" }).map(t => t.id), [1]);
  assert.deepEqual(filtrarTransacoes(rows, { computa: "naogasto" }).map(t => t.id), [2]);
  assert.deepEqual(filtrarTransacoes(rows, { computa: "" }).map(t => t.id), [1, 2]);
});
```

- [ ] **Step 2: verificar falha** — `node --test public/app.test.mjs`.

- [ ] **Step 3: GREEN (pura)** — em `public/app.js`, em `filtrarTransacoes`, adicionar antes do `return true`:
```js
    if (filtro.computa === "gasto" && !t.computa_resumo) return false;
    if (filtro.computa === "naogasto" && t.computa_resumo) return false;
```

- [ ] **Step 4: GREEN (UI)** —
  - `public/index.html`: na toolbar `#filtros`, adicionar um `<select id="fcomputa">` com opções `""`=Tudo, `gasto`=Só gastos, `naogasto`=Só fora do resumo. `estado.filtro.computa` acompanha (no handler de filtros e no `Limpar`).
  - `public/app.js` `drawRows`: quando `!t.computa_resumo`, renderizar um selo (ex.: `<span class="selo-fora">fora do resumo</span>`) na linha; e um controle de toggle (um checkbox/botão) que faz `apiPatch('/api/transacoes/'+id, { computa_resumo: !t.computa_resumo })` e recarrega. Escapar com `esc`.
  - `public/shell.css`: `.selo-fora{font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:1px 7px}`.

- [ ] **Step 5: PASS + visual** — `node --test public/app.test.mjs` e `npm test` verdes; verificação visual fica com o controller (harness com mock, incluindo uma linha `computa_resumo:false`).

- [ ] **Step 6: commit**

```bash
git add public/app.js public/index.html public/app.test.mjs public/shell.css
git commit -m "feat: app — selo/toggle/filtro 'fora do resumo' (computa_resumo)"
```

---

## Checkpoint de infra

Após a Fase 1: aplicar **0006** no Neon (controller/você roda o SQL) → `npm test`+`pytest` → **smoke test** com o extrato de exemplo (dry-run: checksum ok, preview coerente) → `--commit` num período controlado → conferir no app (não-gasto fora do Resumo). Depois a Fase 2 (fatura, idem) e a Fase 3 (deploy do worker + app). Reconciliação real (fotos ↔ extrato) validada no smoke com dados de verdade.

---

## Self-Review

- **Cobertura da spec:** §2 decisões — extrato espinha/reconciliação (T5,T6) ✓; não-gasto flag+categoria (T1,T2,T4) ✓; parsing determinístico+checksum (T3,T7) ✓; ferramenta local+preview (T6,T8) ✓; fatura itens + marca pagamento (T8) ✓; reconciliação valor+data±3d (T5) ✓; categoria por descritor aprendido (T4) ✓; idempotência linha_hash (T5,T6,T8) ✓. §4 modelo de dados (T1) ✓. §5 componentes (T3-T8) ✓ + UI (T9,T10) ✓. §7 faseamento ✓.
- **Placeholders:** nenhum — funções puras têm código completo; scripts de I/O têm a lógica real.
- **Consistência de tipos:** `parse_extrato→{linhas,saldos}`, `classificar→{contraparte_nome,categoria_nome,sub_nome,computa_resumo,categoria_org}`, `reconciliar_linha→{status,match_id}`, `linha_hash(conta,data,descricao,valor_cents,ordinal)` — usados assim nos importadores (T6,T8). `carregar_associacoes`/`carregar_existentes` definidos em T6 e reusados em T8 (import).
- **Notas:** T2 e T9 tocam `worker/db.js`+`worker/db.test.mjs` (mesmos arquivos) — executar em série. T6 e T8 são I/O (não entram no CI); a garantia vem das funções puras (T3-T5,T7) + smoke manual. A aplicação da 0006 é gate de infra (controller).
