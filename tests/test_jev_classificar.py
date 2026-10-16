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
                      "valor": "1.234,56", "natureza": "despesa",
                      "fonte": "compra feita no cartão de crédito (linha da fatura)"}


def test_estado_aceita_contraparte_nula_e_todas_as_fontes():
    for fonte in ("extrato", "fatura", "imagem", "importacao", "manual"):
        cli = ClienteFalso({"categoria": (NENHUMA, 0.5)})
        jev.classificar(tx(fonte=fonte), CATALOGO, cli)
        estado, _ = cli.chamadas[0]
        assert estado["contraparte"] is None and estado["fonte"] == jev.FONTE_EXPLICADA[fonte]


def test_estado_explica_a_fonte_em_vez_de_so_nomea_la():
    # H2: "fonte: fatura" sozinho puxava compra de cartão para "Banco → Fatura de cartão"
    assert "compra feita no cartão de crédito (linha da fatura)" in jev.estado(tx(fonte="fatura"))["fonte"]
    assert "movimento da conta corrente" in jev.estado(tx(fonte="extrato"))["fonte"]
    textos = [jev.estado(tx(fonte=f))["fonte"] for f in jev.FONTES]
    assert set(jev.FONTE_EXPLICADA) == set(jev.FONTES)
    assert len(set(textos)) == len(jev.FONTES)  # cada fonte com o seu texto
    assert all(texto != fonte for texto, fonte in zip(textos, jev.FONTES))


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


# --- H2: perguntas corrigidas -----------------------------------------------
# Catálogo inventado com os nomes que as descrições à mão usam (Banco, Alimentação →
# Restaurante/Outros/Ifood, Compras → Compras) e uma categoria com as duas genéricas.

CATALOGO_H2 = {
    "categorias": [
        {"id": "kB", "nome": "Banco", "natureza": "despesa", "padrao": False, "ativa": True},
        {"id": "kA", "nome": "Alimentação", "natureza": "despesa", "padrao": False, "ativa": True},
        {"id": "kC", "nome": "Compras", "natureza": "despesa", "padrao": False, "ativa": True},
        {"id": "kL", "nome": "Lazer", "natureza": "despesa", "padrao": False, "ativa": True},
        {"id": "kS", "nome": "Saúde", "natureza": "despesa", "padrao": False, "ativa": True},
        {"id": "kN", "nome": "Não Identificado", "natureza": "despesa", "padrao": True, "ativa": True},
    ],
    "subcategorias": [
        {"id": "b1", "categoria_id": "kB", "nome": "Fatura de cartão", "ativa": True},
        {"id": "b2", "categoria_id": "kB", "nome": "Outros", "ativa": True},
        {"id": "a1", "categoria_id": "kA", "nome": "Ifood", "ativa": True},
        {"id": "a2", "categoria_id": "kA", "nome": "Mercado", "ativa": True},
        {"id": "a3", "categoria_id": "kA", "nome": "Outros", "ativa": True},
        {"id": "a4", "categoria_id": "kA", "nome": "Restaurante", "ativa": True},
        {"id": "c1", "categoria_id": "kC", "nome": "Amazon", "ativa": True},
        {"id": "c2", "categoria_id": "kC", "nome": "Compras", "ativa": True},
        {"id": "c3", "categoria_id": "kC", "nome": "Outros", "ativa": False},  # mesclada
        # Lazer tem as duas candidatas a genérica: a de mesmo nome vence
        {"id": "l1", "categoria_id": "kL", "nome": "Cinema", "ativa": True},
        {"id": "l2", "categoria_id": "kL", "nome": "Outros", "ativa": True},
        {"id": "l3", "categoria_id": "kL", "nome": "Lazer", "ativa": True},
        # Saúde não tem genérica
        {"id": "s1", "categoria_id": "kS", "nome": "Farmácia", "ativa": True},
        {"id": "s2", "categoria_id": "kS", "nome": "Consulta", "ativa": True},
    ],
}


def _cat(nome):
    return next(c for c in CATALOGO_H2["categorias"] if c["nome"] == nome)


def _crit_sub(nome):
    return jev.pergunta_subcategoria(_cat(nome), CATALOGO_H2)["criteria"]


