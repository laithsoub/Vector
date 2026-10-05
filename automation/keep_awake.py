"""
keep_awake.py — keep the PC awake and Teams showing "Available" while away.

    python keep_awake.py --parent-pid 1234 [--idle 60] [--every 30]

Two separate things go to sleep on an unattended PC:
  * Windows itself (sleep, display off, screensaver/lock) — held off with
    SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
  * Teams presence, which turns "Away" from the INPUT idle timer, not from the
    power state — so the execution state alone never keeps Teams green. When
    nobody has touched the keyboard/mouse for --idle seconds, one F15 key press
    (a key no app binds, and no keyboard has) plus a zero-pixel mouse nudge are
    injected with SendInput; that resets GetLastInputInfo, which Teams reads.

Nothing is injected while someone is using the PC (idle < --idle), so it never
types into whatever window has focus. Injection cannot work once the session is
LOCKED — switch it on before walking away.

Runs until killed, or until --parent-pid (the Vector server) is gone, so a
crashed/restarted server never leaves an orphan pressing keys forever.
"""
import argparse
import ctypes
import sys
import time
from ctypes import wintypes

ES_CONTINUOUS       = 0x80000000
ES_SYSTEM_REQUIRED  = 0x00000001
ES_DISPLAY_REQUIRED = 0x00000002

INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_KEYUP  = 0x0002
MOUSEEVENTF_MOVE = 0x0001
VK_F15 = 0x7E

SYNCHRONIZE = 0x00100000
WAIT_TIMEOUT = 0x00000102

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]


class _U(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def idle_seconds():
    lii = LASTINPUTINFO(cbSize=ctypes.sizeof(LASTINPUTINFO))
    if not user32.GetLastInputInfo(ctypes.byref(lii)):
        return 0.0
    return ((kernel32.GetTickCount() - lii.dwTime) & 0xFFFFFFFF) / 1000.0


def nudge():
    """F15 down/up + a zero-pixel relative mouse move. Returns events sent."""
    seq = (INPUT * 3)()
    seq[0].type = INPUT_KEYBOARD; seq[0].ki = KEYBDINPUT(VK_F15, 0, 0, 0, 0)
    seq[1].type = INPUT_KEYBOARD; seq[1].ki = KEYBDINPUT(VK_F15, 0, KEYEVENTF_KEYUP, 0, 0)
    seq[2].type = INPUT_MOUSE;    seq[2].mi = MOUSEINPUT(0, 0, 0, MOUSEEVENTF_MOVE, 0, 0)
    return user32.SendInput(3, seq, ctypes.sizeof(INPUT))


def parent_alive(handle):
    return handle is None or kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parent-pid", type=int, default=0)
    ap.add_argument("--idle", type=float, default=60.0, help="seconds untouched before a nudge")
    ap.add_argument("--every", type=float, default=30.0, help="seconds between checks")
    a = ap.parse_args()

    parent = None
    if a.parent_pid:
        parent = kernel32.OpenProcess(SYNCHRONIZE, False, a.parent_pid) or None

    kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
    print(f"keep-awake on (nudge after {a.idle:.0f}s idle)", flush=True)
    try:
        while parent_alive(parent):
            idle = idle_seconds()
            if idle >= a.idle:
                sent = nudge()
                print(f"nudged after {idle:.0f}s idle (SendInput -> {sent})", flush=True)
            time.sleep(a.every)
    except KeyboardInterrupt:
        pass
    finally:
        kernel32.SetThreadExecutionState(ES_CONTINUOUS)
    print("keep-awake off", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
