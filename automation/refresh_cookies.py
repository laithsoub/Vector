"""
Cookie Refresher — reads SharePoint FedAuth/rtFa cookies from Edge DevTools.
Uses only Python stdlib. No websocket-client.
"""

import os, sys, re, json, socket, time, struct, base64, urllib.request
from urllib.parse import urlparse

def _load_cfg():
    here    = os.path.dirname(os.path.abspath(__file__))
    default = os.path.join(os.path.expanduser("~"), "Desktop", "EatonAutomation")
    try:
        cfg = json.loads(open(os.path.join(here, "config.json"), encoding="utf-8").read())
        return cfg.get("base", default), here
    except Exception:
        return default, here

BASE, SCRIPT_DIR = _load_cfg()
SCRIPTS = {
    "QuotationFactoryEMEA": os.path.join(SCRIPT_DIR, "Automation_V4.py"),
    "ELTechsupport":        os.path.join(SCRIPT_DIR, "dq_store_upload.py"),
}

def _ws_handshake(sock, host, path):
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
                  f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = sock.recv(4096)
        if not chunk: break
        resp += chunk
    if b"101" not in resp: raise RuntimeError(f"WS handshake failed: {resp[:120]}")

def _ws_send(sock, payload: str):
    data = payload.encode("utf-8")
    mask = os.urandom(4)
    ln   = len(data)
    frame = bytearray([0x81])
    if ln < 126:     frame.append(0x80 | ln)
    elif ln < 65536: frame.append(0x80 | 126); frame += struct.pack(">H", ln)
    else:            frame.append(0x80 | 127); frame += struct.pack(">Q", ln)
    frame += mask
    frame += bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    sock.sendall(bytes(frame))

def _ws_recv(sock, timeout=8) -> str:
    sock.settimeout(timeout)
    def read_n(n):
        buf = b""
        while len(buf) < n:
            c = sock.recv(n - len(buf))
            if not c: raise ConnectionError("closed")
            buf += c
        return buf
    b0, b1 = read_n(2)
    masked = (b1 & 0x80) != 0
    ln     = b1 & 0x7F
    if ln == 126: ln = struct.unpack(">H", read_n(2))[0]
    elif ln == 127: ln = struct.unpack(">Q", read_n(8))[0]
    mask_key = read_n(4) if masked else b""
    data = read_n(ln)
    if masked: data = bytes(b ^ mask_key[i % 4] for i, b in enumerate(data))
    if (b0 & 0x0F) == 8: raise ConnectionError("close frame")
    return data.decode("utf-8", errors="replace")

def _query_cookies(port=9222):
    try:
        resp = urllib.request.urlopen(f"http://localhost:{port}/json", timeout=3)
        tabs = json.loads(resp.read())
        ws_url = next((t["webSocketDebuggerUrl"] for t in tabs
                       if t.get("type") == "page" and "webSocketDebuggerUrl" in t), None)
        if not ws_url: return None, None
        u    = urlparse(ws_url)
        sock = socket.create_connection((u.hostname, u.port or 9222), timeout=5)
        try:
            _ws_handshake(sock, f"{u.hostname}:{u.port or 9222}", u.path + (f"?{u.query}" if u.query else ""))
            _ws_send(sock, json.dumps({"id": 1, "method": "Network.getCookies",
                "params": {"urls": ["https://eaton.sharepoint.com",
                    "https://eaton.sharepoint.com/sites/ELTechsupport",
                    "https://eaton.sharepoint.com/sites/QuotationFactoryEMEA"]}}))
            fed = rt = None
            for _ in range(10):
                try:
                    data = json.loads(_ws_recv(sock, timeout=5))
                    if data.get("id") == 1:
                        for c in data.get("result", {}).get("cookies", []):
                            n, v = c.get("name",""), c.get("value","")
                            if not v: continue
                            if n == "FedAuth": fed = v
                            elif n.lower() == "rtfa": rt = v
                        break
                except (socket.timeout, ConnectionError): break
            return fed, rt
        finally:
            try: sock.close()
            except: pass
    except Exception:
        return None, None