def test_descricao_a_mao_da_categoria_sobrepoe_o_inclui():
    # no H1, "inclui: Fatura de cartão" puxava toda compra de cartão para Banco
    crit = jev.pergunta_categoria(tx(descricao="LOJA EXEMPLO LTDA"), CATALOGO_H2)["criteria"]
    assert crit["Banco"] == ("tarifas, juros, IOF, anuidade e o pagamento da fatura em si — "
                             "nunca uma compra feita no cartão")
    # categoria fora do dict segue listando as subs
    assert crit["Saúde"] == "inclui: Farmácia, Consulta"
    assert crit["Compras"] == "inclui: Amazon, Compras"


def test_descricao_a_mao_da_sub_restaurante_e_outros_de_alimentacao():
    crit = _crit_sub("Alimentação")
    assert crit["Restaurante"] == "comer ou beber no local: restaurante, bar, café"
    # a descrição à mão vale mais que o critério genérico
    assert crit["Outros"] == "delivery fora do iFood, padaria, sorveteria e o resto"
    assert crit["Ifood"] is None and crit["Mercado"] is None
    assert SEM_SUB not in crit


def test_sub_generica_substitui_sem_subcategoria():
    # o JEV fugia para "sem subcategoria"; o Caio usa a genérica
    assert jev.CRITERIO_GENERICA == "quando nenhuma outra subcategoria se aplica"
    assert _crit_sub("Compras") == {"Amazon": None, "Compras": jev.CRITERIO_GENERICA}
    assert _crit_sub("Banco") == {"Fatura de cartão": None, "Outros": jev.CRITERIO_GENERICA}


def test_com_duas_candidatas_a_de_mesmo_nome_da_categoria_vence():
    crit = _crit_sub("Lazer")
    assert crit["Lazer"] == jev.CRITERIO_GENERICA
    assert crit["Outros"] is None  # fica como opção comum
    assert SEM_SUB not in crit
    assert jev.sub_generica(_cat("Lazer"), CATALOGO_H2) == "Lazer"


def test_categoria_sem_generica_segue_com_sem_subcategoria():
    assert list(_crit_sub("Saúde")) == ["Farmácia", "Consulta", SEM_SUB]
    assert jev.sub_generica(_cat("Saúde"), CATALOGO_H2) is None


def test_ifd_vai_para_ifood_pela_regra_sem_chamar_o_jev():
    cli = ClienteFalso({})
    r = jev.classificar(tx(descricao="IFD*LANCHONETE EXEMPLO"), CATALOGO_H2, cli)
    assert cli.chamadas == []
    assert (r["categoria"], r["subcategoria"], r["prob_categoria"], r["custo_usd"], r["origem"]) == (
        "Alimentação", "Ifood", 1, 0, "regra")


def test_o_resto_sai_com_origem_jev():
    cli = ClienteFalso({"categoria": ("Compras", 0.7), "subcategoria": ("Compras", 0.6)})
    r = jev.classificar(tx(descricao="LOJA EXEMPLO LTDA", valor_cents=8000), CATALOGO_H2, cli)
    assert r["origem"] == "jev" and len(cli.chamadas) == 2
    # o Exemplo do card: o estado explica a fatura e a sub genérica está no lugar
    estado, _ = cli.chamadas[0]
    assert estado["fonte"] == "compra feita no cartão de crédito (linha da fatura)"
    (q,) = cli.perguntas("subcategoria")
    assert q["criteria"]["Compras"] == jev.CRITERIO_GENERICA and SEM_SUB not in q["criteria"]


def test_planilha_marca_a_origem_e_regra_nao_entra_na_estimativa(tmp_path):
    cli = ClienteFalso({"categoria": (NENHUMA, 0.5)})
    saida = tmp_path / "amostra.csv"
    jev.amostra([tx(id="t1", descricao="IFD*LANCHONETE EXEMPLO"), tx(id="t2", descricao="LOJA X")],
                CATALOGO_H2, cli, csv_saida=saida, saida=lambda *_: None)
    linhas = jev.ler_csv(saida)
    assert [l["origem"] for l in linhas] == ["regra", "jev"]
    assert linhas[0]["custo_usd"] == "0"
    assert jev.estimar([tx(descricao="IFD*X")], CATALOGO_H2) == 0


