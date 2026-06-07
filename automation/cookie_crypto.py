"""
cookie_crypto.py — shared at-rest encryption for the JOE/SharePoint cookies.

Cookies live encrypted in automation/.cookies.enc (AES-256-GCM), in the SAME
format the Node server uses (v1:base64(iv|tag|ciphertext)), so server.ts and the
Python automation interoperate. Key is derived from the VECTOR_SECRET env var
(recommended for prod) or, failing that, the generated ../.session_key file that
the Node server writes on startup.

Public API:
    fed, rt = load_cookies()    # decrypt; falls back to legacy plaintext
    save_cookies(fed, rt)       # encrypt + write .cookies.enc
"""
import os, re, json, base64, hashlib

_DIR     = os.path.dirname(os.path.abspath(__file__))
_ENC     = os.path.join(_DIR, ".cookies.enc")
_KEYFILE = os.path.join(_DIR, "..", ".session_key")
_LEGACY  = os.path.join(_DIR, "Automation_V4.py")


def _key():
    sec = os.environ.get("VECTOR_SECRET")
    if sec:
        # Must match Node: scryptSync(secret, 'vector-session-v1', 32) → N=16384,r=8,p=1
        return hashlib.scrypt(sec.encode(), salt=b"vector-session-v1",
                              n=16384, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)
    with open(_KEYFILE) as f:
        return bytes.fromhex(f.read().strip())


def _enc(plain: str, key: bytes) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = os.urandom(12)
    ct_tag = AESGCM(key).encrypt(iv, plain.encode(), None)   # ciphertext || tag(16)
    body, tag = ct_tag[:-16], ct_tag[-16:]
    return "v1:" + base64.b64encode(iv + tag + body).decode()  # → iv|tag|ct (Node order)


def _dec(blob: str, key: bytes):
    if not blob:
        return None
    if not blob.startswith("v1:"):
        return blob  # tolerate legacy plaintext
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    raw = base64.b64decode(blob[3:])
    iv, tag, body = raw[:12], raw[12:28], raw[28:]
    return AESGCM(key).decrypt(iv, body + tag, None).decode()


def load_cookies():
    """Return (fed, rt) or (None, None). Encrypted store first, then legacy plaintext."""
    try:
        if os.path.exists(_ENC):
            d = json.load(open(_ENC))
            k = _key()
            fed, rt = _dec(d.get("fed", ""), k), _dec(d.get("rt", ""), k)
            if fed and rt:
                return fed, rt
    except Exception:
        pass
    try:
        src = open(_LEGACY, encoding="utf-8").read()
        fed = re.search(r'FED_AUTH\s*=\s*"([^"]+)"', src)
        rt  = re.search(r'RT_FA\s*=\s*"([^"]+)"', src)
        if fed and rt and fed.group(1) and rt.group(1):
            return fed.group(1), rt.group(1)
    except Exception:
        pass
    return None, None


def save_cookies(fed: str, rt: str):
    """Encrypt + persist to .cookies.enc."""
    k = _key()
    with open(_ENC, "w") as f:
        json.dump({"fed": _enc(fed, k), "rt": _enc(rt, k)}, f)
    try:
        os.chmod(_ENC, 0o600)
    except Exception:
        pass


def save_token(path: str, text: str):
    """Encrypt an arbitrary token/JSON string to a file."""
    with open(path, "w", encoding="utf-8") as f:
        f.write(_enc(text, _key()))
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def load_token(path: str):
    """Decrypt a token file (tolerates legacy plaintext). None if missing/bad."""
    try:
        if os.path.exists(path):
            blob = open(path, encoding="utf-8").read().strip()
            return _dec(blob, _key())
    except Exception:
        pass
    return None
