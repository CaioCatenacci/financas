"""Testes de tools/db.py — as partes puras: o que conta como leitura, de onde vem a
URL do banco, o marcador de fase. A conexão de verdade não roda no CI (não há banco
lá); o que se prova aqui é que a guarda vem ANTES de conectar."""
import json
import os
import subprocess
import sys
from datetime import date
from decimal import Decimal
from uuid import UUID

import pytest

from tools.db import ler_dev_vars, url_do_banco, so_leitura, fase_pos_deploy, para_json


def test_ler_dev_vars_tolera_crlf_comentario_aspas_e_igual_no_valor():
    texto = "# segredos\r\nAPP_TOKEN=abc==\r\n\r\nDATABASE_URL='postgresql://u:p=1@h/db'\r\nX = \"y\"\r\n"
    assert ler_dev_vars(texto) == {"APP_TOKEN": "abc==", "DATABASE_URL": "postgresql://u:p=1@h/db", "X": "y"}


def test_url_vem_do_ambiente_antes_do_dev_vars(tmp_path):
    (tmp_path / ".dev.vars").write_text("DATABASE_URL=do-arquivo\n", encoding="utf-8")
    assert url_do_banco({"DATABASE_URL": "do-ambiente"}, tmp_path) == "do-ambiente"


def test_url_cai_no_dev_vars_quando_o_ambiente_nao_tem(tmp_path):
    (tmp_path / ".dev.vars").write_text("DATABASE_URL=do-arquivo\n", encoding="utf-8")
    assert url_do_banco({}, tmp_path) == "do-arquivo"


def test_sem_url_em_lugar_nenhum_para_com_mensagem(tmp_path):
    with pytest.raises(DevVarsAusente, match="DATABASE_URL"):
        url_do_banco({}, tmp_path, git_common_dir=None)


def test_so_leitura_aceita_select_with_explain_e_ignora_comentarios():
    assert so_leitura("select 1")
    assert so_leitura("  -- conta\n  SELECT count(*) from transacoes;")
    assert so_leitura("with t as (select 1) select * from t")
    assert so_leitura("/* x */ explain select 1")


def test_so_leitura_recusa_escrita_ddl_e_duas_consultas():
    # Review Focus 2: "select 1; delete ..." tem que cair aqui, antes de qualquer conexão.
    for sql in ["delete from transacoes", "update transacoes set x=1", "insert into t values (1)",
                "drop table t", "select 1; delete from transacoes", "begin; select 1", ""]:
        assert not so_leitura(sql), sql


def test_fase_pos_deploy_so_pela_primeira_linha():
    assert fase_pos_deploy("-- fase: pos-deploy\nalter table t drop column x;")
    assert fase_pos_deploy("\n  -- FASE: pos-deploy\n")
    assert not fase_pos_deploy("-- 0010: aditiva\n-- fase: pos-deploy no fim não vale\n")


def test_para_json_converte_o_que_o_json_nao_sabe():
    assert para_json(Decimal("12.50")) == "12.50"
    assert para_json(date(2026, 9, 26)) == "2026-09-26"
    assert para_json(UUID("12345678-1234-5678-1234-567812345678")) == "12345678-1234-5678-1234-567812345678"
    with pytest.raises(TypeError):
        para_json(object())


def test_cli_select_com_escrita_sai_1_sem_tocar_o_banco():
    # URL inválida de propósito: se o script tentasse conectar, o erro seria outro.
    # A saída é UTF-8 mesmo no Windows (console cp1252): quem lê é um agente, por JSON.
    r = subprocess.run([sys.executable, "tools/db.py", "select", "select 1; delete from transacoes"],
                       capture_output=True, text=True, encoding="utf-8",
                       env={**os.environ, "DATABASE_URL": "postgresql://invalido"})
    assert r.returncode == 1
    saida = json.loads(r.stdout)
    assert saida["ok"] is False
    assert "só SELECT" in saida["erro"]