def test_relatorio_le_planilha_antiga_sem_coluna_origem(tmp_path):
    # o amostra.csv do H1 não tem "origem"
    antigas = [c for c in jev.COLUNAS if c != "origem"]
    linha = {c: "" for c in antigas}
    linha.update(id="x", descricao="LOJA TESTE", categoria="Compras", prob_categoria="0,9000",
                 custo_usd="0,0001", gabarito_categoria="Compras")
    caminho = tmp_path / "h1.csv"
    caminho.write_text(";".join(antigas) + "\n" + ";".join(linha[c] for c in antigas) + "\n",
                       encoding="utf-8-sig")
    assert "1/1 (100%)" in jev.montar_relatorio(jev.ler_csv(caminho), 10)


# --- H2: amostra --gabarito -------------------------------------------------

def test_gabarito_casa_por_id_e_ignora_id_que_nao_esta_mais_pendente():
    pend = [tx(id="p1", descricao="A"), tx(id="p2", descricao="B"), tx(id="p3", descricao="C")]
    gab = [
        {"id": "p2", "gabarito_categoria": "Compras", "gabarito_subcategoria": "Amazon"},
        {"id": "sumiu", "gabarito_categoria": "Lazer", "gabarito_subcategoria": ""},
        {"id": "p1", "gabarito_categoria": "Banco", "gabarito_subcategoria": ""},
    ]
    transacoes, por_id, saidos = jev.amostra_do_gabarito(pend, gab)
    # sem sortear: os ids da planilha, na ordem dela; p3 não estava lá e não entra
    assert [t["id"] for t in transacoes] == ["p2", "p1"]
    assert saidos == 1
    assert por_id == {"p2": {"gabarito_categoria": "Compras", "gabarito_subcategoria": "Amazon"},
                      "p1": {"gabarito_categoria": "Banco", "gabarito_subcategoria": ""}}


def test_gabarito_e_copiado_para_a_planilha_nova(tmp_path):
    pend = [tx(id="p1", descricao="IFD*X"), tx(id="p2", descricao="LOJA")]
    gab = [{"id": "p1", "gabarito_categoria": "Alimentação", "gabarito_subcategoria": "Ifood"},
           {"id": "p2", "gabarito_categoria": "Compras", "gabarito_subcategoria": "Compras"}]
    transacoes, por_id, _ = jev.amostra_do_gabarito(pend, gab)
    cli = ClienteFalso({"categoria": ("Compras", 0.8), "subcategoria": ("Compras", 0.7)})
    saida = tmp_path / "rodada2.csv"
    jev.amostra(transacoes, CATALOGO_H2, cli, csv_saida=saida, saida=lambda *_: None,
                gabarito=por_id)
    linhas = jev.ler_csv(saida)
    assert [(l["id"], l["gabarito_categoria"], l["gabarito_subcategoria"]) for l in linhas] == [
        ("p1", "Alimentação", "Ifood"), ("p2", "Compras", "Compras")]
    assert jev.medir(linhas, 10)["acerto_ambas"] == 2


# --- H3: classificar todas as pendentes e gerar o SQL ----------------------
# Planilha inventada (ids, descrições e valores fictícios): o gerar-sql só lê o que
# o classificar gravou, então o teste monta as linhas direto, como sairiam do CSV.

CATALOGO_H3 = {
    "categorias": CATALOGO_H2["categorias"] + [
        {"id": "kR", "nome": "Receita", "natureza": "receita", "padrao": False, "ativa": True}],
    "subcategorias": CATALOGO_H2["subcategorias"],
}
PADRAO = "kN"


def _uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def _l(n, cat, p, sub="", natureza="despesa", origem="jev"):
    linha = {c: "" for c in jev.COLUNAS}
    linha.update(id=_uid(n), descricao=f"LOJA TESTE {n}", valor="10,00", natureza=natureza,
                 fonte="fatura", categoria=cat, prob_categoria=p, subcategoria=sub,
                 origem=origem)
    return linha


