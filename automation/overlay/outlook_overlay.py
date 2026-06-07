"""
outlook_overlay.py — floating EL Pricer companion that hovers over Outlook.

Two states, one window:
  - Collapsed: a tiny 60x60 frameless circular "V" button, always on top.
  - Expanded: 420x640 pricer panel that one-shot reads the current Outlook
    selection, runs the grounded EL pricer, and lets the user build a
    copyable material schedule.

The user drags the V button to wherever they want (corner of Outlook, etc.).
Click V → expand. Click X in the panel header → collapse back to V. Right-click
tray icon for Show / Hide / Quit.

State persisted to overlay_state.json:
  collapsed_x, collapsed_y, expanded_width, expanded_height, pinned

Requirements:
  pip install pywebview pystray pillow
"""
from __future__ import annotations
import ctypes
import json
import os
import sys
import threading
import time
import urllib.request
import urllib.error

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
STATE_PATH  = os.path.join(SCRIPT_DIR, 'overlay_state.json')
OVERLAY_URL = 'http://localhost:3000/?embed=1'
APP_TITLE   = 'EL Pricer'

COLLAPSED_W = 48
COLLAPSED_H = 48
EXPANDED_W  = 480
EXPANDED_H  = 720
EXPANDED_MIN_W = 380
EXPANDED_MIN_H = 480
ROUND_RADIUS = 14


# ─── Win32 region clipping (true circular / rounded-rect window shape) ───────
# Using SetWindowRgn the OS literally clips the window to the given region.
# Anything outside the region is not part of the window — no rectangular
# background, no click capture, genuinely floating shape.
def _gdi32():
    return ctypes.windll.gdi32

def _user32():
    u = ctypes.windll.user32
    u.FindWindowW.restype = ctypes.c_void_p
    u.SetWindowRgn.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_bool]
    return u


def find_hwnd(title: str):
    try:
        return _user32().FindWindowW(None, title)
    except Exception:
        return None


def apply_circle_region(hwnd, size: int) -> None:
    if not hwnd:
        return
    try:
        g = _gdi32()
        hrgn = g.CreateEllipticRgn(0, 0, size, size)
        _user32().SetWindowRgn(hwnd, hrgn, True)
    except Exception as e:
        sys.stderr.write(f'[overlay] circle region failed: {e}\n')


def apply_rounded_rect_region(hwnd, w: int, h: int, radius: int = ROUND_RADIUS) -> None:
    if not hwnd:
        return
    try:
        g = _gdi32()
        hrgn = g.CreateRoundRectRgn(0, 0, w, h, radius * 2, radius * 2)
        _user32().SetWindowRgn(hwnd, hrgn, True)
    except Exception as e:
        sys.stderr.write(f'[overlay] rounded region failed: {e}\n')

DEFAULT_STATE = {
    'collapsed_x':     None,        # None → centre on first run
    'collapsed_y':     None,
    'expanded_width':  EXPANDED_W,
    'expanded_height': EXPANDED_H,
    'pinned':          True,
    'started_collapsed': True,
}


def load_state() -> dict:
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            s = {**DEFAULT_STATE, **json.load(f)}
    except Exception:
        return dict(DEFAULT_STATE)
    # Floor saved dimensions in case the user is reopening with a stale
    # too-small width left over from previous defaults.
    try:
        if int(s.get('expanded_width', 0))  < EXPANDED_MIN_W: s['expanded_width']  = EXPANDED_W
        if int(s.get('expanded_height', 0)) < EXPANDED_MIN_H: s['expanded_height'] = EXPANDED_H
    except Exception:
        pass
    return s


def save_state(state: dict) -> None:
    try:
        with open(STATE_PATH, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        sys.stderr.write(f'[overlay] could not save state: {e}\n')


def wait_for_server(url: str, max_wait_s: float = 30.0) -> bool:
    import time
    deadline = time.time() + max_wait_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, urllib.error.HTTPError, OSError):
            pass
        time.sleep(0.5)
    return False


def enable_dpi_awareness() -> None:
    """Without this, Python is treated as a legacy non-DPI-aware app and
    Windows scales the whole window down on high-DPI displays — making a
    requested 440 px window appear roughly 290 px wide at 150% scaling.
    Has to run BEFORE the webview window is created."""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)   # PER_MONITOR_AWARE_V2
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()        # older Windows fallback
    except Exception:
        pass


