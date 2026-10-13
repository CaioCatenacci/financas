"""H1 — spike do JEV. Tudo com catálogo e transações inventados e cliente falso:
o CI não tem o typesafe-sdk nem rede, e o repositório é público."""
import subprocess
import sys
from decimal import Decimal
from types import SimpleNamespace

import pytest

from tools import jev_classificar as jev
from tools.jev_classificar import NENHUMA, SEM_SUB

CATALOGO = {
    "categorias": [
        {"id": "cA", "nome": "Alimentação", "natureza": "despesa", "padrao": False, "ativa": True},
        {"id": "cT", "nome": "Transporte", "natureza": "despesa", "padrao": False, "ativa": True},
        {"id": "cO", "nome": "Outros", "natureza": "despesa", "padrao": False, "ativa": True},
        {"id": "cV", "nome": "Velha", "natureza": "despesa", "padrao": False, "ativa": False},
        {"id": "cN", "nome": "Não Identificado", "natureza": "despesa", "padrao": True, "ativa": True},
        {"id": "cR", "nome": "Renda", "natureza": "receita", "padrao": False, "ativa": True},
    ],
    "subcategorias": [
        {"id": "sP", "categoria_id": "cA", "nome": "Padaria", "ativa": True},
        {"id": "sM", "categoria_id": "cA", "nome": "Mercado", "ativa": True},
        {"id": "sX", "categoria_id": "cA", "nome": "Extinta", "ativa": False},
        {"id": "sC", "categoria_id": "cT", "nome": "Combustível", "ativa": True},
        {"id": "sS", "categoria_id": "cR", "nome": "Salário", "ativa": True},
    ],
}


def tx(**kw):
    base = {"id": "t1", "data": "2026-01-05", "descricao": "PADARIA X", "contraparte": None,
            "valor_cents": 3000, "natureza": "despesa", "fonte": "fatura"}
    base.update(kw)
    return base


class ClienteFalso:
    """Responde por nome de pergunta e guarda o que recebeu (estado e perguntas)."""

    def __init__(self, respostas, tokens=100):
        self.respostas = respostas
        self.tokens = tokens
        self.chamadas = []

    def system_one(self, state, questions):
        self.chamadas.append((state, questions))
        (nome,) = questions
        escolha, conf = self.respostas[nome]
        return SimpleNamespace(
            choices={nome: SimpleNamespace(choice=escolha, confidence=conf)},
            usage=SimpleNamespace(input_tokens=self.tokens))

    def perguntas(self, nome):
        return [q for _, qs in self.chamadas for n, q in qs.items() if n == nome]


def opcoes(t):
    return list(jev.pergunta_categoria(t, CATALOGO)["criteria"])


# --- pergunta de categoria -------------------------------------------------

def test_despesa_escolhe_entre_as_ativas_de_despesa():
    assert opcoes(tx()) == ["Alimentação", "Transporte", "Outros", NENHUMA]


def test_receita_de_extrato_e_fatura_recebe_todas_porque_estorno_fica_sob_despesa():
    for fonte in ("extrato", "fatura"):
        assert opcoes(tx(natureza="receita", fonte=fonte)) == [
            "Alimentação", "Transporte", "Outros", "Renda", NENHUMA]


def test_receita_de_outra_fonte_so_ve_as_de_receita():
    for fonte in ("imagem", "manual", "importacao"):
        assert opcoes(tx(natureza="receita", fonte=fonte)) == ["Renda", NENHUMA]


def test_a_padrao_nunca_entra_e_nenhuma_serve_sempre_entra():
    # "nenhuma serve" faz o papel da padrão; mantê-la deixaria o resultado circular
    for natureza in ("despesa", "receita"):
        for fonte in jev.FONTES:
            ops = opcoes(tx(natureza=natureza, fonte=fonte))
            assert "Não Identificado" not in ops
            assert "Velha" not in ops
            assert ops[-1] == NENHUMA


# --- pergunta de subcategoria ----------------------------------------------