def _gerar(linhas, limiar=0.90, origens=None, esferas=None, catalogo=CATALOGO_H3):
    origens = origens if origens is not None else {l["id"]: "modelo" for l in linhas}
    esferas = esferas if esferas is not None else {i: "pessoal" for i in origens}
    return jev.gerar_sql(linhas, catalogo, PADRAO, origens, limiar, esferas)


def _exemplo():
    # o Exemplo do card: regra IFD*, 0,95, 0,70 e "nenhuma serve" a 0,99
    return [_l(1, "Alimentação", "1,0000", "Ifood", origem="regra"),
            _l(2, "Compras", "0,9500", "Compras"),
            _l(3, "Saúde", "0,7000", "Farmácia"),
            _l(4, NENHUMA, "0,9900")]


def test_exemplo_do_card_duas_aplicadas_duas_seguem_pendentes():
    r = _gerar(_exemplo())
    assert [u["id"] for u in r["aplicar"]] == [_uid(1), _uid(2)]
    assert len(r["desfazer"]) == 2
    texto = jev.texto_resumo(r)
    assert "2 aplicadas, 2 seguem pendentes" in texto
    assert "Alimentação: 1" in texto and "Compras: 1" in texto


def test_regra_ifd_com_prob_1_gravada_pelo_classificar_entra():
    # a planilha grava a regra como "1,0" (float formatado): conta como 1
    linha = jev.linha_csv(tx(id=_uid(9), descricao="IFD*X"), jev.regra_fixa(tx(descricao="IFD*X")))
    assert len(_gerar([linha], limiar=0.99)["aplicar"]) == 1


def test_limiar_corta_certo_090_entra_089_nao():
    r = _gerar([_l(1, "Compras", "0,9000", "Compras"), _l(2, "Compras", "0,8900", "Compras")])
    assert [u["id"] for u in r["aplicar"]] == [_uid(1)]
    assert r["abaixo"] == 1
    # e o limiar é parâmetro: a 0,85 as duas entram
    assert len(_gerar([_l(1, "Compras", "0,9000"), _l(2, "Compras", "0,8900")], 0.85)["aplicar"]) == 2


def test_nenhuma_serve_nao_entra_nem_com_confianca_alta():
    r = _gerar([_l(1, NENHUMA, "0,9900")])
    assert r["aplicar"] == [] and r["nenhuma"] == 1


def test_todo_update_tem_a_guarda_pela_padrao():
    # sem a guarda, o que o Caio reclassificou depois da rodada seria sobrescrito
    r = _gerar(_exemplo())
    for u in r["aplicar"]:
        assert u["sql"].endswith(f"and categoria_id = '{PADRAO}';")
        assert "origem_categoria = 'modelo'" in u["sql"]
    assert r["aplicar"][0]["sql"] == (
        f"update transacoes set categoria_id = 'kA', subcategoria_id = 'a1', "
        f"origem_categoria = 'modelo', esfera = 'pessoal' where id = '{_uid(1)}' and categoria_id = '{PADRAO}';")


def test_sub_vazia_ou_sem_subcategoria_vira_null():
    r = _gerar([_l(1, "Saúde", "0,9500", ""), _l(2, "Saúde", "0,9500", SEM_SUB)])
    assert all("subcategoria_id = null" in u["sql"] for u in r["aplicar"])
    assert len(r["aplicar"]) == 2


def test_desfazer_espelha_o_aplicar_e_devolve_a_origem_lida_do_banco():
    linhas = _exemplo()
    # uma das pendentes era 'manual' antes: tem que voltar 'manual', não 'modelo'
    origens = {_uid(1): "manual", _uid(2): "modelo", _uid(3): "modelo", _uid(4): "modelo"}
    r = _gerar(linhas, origens=origens)
    assert [u["id"] for u in r["desfazer"]] == [u["id"] for u in r["aplicar"]]
    assert r["desfazer"][0]["sql"] == (
        f"update transacoes set categoria_id = '{PADRAO}', subcategoria_id = null, "
        f"origem_categoria = 'manual', esfera = 'pessoal' where id = '{_uid(1)}' "
        f"and categoria_id = 'kA';")
    # a guarda é a categoria aplicada: se o Caio mexeu depois, o desfazer não pisa
    assert r["desfazer"][1]["sql"].endswith(f"where id = '{_uid(2)}' and categoria_id = 'kC';")
    assert "origem_categoria = 'modelo'" in r["desfazer"][1]["sql"]


