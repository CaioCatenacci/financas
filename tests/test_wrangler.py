"""Configuração do Worker que não pode regredir sem ninguém ver."""

import tomllib
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def test_observability_ligado_para_os_logs_ficarem_persistidos():
    # Sem [observability], um erro do webhook só aparece com `wrangler tail`
    # aberto na hora — foi assim que o bot ficou mudo sem ninguém saber (B1).
    # Com ela ligada, o Workers Logs nativo guarda o console.error para ler depois.
    conf = tomllib.loads((RAIZ / "wrangler.toml").read_text(encoding="utf-8"))
    assert conf.get("observability", {}).get("enabled") is True