def test_sub_so_com_as_ativas_da_categoria_escolhida_mais_sem_subcategoria():
    cli = ClienteFalso({"categoria": ("Alimentação", 0.91), "subcategoria": ("Padaria", 0.77)})
    r = jev.classificar(tx(), CATALOGO, cli)
    (q,) = cli.perguntas("subcategoria")
    assert list(q["criteria"]) == ["Padaria", "Mercado", SEM_SUB]
    assert (r["categoria"], r["prob_categoria"], r["subcategoria"], r["prob_subcategoria"]) == (
        "Alimentação", 0.91, "Padaria", 0.77)


def test_categoria_sem_sub_ativa_nao_ganha_segunda_pergunta():
    cli = ClienteFalso({"categoria": ("Outros", 0.8)})
    r = jev.classificar(tx(), CATALOGO, cli)
    assert cli.perguntas("subcategoria") == []
    assert r["subcategoria"] == "" and r["prob_subcategoria"] is None


def test_nenhuma_serve_encerra_sem_perguntar_a_sub():
    cli = ClienteFalso({"categoria": (NENHUMA, 0.6)})
    r = jev.classificar(tx(), CATALOGO, cli)
    assert len(cli.chamadas) == 1 and cli.perguntas("subcategoria") == []
    assert r["categoria"] == NENHUMA and r["subcategoria"] == ""


def test_sem_subcategoria_vira_sub_vazia_com_probabilidade():
    cli = ClienteFalso({"categoria": ("Transporte", 0.9), "subcategoria": (SEM_SUB, 0.55)})
    r = jev.classificar(tx(), CATALOGO, cli)
    assert r["subcategoria"] == "" and r["prob_subcategoria"] == 0.55


# --- estado enviado --------------------------------------------------------

def test_estado_tem_descricao_contraparte_valor_natureza_e_fonte():
    cli = ClienteFalso({"categoria": (NENHUMA, 0.5)})
    jev.classificar(tx(contraparte="FULANO TESTE", valor_cents=123456), CATALOGO, cli)
    estado, _ = cli.chamadas[0]
    assert estado == {"descricao": "PADARIA X", "contraparte": "FULANO TESTE",
                      "valor": "1.234,56", "natureza": "despesa", "fonte": "fatura"}


def test_estado_aceita_contraparte_nula_e_todas_as_fontes():
    for fonte in ("extrato", "fatura", "imagem", "importacao", "manual"):
        cli = ClienteFalso({"categoria": (NENHUMA, 0.5)})
        jev.classificar(tx(fonte=fonte), CATALOGO, cli)
        estado, _ = cli.chamadas[0]
        assert estado["contraparte"] is None and estado["fonte"] == fonte


def test_fonte_fora_do_vocabulario_e_recusada():
    with pytest.raises(ValueError):
        jev.estado(tx(fonte="pix"))


# --- amostra ----------------------------------------------------------------

def test_sorteio_com_semente_fixa_repete_os_mesmos_ids():
    pend = [tx(id=f"id{i:03d}") for i in range(200)]
    a = [t["id"] for t in jev.selecionar(pend, 60)]
    b = [t["id"] for t in jev.selecionar(list(reversed(pend)), 60)]
    assert a == b and len(set(a)) == 60
    # não é simplesmente "os 60 primeiros": é aleatório
    assert a != [f"id{i:03d}" for i in range(60)]


def test_amostra_grava_a_planilha_com_gabarito_vazio(tmp_path):
    cli = ClienteFalso({"categoria": ("Alimentação", 0.91), "subcategoria": ("Padaria", 0.77)})
    saida = tmp_path / "jev" / "amostra.csv"
    jev.amostra([tx()], CATALOGO, cli, csv_saida=saida, saida=lambda *_: None)
    (linha,) = jev.ler_csv(saida)
    for col in ("id", "data", "descricao", "contraparte", "valor", "categoria", "prob_categoria",
                "subcategoria", "prob_subcategoria", "tempo_ms", "custo_usd",
                "gabarito_categoria", "gabarito_subcategoria"):
        assert col in linha
    assert linha["categoria"] == "Alimentação" and linha["prob_categoria"] == "0,9100"
    assert linha["subcategoria"] == "Padaria" and linha["valor"] == "30,00"
    assert linha["gabarito_categoria"] == "" and linha["gabarito_subcategoria"] == ""
    # duas chamadas de 100 tokens a US$ 0,042/MTok
    assert Decimal(linha["custo_usd"].replace(",", ".")) == Decimal("200") * Decimal("0.042") / Decimal("1000000")