def test_aplicar_grava_a_esfera_da_categoria_e_desfazer_devolve_a_lida_do_banco():
    # A transação herda a esfera da categoria (0019); sem isso, a despesa classificada
    # como Empresa ficaria 'pessoal' e entraria no gasto da casa. O desfazer devolve a
    # esfera de antes, não a da categoria.
    catalogo = {"categorias": CATALOGO_H3["categorias"] + [
                    {"id": "kE", "nome": "Empresa", "natureza": "despesa", "padrao": False,
                     "ativa": True, "esfera": "empresa"}],
                "subcategorias": CATALOGO_H3["subcategorias"]}
    r = _gerar([_l(1, "Empresa", "0,9900")], esferas={_uid(1): "pessoal"}, catalogo=catalogo)
    assert r["aplicar"][0]["sql"] == (
        f"update transacoes set categoria_id = 'kE', subcategoria_id = null, "
        f"origem_categoria = 'modelo', esfera = 'empresa' "
        f"where id = '{_uid(1)}' and categoria_id = '{PADRAO}';")
    assert r["desfazer"][0]["sql"] == (
        f"update transacoes set categoria_id = '{PADRAO}', subcategoria_id = null, "
        f"origem_categoria = 'modelo', esfera = 'pessoal' "
        f"where id = '{_uid(1)}' and categoria_id = 'kE';")


def test_linha_sem_esfera_lida_do_banco_e_pulada():
    # sem a esfera de antes, o desfazer não teria o que devolver
    r = _gerar([_l(1, "Compras", "0,9900", "Amazon")], esferas={})
    assert r["aplicar"] == [] and [p["id"] for p in r["pulados"]] == [_uid(1)]


def test_nome_fora_do_catalogo_e_pulado_e_listado_sem_abortar():
    linhas = [_l(1, "Categoria Que Sumiu", "0,9900"),
              _l(2, "Compras", "0,9900", "Sub Que Sumiu"),
              _l(3, "Compras", "0,9900", "Amazon"),
              _l(4, "Compras", "0,9900", "Outros")]  # sub inativa (mesclada)
    r = _gerar(linhas)
    assert [u["id"] for u in r["aplicar"]] == [_uid(3)]
    assert [p["id"] for p in r["pulados"]] == [_uid(1), _uid(2), _uid(4)]
    texto = jev.texto_resumo(r)
    assert "1 aplicadas, 3 seguem pendentes" in texto
    for n in (1, 2, 4):
        assert _uid(n) in texto


def test_linha_que_nao_esta_mais_no_banco_e_pulada():
    # o desfazer precisa da origem de antes; sem ela, a linha não entra
    r = _gerar([_l(1, "Compras", "0,9900", "Amazon")], origens={})
    assert r["aplicar"] == [] and [p["id"] for p in r["pulados"]] == [_uid(1)]


def test_despesa_com_categoria_de_receita_recusa_a_planilha_inteira():
    linhas = [_l(1, "Compras", "0,9900", "Amazon"), _l(2, "Receita", "0,5000")]
    with pytest.raises(ValueError) as e:
        _gerar(linhas)
    assert _uid(2) in str(e.value)


def test_receita_com_categoria_de_despesa_passa_e_natureza_nao_e_tocada():
    # estorno de extrato/fatura: receita sob categoria de despesa
    r = _gerar([_l(1, "Compras", "0,9900", "Amazon", natureza="receita")])
    assert len(r["aplicar"]) == 1
    assert all("natureza" not in u["sql"] for u in r["aplicar"] + r["desfazer"])


