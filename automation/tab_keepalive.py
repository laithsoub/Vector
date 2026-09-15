"""
tab_keepalive.py — hold the LSD work tabs open and signed in, in the background.

Fetch-from-CPQ, the revision lookup and the register upload all read pages that
are already signed in inside the debug-rail Edge (see cpq_fetch.py). Those
sessions die when the tabs sit idle, so the first fetch of the morning fails
with "no CPQ tab" or a login redirect and the analyst has to go and click the
browser awake. This keeps them warm instead: every tab in the list exists, gets
reloaded on a timer, and is reported as signed-in or not.

    python tab_keepalive.py --job job.json --out result.json

job.json:
    {"port": 9222,                 Edge remote-debugging port (default 9222)
     "urls": ["https://eaton.bigmachines.com/", ...],
     "launch": true,               start the debug Edge if the port is down
     "minimized": true,            start it minimized (default true)
     "profile": "<user-data-dir>", default %LOCALAPPDATA%\\VectorEdgeDebug
     "edge": "<msedge.exe>",       default: the usual two install paths
     "reload": true}               reload the tabs that already exist

A URL may carry a trailing " #noreload": that tab is opened if it is missing and
reported on, but never reloaded. Use it for a page that holds unsaved state — an
Excel Online workbook someone is typing in — where a reload would be rude even
though the content itself autosaves.

result.json:
    {"ok": true,
     "launched": false,            did this run start Edge
     "tabs": [{"url", "matched", "created", "reloaded", "signed_in",
               "title", "final_url", "error"}],
     "needs_signin": ["https://..."],
     "log": [...]}

Note on "hidden": Edge only binds the debugging port on a dedicated
--user-data-dir (see start-app.ps1), and a real SSO sign-in has to be typed by a
human in a real window. So the keep-alive window is MINIMIZED, not headless —
headless would take the same profile lock and could never be signed into.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from urllib.parse import urlparse
from urllib.request import urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cpq_fetch as cf                    # the CDP plumbing, already proven

DEFAULT_URLS = [
    "https://eaton.bigmachines.com/",                        # CPQ — transaction fetch
    "https://eaton.sharepoint.com/sites/QuotationFactoryEMEA",
]

EDGE_PATHS = [
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

# A tab that landed on one of these is showing a sign-in page, not the work page.
LOGIN_HINTS = (
    "login.microsoftonline.com", "login.live.com", "adfs", "/oauth2/",
    "signin", "sign-in", "login.eaton.com", "okta",
)


def _port_up(port):
    try:
        urlopen(f"http://localhost:{port}/json/version", timeout=3).read()
        return True
    except Exception:
        return False


def _tabs(port):
    return json.loads(urlopen(f"http://localhost:{port}/json", timeout=6).read())


def _key(url):
    """What makes two URLs 'the same tab': host + the first path segment.

    SharePoint rewrites its own URLs constantly (Doc.aspx?sourcedoc=..., view
    ids, #fragments), so matching the whole string would create a duplicate tab
    on every run. Host plus first segment is stable across all of that.
    """
    u = urlparse(url)
    seg = [p for p in (u.path or "").split("/") if p]
    return (u.netloc.lower(), (seg[0].lower() if seg else ""))


def _host(url):
    return urlparse(url).netloc.lower()


def _match(url, by_key, by_host, wanted_hosts):
    """The open tab that already IS this page, or None.

    Exact key first. Falling back to host alone is what stops a new tab being
    opened on every sweep: CPQ is asked for as eaton.bigmachines.com/ but lands
    on /commerce/..., so the key it comes back under is not the key it was asked
    for. The fallback is only safe when this run wants a single page on that
    host — two OneDrive URLs on the same host still have to match by key, or one
    of them would adopt the other's tab and neither would stay fresh.
    """
    hit = by_key.get(_key(url))
    if hit is not None:
        return hit
    h = _host(url)
    if wanted_hosts.get(h, 0) == 1:
        return by_host.get(h)
    return None


def _looks_signed_in(url, title):
    low = (url or "").lower()
    if any(h in low for h in LOGIN_HINTS):
        return False
    t = (title or "").strip().lower()
    if t in ("sign in", "sign in to your account", "redirecting"):
        return False
    return True


def _launch_edge(job, log):
    """Start the debug-rail Edge on its own profile, minimized, with the tabs."""
    edge = job.get("edge") or next((p for p in EDGE_PATHS if os.path.exists(p)), None)
    if not edge:
        raise RuntimeError("msedge.exe not found — set \"edge\" in the job to its full path.")
    profile = job.get("profile") or os.path.join(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "VectorEdgeDebug")
    port = int(job.get("port") or 9222)
    args = [edge, f"--remote-debugging-port={port}", "--no-first-run",
            "--no-default-browser-check", f"--user-data-dir={profile}"]
    if job.get("minimized", True):
        # Edge honours this only on a cold start of the profile, which is exactly
        # when we use it — a keep-alive launch must never steal the foreground.
        args.append("--start-minimized")
    args += list(job.get("urls") or DEFAULT_URLS)
    subprocess.Popen(args, close_fds=True,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    log(f"launched the debug-rail Edge on port {port} (profile {profile})")
    for _ in range(40):                     # up to ~20 s for the port to bind
        time.sleep(0.5)
        if _port_up(port):
            log("debug port is up")
            return True
    raise RuntimeError(f"Edge was launched but port {port} never came up.")


def _new_tab(port, url, log):
    """Open a background tab. /json/new needs PUT on Edge 136+."""
    import urllib.request
    from urllib.parse import quote
    req = urllib.request.Request(
        f"http://localhost:{port}/json/new?{quote(url, safe='')}", method="PUT")
    try:
        return json.loads(urlopen(req, timeout=10).read())
    except Exception as e:
        log(f"PUT /json/new failed for {url} ({e}) — trying GET")
        return json.loads(urlopen(
            f"http://localhost:{port}/json/new?{quote(url, safe='')}", timeout=10).read())


def run(job, log):
    port = int(job.get("port") or 9222)
    raw = [u.strip() for u in (job.get("urls") or DEFAULT_URLS) if u and u.strip()]
    urls, no_reload = [], set()
    for u in raw:
        if u.lower().endswith("#noreload"):
            u = u[:-len("#noreload")].strip()
            no_reload.add(u)
        if u:
            urls.append(u)
    launched = False

    if not _port_up(port):
        if not job.get("launch", True):
            raise RuntimeError(f"Edge debug port {port} is not reachable and launch is off.")
        launched = _launch_edge({**job, "urls": urls, "port": port}, log)

    open_tabs = [t for t in _tabs(port) if t.get("type") == "page"]
    seen, by_host = {}, {}
    for t in open_tabs:
        u = t.get("url") or ""
        seen.setdefault(_key(u), t)
        by_host.setdefault(_host(u), t)
    wanted_hosts = {}
    for u in urls:
        wanted_hosts[_host(u)] = wanted_hosts.get(_host(u), 0) + 1

    out, needs = [], []
    for url in urls:
        row = {"url": url, "matched": False, "created": False, "reloaded": False,
               "signed_in": None, "title": None, "final_url": None, "error": None}
        try:
            tab = _match(url, seen, by_host, wanted_hosts)
            if tab is None:
                # A tab this run's own launch opened may still be about:blank.
                tab = _new_tab(port, url, log)
                row["created"] = True
                log(f"opened a tab for {url}")
                time.sleep(2.5)
                seen.setdefault(_key(url), tab)
                by_host.setdefault(_host(url), tab)
            else:
                row["matched"] = True
                if job.get("reload", True) and url not in no_reload:
                    # Reload renews the SSO session and un-sleeps the tab; this is
                    # the same wake path Fetch-from-CPQ uses when a read fails.
                    row["reloaded"] = bool(cf.wake_target(tab, port, wait_s=25))
                    if not row["reloaded"]:
                        log(f"{url} did not finish loading within 25 s", )

            fresh = next((t for t in _tabs(port)
                          if t.get("type") == "page" and t.get("id") == tab.get("id")), None) or tab
            row["final_url"] = fresh.get("url")
            row["title"] = fresh.get("title")
            row["signed_in"] = _looks_signed_in(row["final_url"], row["title"])
            if not row["signed_in"]:
                needs.append(url)
                log(f"{url} is sitting on a sign-in page — it needs a human once")
        except Exception as e:
            row["error"] = str(e)
            log(f"{url} failed: {e}")
        out.append(row)

    return {"ok": not any(r["error"] for r in out), "launched": launched,
            "tabs": out, "needs_signin": needs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    with open(a.job, "r", encoding="utf-8") as f:
        job = json.load(f)
    lines = []

    def log(msg):
        lines.append(msg)
        print(msg, flush=True)

    try:
        res = run(job, log)
    except Exception as e:
        res = {"ok": False, "error": str(e), "tabs": [], "needs_signin": []}
        log(f"[ERR] {e}")
    res["log"] = lines
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=2)
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