def test_acima_do_teto_aborta_sem_chamar_a_api(tmp_path):
    cli = ClienteFalso({})
    fabrica_chamada = []
    saida = tmp_path / "amostra.csv"
    r = jev.amostra([tx()] * 10, CATALOGO, cli, csv_saida=saida, teto=Decimal("0"),
                    saida=lambda *_: None)
    assert r is None and cli.chamadas == [] and not saida.exists()
    # com fábrica, nem o SDK é carregado
    r = jev.amostra([tx()], CATALOGO, lambda: fabrica_chamada.append(1), csv_saida=saida,
                    teto=Decimal("0"), saida=lambda *_: None)
    assert r is None and fabrica_chamada == []


def test_estimativa_da_amostra_real_cabe_no_teto():
    # 60 transações com o catálogo de teste custam muito menos que US$ 2
    assert jev.estimar([tx()] * 60, CATALOGO) < jev.TETO_USD


def test_planilha_padrao_fica_fora_do_git():
    r = subprocess.run(["git", "check-ignore", "-q", "dados/jev/amostra.csv"],
                       cwd=jev.ROOT, capture_output=True)
    assert r.returncode == 0


def test_modulo_nao_importa_o_sdk_no_topo():
    # o CI não tem typesafe-sdk: importar o módulo não pode puxá-lo
    assert "typesafe_sdk" not in sys.modules


# --- relatório --------------------------------------------------------------

def _linha(cat, p, sub, gcat, gsub, custo="0,0001", desc="LOJA TESTE"):
    return {"id": "x", "descricao": desc, "categoria": cat, "prob_categoria": p,
            "subcategoria": sub, "gabarito_categoria": gcat, "gabarito_subcategoria": gsub,
            "custo_usd": custo}


def test_relatorio_a_partir_da_planilha_com_gabarito(tmp_path):
    linhas = [
        _linha("Alimentação", "0,9100", "Padaria", "Alimentação", "Padaria"),     # acerta tudo
        _linha("Alimentação", "0,9500", "Mercado", "Alimentação", "Padaria"),     # só categoria
        _linha("Transporte", "0,8000", "", "Transporte", "sem subcategoria"),     # sub vazia = sem sub
        _linha("Outros", "0,4000", "", "Alimentação", "Mercado"),                 # erra
        _linha(NENHUMA, "0,6000", "", "nenhuma serve", ""),                       # acerta
        _linha("Outros", "0,9900", "", "", ""),                                   # sem gabarito: fora
    ]
    caminho = tmp_path / "amostra.csv"
    jev.gravar_csv(caminho, [{c: l.get(c, "") for c in jev.COLUNAS} for l in linhas])
    m = jev.medir(jev.ler_csv(caminho), pendentes=1000, limiares=(0.5, 0.85))

    assert m["n"] == 5
    assert m["acerto_categoria"] == 4
    assert m["acerto_ambas"] == 3
    # acima de 0,5: 4 cobertas (fica fora a de 0,40), 4 certas na categoria, 3 nas duas
    assert m["curva"][0] == {"limiar": 0.5, "cobertos": 4, "acerto_categoria": 4, "acerto_ambas": 3}
    # acima de 0,85: as duas de Alimentação
    assert m["curva"][1] == {"limiar": 0.85, "cobertos": 2, "acerto_categoria": 2, "acerto_ambas": 1}
    assert [(d["categoria"], d["gabarito_categoria"]) for d in m["discordam"]] == [
        ("Alimentação", "Alimentação"), ("Outros", "Alimentação")]
    # custo médio da planilha (todas as 6 linhas) × pendentes
    assert m["custo_pendentes"] == Decimal("0.0001") * 1000

    texto = jev.montar_relatorio(jev.ler_csv(caminho), 1000)
    assert "4/5 (80%)" in texto and "3/5 (60%)" in texto
    assert "1000 pendentes" in texto