def _query_copilot_cookie(port=9222):
    """
    Extract cookies for Copilot. Targets copilot.microsoft.com and bing.com.
    The _U cookie must come from a copilot.microsoft.com session (not plain Bing).
    """
    COPILOT_URLS = [
        "https://copilot.microsoft.com",
        "https://www.bing.com",
        "https://bing.com",
        "https://substrate.office.com",
    ]
    try:
        resp = urllib.request.urlopen(f"http://localhost:{port}/json", timeout=3)
        tabs = json.loads(resp.read())
        ws_url = next((t["webSocketDebuggerUrl"] for t in tabs
                       if t.get("type") == "page" and "webSocketDebuggerUrl" in t), None)
        if not ws_url: return {}
        u    = urlparse(ws_url)
        sock = socket.create_connection((u.hostname, u.port or 9222), timeout=5)
        try:
            _ws_handshake(sock, f"{u.hostname}:{u.port or 9222}", u.path + (f"?{u.query}" if u.query else ""))
            _ws_send(sock, json.dumps({"id": 2, "method": "Network.getCookies",
                "params": {"urls": COPILOT_URLS}}))
            for _ in range(10):
                try:
                    data = json.loads(_ws_recv(sock, timeout=5))
                    if data.get("id") == 2:
                        found = {}
                        for c in data.get("result", {}).get("cookies", []):
                            name  = c.get("name", "")
                            value = c.get("value", "")
                            if not name or not value: continue
                            # Save ALL cookies — /c/api/start needs the full set
                            found[name] = value
                        return found
                except (socket.timeout, ConnectionError): break
            return {}
        finally:
            try: sock.close()
            except: pass
    except Exception:
        return {}

def _capture_token_via_fetch(port=9222):
    """
    Injects a fetch() call into the live SharePoint page via Runtime.evaluate.
    The page already has a valid MSAL session in memory, so the fetch() will
    automatically attach the Bearer token. We intercept it using Fetch.enable
    BEFORE injecting the JS, so we catch the outgoing Authorization header.
    """
    try:
        resp = urllib.request.urlopen(f"http://localhost:{port}/json", timeout=3)
        tabs = json.loads(resp.read())
        # Prefer a SharePoint tab
        ws_url = next((t["webSocketDebuggerUrl"] for t in tabs
                       if t.get("type") == "page"
                       and "sharepoint.com" in t.get("url", "")
                       and "webSocketDebuggerUrl" in t), None)
        if not ws_url:
            ws_url = next((t["webSocketDebuggerUrl"] for t in tabs
                           if t.get("type") == "page" and "webSocketDebuggerUrl" in t), None)
        if not ws_url:
            return None

        u    = urlparse(ws_url)
        sock = socket.create_connection((u.hostname, u.port or 9222), timeout=5)
        token = None
        mid   = [1]

        def send(method, params=None):
            _ws_send(sock, json.dumps({"id": mid[0], "method": method, "params": params or {}}))
            mid[0] += 1

        try:
            _ws_handshake(sock, f"{u.hostname}:{u.port or 9222}",
                          u.path + (f"?{u.query}" if u.query else ""))

            # Step 1: enable Fetch interception for graph.microsoft.com
            send("Fetch.enable", {
                "patterns": [{"urlPattern": "https://graph.microsoft.com/*", "requestStage": "Request"}]
            })

            # Step 2: inject a lightweight Graph call into the page
            # /me is the smallest possible Graph call — always valid if user is logged in
            js = """
fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { 'Content-Type': 'application/json' }
}).catch(()=>{});
"""
            send("Runtime.evaluate", {"expression": js, "awaitPromise": False})

            # Step 3: wait for Fetch.requestPaused — that's our interception point
            deadline = time.time() + 15
            while time.time() < deadline:
                try:
                    raw  = _ws_recv(sock, timeout=5)
                    data = json.loads(raw)

                    if data.get("method") == "Fetch.requestPaused":
                        params  = data.get("params", {})
                        req_id  = params.get("requestId")
                        headers = params.get("request", {}).get("headers", {})

                        # Header names may be any case
                        for k, v in headers.items():
                            if k.lower() == "authorization" and v.startswith("Bearer "):
                                token = v[7:]  # strip "Bearer "
                                break

                        # Always release the request so the page doesn't hang
                        send("Fetch.continueRequest", {"requestId": req_id})

                        if token:
                            break

                except (socket.timeout, ConnectionError):
                    break

        finally:
            try:
                send("Fetch.disable")
                sock.close()
            except: pass

        return token

    except Exception as e:
        print(f"[!] Token capture error: {e}", flush=True)
        return None