def main() -> None:
    enable_dpi_awareness()

    try:
        import webview
    except ImportError:
        sys.stderr.write('Missing dependency: pywebview. Run: pip install pywebview\n')
        sys.exit(1)
    try:
        import pystray
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        sys.stderr.write('Missing dependency: pystray / Pillow. Run: pip install pystray pillow\n')
        sys.exit(1)

    print(f'[overlay] checking http://localhost:3000/ …')
    if not wait_for_server('http://localhost:3000/', max_wait_s=20):
        sys.stderr.write(
            'Vector server is not running on http://localhost:3000.\n'
            'Start it first (start.bat or `npm run dev`) and try again.\n'
        )
        sys.exit(2)
    print('[overlay] server up — launching V button')

    state = load_state()
    # Mutable container so Api methods can read/write across closures.
    runtime = {
        'pinned':           bool(state['pinned']),
        'expanded':         False,
        'expanded_width':   int(state['expanded_width']),
        'expanded_height':  int(state['expanded_height']),
        # Saved position of the COLLAPSED V button (where the user dragged it).
        'collapsed_x':      state.get('collapsed_x'),
        'collapsed_y':      state.get('collapsed_y'),
        # Drag bookkeeping
        'drag_start_win':   None,    # (x, y) of window at drag start
        'drag_start_mouse': None,    # (sx, sy) of mouse at drag start
        # Win32 HWND, populated after the window is shown
        'hwnd':             None,
        'last_region_size': (0, 0),
    }

    def reapply_region(explicit_w: int | None = None, explicit_h: int | None = None):
        """Match the OS window region to the current logical state.

        If explicit_w/h are given they win over window.width/height — used
        by expand() right after window.resize() to avoid the brief race
        where window.width still reports the old value."""
        hwnd = runtime.get('hwnd')
        if not hwnd:
            return
        try:
            if runtime['expanded']:
                ww = int(explicit_w if explicit_w is not None else window.width)
                hh = int(explicit_h if explicit_h is not None else window.height)
                apply_rounded_rect_region(hwnd, ww, hh)
                runtime['last_region_size'] = (ww, hh)
            else:
                apply_circle_region(hwnd, COLLAPSED_W)
                runtime['last_region_size'] = (COLLAPSED_W, COLLAPSED_H)
        except Exception as e:
            sys.stderr.write(f'[overlay] reapply region failed: {e}\n')

    class Api:
        # ── Drag (called by React from the header strip / V button) ─────────
        def begin_drag(self, sx, sy):
            try:
                runtime['drag_start_win']   = (window.x, window.y)
                runtime['drag_start_mouse'] = (float(sx), float(sy))
            except Exception:
                pass

        def drag_to(self, sx, sy):
            try:
                wstart = runtime['drag_start_win']
                mstart = runtime['drag_start_mouse']
                if not wstart or not mstart:
                    return
                dx = float(sx) - mstart[0]
                dy = float(sy) - mstart[1]
                new_x = int(wstart[0] + dx)
                new_y = int(wstart[1] + dy)
                window.move(new_x, new_y)
            except Exception:
                pass

        def end_drag(self):
            try:
                if not runtime['expanded']:
                    # When collapsed, remember where the V button ended up.
                    runtime['collapsed_x'] = window.x
                    runtime['collapsed_y'] = window.y
                    persist()
            except Exception:
                pass
            runtime['drag_start_win']   = None
            runtime['drag_start_mouse'] = None

        # ── Expand / collapse ──────────────────────────────────────────────
        def expand(self):
            try:
                # Remember where the V button sits before we grow.
                runtime['collapsed_x'] = window.x
                runtime['collapsed_y'] = window.y
                runtime['expanded'] = True
                new_w = runtime['expanded_width']
                new_h = runtime['expanded_height']
                window.resize(new_w, new_h)
                # Pass the new size explicitly — window.width may still report
                # the old 48 px right after resize() returns.
                reapply_region(new_w, new_h)
                persist()
            except Exception as e:
                sys.stderr.write(f'[overlay] expand failed: {e}\n')

        def collapse(self):
            try:
                # Remember the expanded size so a fresh expand picks it up.
                runtime['expanded_width']  = window.width
                runtime['expanded_height'] = window.height
                runtime['expanded'] = False
                window.resize(COLLAPSED_W, COLLAPSED_H)
                # Snap back to the saved V button spot.
                if runtime['collapsed_x'] is not None and runtime['collapsed_y'] is not None:
                    window.move(int(runtime['collapsed_x']), int(runtime['collapsed_y']))
                reapply_region()
                persist()
            except Exception as e:
                sys.stderr.write(f'[overlay] collapse failed: {e}\n')

        def toggle_pin(self):
            runtime['pinned'] = not runtime['pinned']
            try: window.on_top = runtime['pinned']
            except Exception: pass
            persist()
            return runtime['pinned']

        # Hide to tray (the React close button calls this).
        def hide(self):
            try: window.hide()
            except Exception: pass

    def persist():
        save_state({
            'collapsed_x':     runtime['collapsed_x'],
            'collapsed_y':     runtime['collapsed_y'],
            'expanded_width':  runtime['expanded_width'],
            'expanded_height': runtime['expanded_height'],
            'pinned':          runtime['pinned'],
            'started_collapsed': True,
        })

    api = Api()

    # ── Window ──────────────────────────────────────────────────────────────
    create_kwargs = dict(
        title=APP_TITLE,
        url=OVERLAY_URL,
        width=COLLAPSED_W,
        height=COLLAPSED_H,
        min_size=(50, 50),
        resizable=True,
        frameless=True,
        on_top=runtime['pinned'],
        js_api=api,
        # PyWebView only accepts 6-char hex. If transparency is supported on
        # this backend, this colour is invisible anyway; otherwise the V
        # button shows on a solid dark square.
        background_color='#0f172a',
        transparent=True,
    )
    if runtime['collapsed_x'] is not None and runtime['collapsed_y'] is not None:
        create_kwargs['x'] = int(runtime['collapsed_x'])
        create_kwargs['y'] = int(runtime['collapsed_y'])

    # Some pywebview backends reject easy_drag kwarg; we don't need it anyway.
    create_kwargs.pop('easy_drag', None)
    window = webview.create_window(**create_kwargs)

    # Save state on close
    def on_closing():
        try:
            if runtime['expanded']:
                runtime['expanded_width']  = window.width
                runtime['expanded_height'] = window.height
            else:
                runtime['collapsed_x'] = window.x
                runtime['collapsed_y'] = window.y
        except Exception:
            pass
        persist()
    window.events.closing += on_closing

    # ── Shape clipping ──────────────────────────────────────────────────────
    # When the window is first shown we resolve its HWND and apply the
    # circular region. A background thread re-applies the region whenever
    # the user resizes the expanded panel.
    def on_shown():
        time.sleep(0.05)
        runtime['hwnd'] = find_hwnd(APP_TITLE)
        reapply_region()
    window.events.shown += on_shown

    def watch_size():
        while True:
            try:
                if runtime.get('hwnd'):
                    cur = (int(window.width), int(window.height))
                    if cur != runtime['last_region_size']:
                        reapply_region()
            except Exception:
                pass
            time.sleep(0.25)
    threading.Thread(target=watch_size, daemon=True).start()

    # ── Tray icon ───────────────────────────────────────────────────────────
    def make_icon_image() -> 'Image.Image':
        img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
        d   = ImageDraw.Draw(img)
        d.ellipse((4, 4, 60, 60), fill=(245, 158, 11, 255))   # amber-500
        d.text((22, 18), 'V', fill=(255, 255, 255, 255))
        return img

    def tray_show(icon, item):
        try: window.show()
        except Exception: pass

    def tray_hide(icon, item):
        try: window.hide()
        except Exception: pass

    def tray_toggle_pin(icon, item):
        api.toggle_pin()

    def tray_quit(icon, item):
        on_closing()
        try: icon.stop()
        except Exception: pass
        try: window.destroy()
        except Exception: pass

    def is_pinned(_item):
        return runtime['pinned']

    menu = pystray.Menu(
        pystray.MenuItem('Show V',       tray_show, default=True),
        pystray.MenuItem('Hide',         tray_hide),
        pystray.MenuItem('Always on top', tray_toggle_pin, checked=is_pinned),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('Quit',         tray_quit),
    )

    tray = pystray.Icon('el-pricer-overlay', make_icon_image(), APP_TITLE, menu)
    threading.Thread(target=tray.run, daemon=True).start()

    try:
        webview.start(debug=False)
    finally:
        try: tray.stop()
        except Exception: pass


if __name__ == '__main__':
    main()
