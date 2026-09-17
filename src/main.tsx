import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
// Mantine's stylesheets load BEFORE index.css on purpose. Mantine styles every
// control through a class (.m_…), Tailwind's preflight resets bare elements
// (button, input), so Mantine wins on specificity and keeps its controls intact;
// our Tailwind utilities, being later in source order, still override Mantine at
// equal specificity. Swap the order and preflight strips every Mantine control.
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/spotlight/styles.css';
import './index.css';

// The packaged app loads twice:
//   1. Tauri opens the bundled assets at http://tauri.localhost (no server yet).
//      Rust then navigates the window to the sidecar URL once it's up.
//   2. Reload from http://localhost:<port> — same-origin with the Express sidecar,
//      so axios uses relative paths (no CORS, session cookie persists).
// In browser/Vite dev we're already on localhost and just render normally.
const isTauri      = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
const onSidecar    = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

if (isTauri && !onSidecar) {
  // Bootstrap page (tauri.localhost) — wait for Rust to navigate us to the sidecar.
  document.getElementById('root')!.innerHTML =
    '<div style="height:100vh;display:flex;align-items:center;justify-content:center;' +
    'font:500 15px system-ui;color:#888">Starting Vector…</div>';
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