def _stuck_on_login(port=9222):
    """
    True when the debug Edge is parked on the Entra sign-in / account-picker
    page. Since Edge 151 the dedicated debug profile is no longer signed in
    silently: the flow stops at "Pick an account" and waits for one click, so
    rtFa is never issued and the cookie wait below would just time out.
    """
    try:
        tabs = json.loads(urllib.request.urlopen(f"http://localhost:{port}/json", timeout=3).read())
        return any("login.microsoftonline.com" in t.get("url", "")
                   or "login.live.com" in t.get("url", "") for t in tabs)
    except Exception:
        return False


def _wait_for_edge(port=9222, wait=30):
    for _ in range(wait):
        try:
            urllib.request.urlopen(f"http://localhost:{port}/json", timeout=2)
            return True
        except Exception:
            time.sleep(1)
    return False


def _capture_copilot_api(port=9222):
    """
    Opens copilot.microsoft.com as a BACKGROUND tab (no focus steal),
    enables Fetch interception, injects a silent test message, captures
    the real API endpoint + headers, then closes the tab.
    """
    print("\n[*] Capturing Copilot API (background tab)...", flush=True)

    # Connect to any existing tab to send Target commands
    try:
        resp = urllib.request.urlopen(f"http://localhost:{port}/json", timeout=3)
        tabs = json.loads(resp.read())
        ws_url = next((t["webSocketDebuggerUrl"] for t in tabs
                       if t.get("type") == "page" and "webSocketDebuggerUrl" in t), None)
        if not ws_url:
            print("[!] No existing tab to bootstrap from", flush=True)
            return None
    except Exception as e:
        print(f"[!] Edge not reachable: {e}", flush=True)
        return None

    # Open background tab at blank first so interceptor injects before page load
    try:
        resp = urllib.request.urlopen(
            f"http://localhost:{port}/json/new?about:blank", timeout=5)
        tab = json.loads(resp.read())
        ws_url = tab.get("webSocketDebuggerUrl")
        target_id = tab.get("id")
    except Exception as e:
        print(f"[!] Could not create background tab: {e}", flush=True)
        return None

    print(f"[OK] Background tab created ({target_id[:8]}...)", flush=True)

    # Step 2: connect directly to the new tab's DevTools
    tab_ws = f"ws://localhost:{port}/devtools/page/{target_id}"
    u2   = urlparse(tab_ws)
    sock2 = socket.create_connection((u2.hostname, u2.port or 9222), timeout=10)
    mid2  = [0]

    def send2(method, params=None):
        mid2[0] += 1
        _ws_send(sock2, json.dumps({"id": mid2[0], "method": method,
                                     "params": params or {}}))
        return mid2[0]

    def recv2(timeout=3):
        try: return json.loads(_ws_recv(sock2, timeout=timeout))
        except: return None

    result = None
    try:
        _ws_handshake(sock2, f"localhost:{port}", f"/devtools/page/{target_id}")

        # Enable Network before anything else
        send2("Network.enable")
        send2("Fetch.enable", {"patterns": [
            {"urlPattern": "https://copilot.microsoft.com/*", "requestStage": "Request"},
            {"urlPattern": "https://*.bing.com/*",            "requestStage": "Request"},
            {"urlPattern": "https://bing.com/*",              "requestStage": "Request"},
            {"urlPattern": "https://*.microsoft.com/*",       "requestStage": "Request"},
        ]})

        # Inject WebSocket interceptor BEFORE page loads — captures exact frames sent/received
        WS_INTERCEPTOR = """
window._wsCaptured = [];
const _OrigWS = window.WebSocket;
window.WebSocket = function(url, protocols) {
    const ws = protocols ? new _OrigWS(url, protocols) : new _OrigWS(url);
    window._wsCaptured.push({url: url, sent: [], recv: []});
    const cap = window._wsCaptured[window._wsCaptured.length - 1];
    const origSend = ws.send.bind(ws);
    ws.send = function(data) {
        try { cap.sent.push(typeof data === 'string' ? data : '[binary]'); } catch(e) {}
        return origSend(data);
    };
    ws.addEventListener('message', function(e) {
        try { cap.recv.push(e.data); } catch(e) {}
    });
    return ws;
};
"""
        send2("Page.addScriptToEvaluateOnNewDocument", {"source": WS_INTERCEPTOR})

        # NOW navigate to copilot — interceptor will run before page JS
        send2("Page.navigate", {"url": "https://copilot.microsoft.com"})
        print("[*] Navigating to copilot.microsoft.com...", flush=True)

        # Flush initial messages
        for _ in range(5):
            recv2(1)

        # Wait for page to load
        print("[*] Waiting for Copilot to load (up to 20s)...", flush=True)
        for i in range(20):
            time.sleep(1)
            send2("Runtime.evaluate", {
                "expression": "document.readyState + '|' + document.title",
                "returnByValue": True
            })
            for _ in range(5):
                m = recv2(1)
                if m and m.get("result", {}).get("result", {}).get("value", "").startswith("complete"):
                    print(f"[OK] Page ready ({i+1}s)", flush=True)
                    break
            else:
                continue
            break

        time.sleep(4)  # Let React render

        # Inject test message (shadow-DOM piercing)
        inject_js = """
(async () => {
  function dq(root, sel) {
    const el = root.querySelector(sel);
    if (el) return el;
    for (const n of root.querySelectorAll('*'))
      if (n.shadowRoot) { const f = dq(n.shadowRoot, sel); if (f) return f; }
    return null;
  }
  const input = dq(document,'textarea') || dq(document,'[role="textbox"]')
              || dq(document,'[contenteditable="true"]');
  if (!input) return 'no_input';
  const proto  = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(input, 'hi');
    input.dispatchEvent(new Event('input',  {bubbles:true}));
    input.dispatchEvent(new Event('change', {bubbles:true}));
  } else {
    input.textContent = 'hi';
    input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:'hi'}));
  }
  await new Promise(r => setTimeout(r, 600));
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true}));
  await new Promise(r => setTimeout(r, 200));
  input.dispatchEvent(new KeyboardEvent('keyup',  {key:'Enter',keyCode:13,which:13,bubbles:true}));
  return 'sent';
})()
"""
        print("[*] Injecting test message into background tab...", flush=True)
        send2("Runtime.evaluate", {
            "expression": inject_js,
            "awaitPromise": True, "returnByValue": True, "timeout": 12000
        })

        # Capture the API call — listen for 45s to catch chat after session init
        print("[*] Listening for Copilot API call (45s)...", flush=True)
        deadline    = time.time() + 45
        result      = None
        conv_id     = None
        start_hdrs  = None

        while time.time() < deadline:
            msg = recv2(2)
            if not msg: continue

            if msg.get("method") == "Fetch.requestPaused":
                p   = msg.get("params", {})
                req = p.get("request", {})
                url = req.get("url", "")
                rid = p.get("requestId")
                m   = req.get("method", "GET")
                send2("Fetch.continueRequest", {"requestId": rid})

                # Grab conversationId from session init
                if "/c/api/start" in url and m == "POST":
                    start_hdrs = req.get("headers", {})
                    print(f"[*] Session init: {url}", flush=True)
                    continue

                # Actual chat — POST or GET with chat/message keywords
                is_chat_post = m == "POST" and any(kw in url for kw in [
                    "/chat", "/message", "/completions", "/c/api/", "/sydney",
                    "/turing", "/conversation",
                ])
                is_chat_get  = m == "GET" and any(kw in url for kw in [
                    "/chat", "/stream", "/completions", "/events", "/c/api/",
                ])

                if (is_chat_post or is_chat_get) and "/c/api/start" not in url:
                    headers = req.get("headers", {}) or start_hdrs or {}
                    body    = req.get("postData", "")
                    print(f"\n[OK] Captured: {m} {url}", flush=True)
                    print(f"     Header keys: {list(headers.keys())[:10]}", flush=True)
                    result = {
                        "url":         url,
                        "method":      m,
                        "headers":     headers,
                        "body_sample": body[:2000] if body else "",
                        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
                    break

            # WebSocket creation — extract accessToken from URL
            if msg.get("method") == "Network.webSocketCreated":
                ws_url = msg.get("params", {}).get("url", "")
                if "/c/api/chat" in ws_url and "accessToken=" in ws_url:
                    # Parse accessToken from WS URL
                    from urllib.parse import urlparse as _up, parse_qs as _pq
                    parsed = _up(ws_url)
                    qs = _pq(parsed.query)
                    token = qs.get("accessToken", [""])[0]
                    if token:
                        print(f"\n[OK] accessToken captured ({len(token)} chars)", flush=True)
                        result = {
                            "accessToken": token,
                            "ws_url":      ws_url,
                            "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        }
                        break  # Got what we need
                    else:
                        print(f"[!] WS URL found but no accessToken: {ws_url[:80]}", flush=True)
                elif ws_url and any(kw in ws_url for kw in ["/chat", "copilot"]):
                    print(f"[*] WS created (no token): {ws_url[:80]}", flush=True)

        # After capture loop — read back exact frames from JS interceptor
        print("[*] Reading captured WebSocket frames from interceptor...", flush=True)
        send2("Runtime.evaluate", {
            "expression": "JSON.stringify(window._wsCaptured || [])",
            "returnByValue": True
        })
        for _ in range(8):
            m = recv2(2)
            if m and m.get("result", {}).get("result", {}).get("value"):
                raw_cap = m["result"]["result"]["value"]
                try:
                    captures = json.loads(raw_cap)
                    for cap in captures:
                        url = cap.get("url", "")
                        sent = cap.get("sent", [])
                        recv_frames = cap.get("recv", [])
                        print(f"[OK] WS intercepted: {url}", flush=True)
                        for i, f in enumerate(sent[:5]):
                            print(f"     sent[{i}]: {f[:300]}", flush=True)
                        for i, f in enumerate(recv_frames[:5]):
                            print(f"     recv[{i}]: {f[:300]}", flush=True)
                        if sent and "/c/api/chat" in url:
                            result = {
                                "url":         url,
                                "method":      "WEBSOCKET",
                                "headers":     start_hdrs or {},
                                "body_sample": "\n".join(sent[:3]),
                                "recv_sample": "\n".join(recv_frames[:3]),
                                "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                            }
                except Exception as e:
                    print(f"[!] WS frame parse error: {e}", flush=True)
                break

    except Exception as e:
        print(f"[!] Capture error: {e}", flush=True)
    finally:
        try:
            send2("Fetch.disable")
            sock2.close()
        except: pass

    # Step 3: close the background tab
    try:
        close_sock = socket.create_connection((u.hostname, u.port or 9222), timeout=5)
        _ws_handshake(close_sock, f"{u.hostname}:{u.port or 9222}",
                      u.path + (f"?{u.query}" if u.query else ""))
        mid_c = [0]
        mid_c[0] += 1
        _ws_send(close_sock, json.dumps({
            "id": mid_c[0], "method": "Target.closeTarget",
            "params": {"targetId": target_id}
        }))
        for _ in range(3):
            try: json.loads(_ws_recv(close_sock, timeout=2)); break
            except: pass
        close_sock.close()
        print("[OK] Background tab closed.", flush=True)
    except: pass

    return result

def update_script(script_path, fed, rt):
    if not os.path.exists(script_path):
        print(f"  [!] Not found: {script_path}", flush=True)
        return False
    src = open(script_path, encoding="utf-8").read()
    src = re.sub(r'(?<=FED_AUTH = ")[^"]*', fed, src)
    src = re.sub(r'(?<=RT_FA = ")[^"]*',    rt,  src)
    open(script_path, "w", encoding="utf-8").write(src)
    return True


def update_config_json(fed, rt):
    cfg_path = os.path.join(SCRIPT_DIR, "config.json")
    try:
        cfg = json.loads(open(cfg_path, encoding="utf-8").read()) if os.path.exists(cfg_path) else {}
        cfg["sp_fed_auth"] = fed
        cfg["sp_rt_fa"]    = rt
        open(cfg_path, "w", encoding="utf-8").write(json.dumps(cfg, indent=2, ensure_ascii=False))
        print("[OK] config.json updated with fresh cookies.", flush=True)
        return True
    except Exception as e:
        print(f"  [!] Could not update config.json: {e}", flush=True)
        return False

if __name__ == "__main__":
    print("=" * 50, flush=True)
    print("  Connect to Joe — Eaton Automation", flush=True)
    print("=" * 50, flush=True)

    print("\n[*] Waiting for Edge on port 9222...", flush=True)
    if not _wait_for_edge():
        print("[ERR] Edge not reachable. Close Edge fully and relaunch using the Vector shortcut.", flush=True)
        sys.exit(1)
    print("[OK] Edge is up.", flush=True)

    print("[*] Waiting for SharePoint login in Edge...", flush=True)
    print("    (Log in to SharePoint in the Edge window if prompted)", flush=True)
    fed = rt = None
    warned_login = False
    for attempt in range(120):
        fed, rt = _query_cookies()
        if fed and rt: break
        if attempt % 5 == 0 and attempt > 0:
            print(f"[*] Still waiting for login... ({attempt}s)", flush=True)
            if not warned_login and _stuck_on_login():
                warned_login = True
                print("[!] The Vector Edge window is showing the Microsoft sign-in page.", flush=True)
                print("    Switch to it and click your account tile once — the sign-in", flush=True)
                print("    then sticks and this step stops asking.", flush=True)
        time.sleep(1)

    if not fed or not rt:
        print("[ERR] Timed out waiting for SharePoint cookies.", flush=True)
        if _stuck_on_login():
            print("      Cause: the Vector Edge window is stuck on 'Pick an account'.", flush=True)
            print("      Click your account there, then run Connect to JOE again.", flush=True)
        elif fed and not rt:
            print("      FedAuth arrived but rtFa did not — the SharePoint session is stale.", flush=True)
            print("      Reload eaton.sharepoint.com in the Vector Edge window, then retry.", flush=True)
        sys.exit(1)

    print(f"[OK] FedAuth  ({len(fed)} chars)", flush=True)
    print(f"[OK] rtFa     ({len(rt)} chars)", flush=True)

    # ── Copilot token capture (accessToken from background tab's WS URL) ────────
    from cookie_crypto import save_token
    copilot_api = _capture_copilot_api()
    if copilot_api and copilot_api.get('accessToken'):
        token_path = os.path.join(SCRIPT_DIR, ".copilot_token")
        save_token(token_path, json.dumps(copilot_api))
        print(f"[OK] Copilot token saved ({len(copilot_api['accessToken'])} chars)", flush=True)
    else:
        print("[!] Copilot token not captured — Copilot chat unavailable.", flush=True)
        print("    Make sure you're logged into copilot.microsoft.com in Edge.", flush=True)

    # ── Copilot cookies (kept for fallback) ───────────────────────────────────
    print("\n[*] Looking for Copilot cookies...", flush=True)
    copilot_cookies = _query_copilot_cookie()
    if copilot_cookies:
        copilot_path = os.path.join(SCRIPT_DIR, ".copilot_cookies")
        save_token(copilot_path, json.dumps(copilot_cookies))
        print(f"[OK] Copilot cookies saved: {list(copilot_cookies.keys())}", flush=True)

    # ── Graph token (best-effort, kept for fallback search) ───────────────────
    token = _capture_token_via_fetch()
    if token:
        token_path = os.path.join(SCRIPT_DIR, ".graph_token")
        save_token(token_path, token)
        print(f"[OK] Graph Bearer token captured ({len(token)} chars).", flush=True)

    print("\n[*] Saving cookies (encrypted at rest)...", flush=True)
    all_ok = True
    try:
        from cookie_crypto import save_cookies
        save_cookies(fed, rt)
        print("[OK] Cookies encrypted → .cookies.enc", flush=True)
    except Exception as e:
        print(f"[ERR] Could not save encrypted cookies: {e}", flush=True)
        all_ok = False

    # Scrub any legacy plaintext cookies left in the patched scripts / config.json.
    for fpath in SCRIPTS.values():
        try:
            if os.path.exists(fpath):
                src = open(fpath, encoding="utf-8").read()
                src = re.sub(r'(?<=FED_AUTH = ")[^"]*', "", src)
                src = re.sub(r'(?<=RT_FA = ")[^"]*',    "", src)
                open(fpath, "w", encoding="utf-8").write(src)
        except Exception:
            pass
    try:
        cfg_path = os.path.join(SCRIPT_DIR, "config.json")
        if os.path.exists(cfg_path):
            cfg = json.loads(open(cfg_path, encoding="utf-8").read())
            if cfg.pop("sp_fed_auth", None) is not None or cfg.pop("sp_rt_fa", None) is not None:
                open(cfg_path, "w", encoding="utf-8").write(json.dumps(cfg, indent=2, ensure_ascii=False))
    except Exception:
        pass

    print(f"\n[OK] Done — cookies encrypted.", flush=True)
    sys.exit(0 if all_ok else 1)