def test_sql_nao_toca_associacoes_nem_controla_a_transacao(tmp_path):
    from tools.db import controla_transacao

    r = _gerar(_exemplo())
    aplicar, desfazer = tmp_path / "aplicar.sql", tmp_path / "desfazer.sql"
    jev.gravar_sql(r, aplicar, desfazer)
    for arq in (aplicar, desfazer):
        texto = arq.read_text(encoding="utf-8")
        assert "associacoes" not in texto.lower()
        # tools/db.py ensaiar/aplicar recusam arquivo com begin/commit/rollback
        assert not controla_transacao(texto)
        assert texto.lower().count("update transacoes") == 2


def test_gerar_sql_recusado_nao_grava_os_arquivos(tmp_path):
    csv_ = tmp_path / "todas.csv"
    jev.gravar_csv(csv_, [_l(1, "Receita", "0,9900")])
    aplicar, desfazer = tmp_path / "aplicar.sql", tmp_path / "desfazer.sql"
    with pytest.raises(SystemExit):
        jev.cmd_gerar_sql(csv_, 0.90, aplicar, desfazer, ler_banco=lambda ids: (
            CATALOGO_H3, PADRAO, {i: "modelo" for i in ids}, {i: "pessoal" for i in ids}),
            saida=lambda *_: None)
    assert not aplicar.exists() and not desfazer.exists()


def test_gerar_sql_le_a_planilha_e_grava_os_dois_arquivos(tmp_path):
    csv_ = tmp_path / "todas.csv"
    jev.gravar_csv(csv_, _exemplo())
    aplicar, desfazer = tmp_path / "aplicar.sql", tmp_path / "desfazer.sql"
    pedidos = []

    def ler_banco(ids):
        pedidos.append(sorted(ids))
        return CATALOGO_H3, PADRAO, {i: "modelo" for i in ids}, {i: "pessoal" for i in ids}

    impresso = []
    jev.cmd_gerar_sql(csv_, 0.90, aplicar, desfazer, ler_banco=ler_banco, saida=impresso.append)
    assert aplicar.read_text(encoding="utf-8").count("update transacoes") == 2
    assert desfazer.read_text(encoding="utf-8").count("update transacoes") == 2
    assert pedidos == [sorted(_uid(n) for n in (1, 2, 3, 4))]
    assert any("2 aplicadas, 2 seguem pendentes" in s for s in impresso)


def test_id_que_nao_e_uuid_e_pulado():
    # o id vai literal no SQL: só uuid válido passa (a planilha é editável)
    linha = _l(1, "Compras", "0,9900", "Amazon")
    linha["id"] = "x'; drop table transacoes; --"
    r = _gerar([linha], origens={linha["id"]: "modelo"})
    assert r["aplicar"] == [] and len(r["pulados"]) == 1


def test_classificar_todas_acima_do_teto_nao_chama_o_jev(tmp_path):
    cli = ClienteFalso({})
    saida = tmp_path / "todas.csv"
    r = jev.classificar_todas([tx(id=f"t{i}") for i in range(5)], CATALOGO_H3, cli,
                              csv_saida=saida, teto=Decimal("0"), saida=lambda *_: None)
    assert r is None and cli.chamadas == [] and not saida.exists()


def test_classificar_todas_grava_a_planilha_com_as_colunas_da_amostra(tmp_path):
    cli = ClienteFalso({"categoria": ("Compras", 0.95), "subcategoria": ("Amazon", 0.8)})
    saida = tmp_path / "todas.csv"
    jev.classificar_todas([tx(id="t1", descricao="IFD*X"), tx(id="t2", descricao="LOJA")],
                          CATALOGO_H3, cli, csv_saida=saida, saida=lambda *_: None)
    linhas = jev.ler_csv(saida)
    assert list(linhas[0]) == jev.COLUNAS
    assert [(l["categoria"], l["origem"]) for l in linhas] == [("Alimentação", "regra"),
                                                               ("Compras", "jev")]
    assert all(l["gabarito_categoria"] == "" for l in linhas)


def test_planilhas_e_sql_do_h3_ficam_fora_do_git():
    for arq in ("dados/jev/todas.csv", "dados/jev/aplicar.sql", "dados/jev/desfazer.sql"):
        r = subprocess.run(["git", "check-ignore", "-q", arq], cwd=jev.ROOT, capture_output=True)
        assert r.returncode == 0, arq
