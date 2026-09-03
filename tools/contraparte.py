"""Paridade com worker/contraparte.js — a normalização TEM de casar p/ o lookup bater."""
import re
import unicodedata


def normalizar_nome(s):
    """Normaliza nome: remove acentos, uppercase, colapsa espaços."""
    if not s or not isinstance(s, str):
        return None
    n = unicodedata.normalize("NFD", s)
    # Remove combining marks (acentos)
    n = "".join(c for c in n if unicodedata.category(c) != "Mn")
    # Uppercase, colapsa espaços, trim
    n = re.sub(r"\s+", " ", n).upper().strip()
    return n or None


def normalizar_chave(s):
    """Normaliza chave: email→minúsculas, dígitos→extrai, outro→minúsculas."""
    if not s or not isinstance(s, str):
        return None
    t = s.strip()
    if not t:
        return None
    if "@" in t:
        return t.lower()  # Email
    if any(ch.isdigit() for ch in t):
        # Telefone/CPF: extrai dígitos
        d = re.sub(r"\D", "", t)
        return d or None
    return t.lower()  # Chave aleatória


def derivar_chave(d):
    """Deriva chave: prioridade pix_cpf > nome."""
    ch = normalizar_chave((d or {}).get("contraparte_chave"))
    if ch:
        return {"chave": ch, "tipo": "pix_cpf"}
    nm = normalizar_nome((d or {}).get("contraparte_nome"))
    if nm:
        return {"chave": nm, "tipo": "nome"}
    return None
