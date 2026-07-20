// ─── Cross-environment "open in a real window" helper ────────────────────────
// Vector runs two ways: a plain browser (Vite dev / web) and a packaged Tauri
// desktop app that is a SINGLE WebView2 window. Inside that webview, the DOM
// `window.open(url, '_blank', 'width=…')` does NOT spawn a sized popup — WebView2
// intercepts it and typically navigates the main window (or opens an identical
// webview), so you lose your place and the width/height is ignored. That is the
// "new window is the same current window, not even bigger" bug.
//
// Fix: under Tauri, route these opens through the shell plugin → the OS default
// browser, which gives a proper resizable/maximisable window and never disturbs
// the app window. In a plain browser we keep native `window.open`.
import { open as shellOpen } from '@tauri-apps/plugin-shell';

export const isTauri = (): boolean =>
  '__TAURI_INTERNALS__' in window || '__TAURI__' in window;

// Resolve an app-relative path ("/schematics", "/api/…") to an absolute URL on
// the current origin (the Express sidecar in Tauri, localhost in dev). External
// http(s) URLs are passed through untouched.
function absolute(url: string): string {
  if (/^[a-z]+:\/\//i.test(url) || url.startsWith('mailto:')) return url;
  return location.origin + (url.startsWith('/') ? url : '/' + url);
}

/**
 * Open a URL or app-relative path in a real, resizable OS window.
 * Tauri → OS default browser (via shell). Browser → new tab.
 * Safe to `void` — never throws to the caller.
 */
export async function openExternal(url: string): Promise<void> {
  const abs = absolute(url);
  if (isTauri()) {
    try { await shellOpen(abs); return; }
    catch { /* fall through to window.open below */ }
  }
  window.open(abs, '_blank', 'noopener');
}
