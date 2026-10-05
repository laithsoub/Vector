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

Never pile up tabs (2026-10-05: an unattended night filled Edge until the PC
had to be restarted). Three leaks are closed:
  * relaunch into a live instance — a slow/asleep Edge answered the one 3 s
    probe late, the sweep "launched" msedge.exe on the same profile, and Windows
    handed the URLs to the running window as N new tabs, every 10 min. Now the
    probe retries on 127.0.0.1, a running msedge.exe on our profile is never
    relaunched, and launches have a 30 min cooldown;
  * URL drift — a tab bounced to login.microsoftonline.com no longer matched its
    host, so a fresh tab was opened each sweep. Each URL now remembers the
    target id it owns (state file) and keeps reusing it wherever it wandered;
  * two Vector servers (dev + desktop app) sweeping at once — a machine-wide
    lock lets only one act.
Plus a brake: past MAX_PAGES open pages, nothing new is created.
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


MAX_PAGES = 15                 # past this many open pages, never open another
LAUNCH_COOLDOWN_S = 30 * 60    # at most one Edge launch per half hour
LOCK_STALE_S = 5 * 60          # a sweep holding the lock longer than this died

STATE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Vector")
STATE_PATH = os.path.join(STATE_DIR, "keepalive_state.json")
LOCK_PATH = os.path.join(STATE_DIR, "keepalive.lock")


def _load_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except Exception:
        return {}


def _save_state(state):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass


def _take_lock():
    """Exclusive-create lockfile, so the dev server and the desktop app never
    sweep at the same moment. A lock older than LOCK_STALE_S is taken over."""
    os.makedirs(STATE_DIR, exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            return True
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(LOCK_PATH) > LOCK_STALE_S:
                    os.remove(LOCK_PATH)
                    continue
            except OSError:
                pass
            return False
    return False


def _drop_lock():
    try:
        os.remove(LOCK_PATH)
    except OSError:
        pass


def _port_up(port, tries=3):
    # 127.0.0.1, not localhost: Windows tries ::1 first and a slow fallback made
    # a live Edge look down, which is what triggered the relaunch pile-up.
    for i in range(tries):
        try:
            urlopen(f"http://127.0.0.1:{port}/json/version", timeout=4).read()
            return True
        except Exception:
            if i < tries - 1:
                time.sleep(2)
    return False


def _edge_on_profile(profile):
    """True if an msedge.exe is already running on this --user-data-dir."""
    needle = os.path.normcase(os.path.normpath(profile)).lower()
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
             "ForEach-Object { $_.CommandLine }"],
            capture_output=True, text=True, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout or ""
    except Exception:
        return True            # cannot tell → assume running, never risk a relaunch
    for line in out.splitlines():
        low = line.lower().replace("/", "\\")
        if "--user-data-dir" in low and needle in low:
            return True
    return False


def _tabs(port):
    return json.loads(urlopen(f"http://127.0.0.1:{port}/json", timeout=6).read())


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


def _profile(job):
    return job.get("profile") or os.path.join(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "VectorEdgeDebug")


def _launch_edge(job, state, log):
    """Start the debug-rail Edge on its own profile, minimized, with the tabs.

    Refuses when that profile's Edge is already running: launching again does
    not start a second browser, it hands every URL to the running window as new
    tabs — the pile-up this guard exists for."""
    edge = job.get("edge") or next((p for p in EDGE_PATHS if os.path.exists(p)), None)
    if not edge:
        raise RuntimeError("msedge.exe not found — set \"edge\" in the job to its full path.")
    profile = _profile(job)
    port = int(job.get("port") or 9222)
    if _edge_on_profile(profile):
        raise RuntimeError(
            f"The debug Edge is running but port {port} is not answering (asleep or "
            "busy) — not relaunching, that would only add tabs to it. Next sweep retries.")
    since = time.time() - float(state.get("last_launch") or 0)
    if since < LAUNCH_COOLDOWN_S:
        raise RuntimeError(
            f"Edge was launched {int(since // 60)} min ago and port {port} is still down — "
            f"waiting out the {LAUNCH_COOLDOWN_S // 60} min cooldown instead of launching again.")
    state["last_launch"] = time.time()
    _save_state(state)
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
    import urllib.error
    import urllib.request
    from urllib.parse import quote
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/json/new?{quote(url, safe='')}", method="PUT")
    try:
        return json.loads(urlopen(req, timeout=10).read())
    except urllib.error.HTTPError as e:
        # Only a method refusal falls back — a timeout may already have opened
        # the tab, and a blind GET would open it twice.
        if e.code not in (404, 405):
            raise
        log(f"PUT /json/new refused for {url} ({e}) — trying GET")
        return json.loads(urlopen(
            f"http://127.0.0.1:{port}/json/new?{quote(url, safe='')}", timeout=10).read())


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
    state = _load_state()
    owned = state.setdefault("owned", {})       # wanted url -> target id it owns

    if not _port_up(port):
        if not job.get("launch", True):
            raise RuntimeError(f"Edge debug port {port} is not reachable and launch is off.")
        launched = _launch_edge({**job, "urls": urls, "port": port}, state, log)

    open_tabs = [t for t in _tabs(port) if t.get("type") == "page"]
    by_id = {t.get("id"): t for t in open_tabs}
    seen, by_host = {}, {}
    for t in open_tabs:
        u = t.get("url") or ""
        seen.setdefault(_key(u), t)
        by_host.setdefault(_host(u), t)
    wanted_hosts = {}
    for u in urls:
        wanted_hosts[_host(u)] = wanted_hosts.get(_host(u), 0) + 1
    pages = len(open_tabs)
    claimed = set()

    out, needs = [], []
    for url in urls:
        row = {"url": url, "matched": False, "created": False, "reloaded": False,
               "signed_in": None, "title": None, "final_url": None, "error": None}
        try:
            # The tab this URL owns, wherever it wandered (a sign-in bounce
            # changes its host, which is how the old matcher lost it).
            tab = by_id.get(owned.get(url)) or _match(url, seen, by_host, wanted_hosts)
            if tab is not None and tab.get("id") in claimed:
                tab = None                          # another URL already owns it
            if tab is None:
                if pages >= MAX_PAGES:
                    raise RuntimeError(
                        f"the debug Edge already has {pages} tabs open — not opening "
                        "another. Close some and the next sweep carries on.")
                # A tab this run's own launch opened may still be about:blank.
                tab = _new_tab(port, url, log)
                pages += 1
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

            if tab.get("id"):
                claimed.add(tab["id"])
                owned[url] = tab["id"]
                _save_state(state)
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

    if not _take_lock():
        res = {"ok": True, "skipped": "another sweep is running", "tabs": [], "needs_signin": []}
        log("another keep-alive sweep holds the lock — skipped")
    else:
        try:
            res = run(job, log)
        except Exception as e:
            res = {"ok": False, "error": str(e), "tabs": [], "needs_signin": []}
            log(f"[ERR] {e}")
        finally:
            _drop_lock()
    res["log"] = lines
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=2)
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