def test_cli_sem_comando_mostra_o_uso():
    r = subprocess.run([sys.executable, "tools/db.py"], capture_output=True, text=True)
    assert r.returncode == 1
    assert "uso:" in r.stderr


# Achados da revisão final (26/09): um COMMIT contrabandeado numa string ou num
# arquivo de migração derrubava as duas barreiras — o select gravava e o ensaio
# persistia. Três camadas agora: guarda de texto, protocolo estendido (um comando
# só) e sessão read-only por padrão.
from tools.db import controla_transacao, redigir, DevVarsAusente


def test_so_leitura_nao_se_engana_com_comentario_dentro_de_string():
    assert not so_leitura("select '--'; commit; delete from transacoes")
    assert not so_leitura("select $$--$$; commit; select 1")
    assert so_leitura("select 'a;b' as x")   # ponto-e-vírgula dentro de string é dado, não comando


def test_controla_transacao_pega_begin_commit_rollback_no_inicio_de_comando():
    for sql in ["begin; create table t (x int); commit;", "START TRANSACTION", "select 1; rollback",
                "savepoint a", "release savepoint a", "prepare transaction 'x'", "end", "abort"]:
        assert controla_transacao(sql), sql
    # "end" de CASE e "commit" dentro de string ou comentário não são controle de transação
    for sql in ["select case when x then 1 else 0 end from t", "select 'commit'", "-- commit\nselect 1",
                "create table if not exists t (x int);"]:
        assert not controla_transacao(sql), sql


def test_cli_ensaiar_recusa_arquivo_com_commit_antes_de_conectar(tmp_path):
    arq = tmp_path / "m.sql"
    arq.write_text("begin;\ncreate table t (x int);\ncommit;\n", encoding="utf-8")
    r = subprocess.run([sys.executable, "tools/db.py", "ensaiar", str(arq)], capture_output=True, text=True,
                       encoding="utf-8", env={**os.environ, "DATABASE_URL": "postgresql://invalido"})
    assert r.returncode == 1
    saida = json.loads(r.stdout)
    assert saida["ok"] is False
    assert "transação" in saida["erro"]


def test_cli_aplicar_recusa_arquivo_com_commit_antes_de_conectar(tmp_path):
    arq = tmp_path / "m.sql"
    arq.write_text("create table t (x int);\ncommit;\n", encoding="utf-8")
    r = subprocess.run([sys.executable, "tools/db.py", "aplicar", str(arq)], capture_output=True, text=True,
                       encoding="utf-8", env={**os.environ, "DATABASE_URL": "postgresql://invalido"})
    assert r.returncode == 1
    assert "transação" in json.loads(r.stdout)["erro"]


def test_redigir_tira_a_url_e_a_senha_do_texto_de_erro():
    url = "postgresql://usuario:SENHA FALSA@host/db"
    assert "SENHA" not in redigir('unexpected spaces found in "SENHA FALSA"', url)
    assert "usuario" not in redigir(f'missing "=" after "{url}"', url)
    assert redigir("connection refused", url) == "connection refused"


def test_url_cai_no_dev_vars_do_checkout_principal_quando_roda_numa_worktree(tmp_path):
    # O reviewer roda dentro de .claude/worktrees/fila-<id>, onde não há .dev.vars
    # (gitignored). A URL vem do checkout principal, o pai do git-common-dir.
    principal = tmp_path / "repo"
    principal.mkdir()
    (principal / ".dev.vars").write_text("DATABASE_URL=do-principal\n", encoding="utf-8")
    wt = tmp_path / "wt"
    wt.mkdir()
    assert url_do_banco({}, wt, git_common_dir=str(principal / ".git")) == "do-principal"


def test_sem_url_levanta_excecao_normal_para_virar_json(tmp_path):
    # SystemExit escapava do try/except dos comandos e saía sem JSON.
    with pytest.raises(DevVarsAusente, match="DATABASE_URL"):
        url_do_banco({}, tmp_path, git_common_dir=None)
