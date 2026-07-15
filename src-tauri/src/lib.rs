use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

pub struct SidecarPort(pub Mutex<u16>);

#[tauri::command]
fn get_api_port(state: State<SidecarPort>) -> u16 {
    *state.0.lock().unwrap()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(SidecarPort(Mutex::new(7331)))
        .setup(|app| {
            setup_app_data(app.handle())?;
            start_sidecar(app.handle().clone());
            setup_tray(app)?;

            let window = app.get_webview_window("main").unwrap();
            let win_close = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win_close.hide();
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_api_port])
        .run(tauri::generate_context!())
        .expect("error while running Vector");
}

// ─── Copy bundled automation/ to writable AppData on first run ────────────────
fn setup_app_data(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir     = app.path().app_data_dir()?;
    let resource_dir = app.path().resource_dir()?;

    std::fs::create_dir_all(&data_dir)?;

    // Resources declared with `../` paths in tauri.conf.json are bundled under
    // an `_up_/` subdir of the resource dir. Fall back to the plain path for dev.
    let res_base = {
        let up = resource_dir.join("_up_");
        if up.exists() { up } else { resource_dir.clone() }
    };

    // Recursively copy automation/ from resources → AppData, preserving config.json
    let src = res_base.join("automation");
    let dst = data_dir.join("automation");
    if src.exists() {
        copy_dir_preserve_config(&src, &dst)?;
    }

    // Copy sql-wasm.wasm to data_dir so the sidecar can find it via DATA_DIR
    let wasm_src = res_base.join("dist-server").join("sql-wasm.wasm");
    let wasm_dst = data_dir.join("sql-wasm.wasm");
    if wasm_src.exists() && !wasm_dst.exists() {
        std::fs::copy(&wasm_src, &wasm_dst)?;
    }

    Ok(())
}

fn copy_dir_preserve_config(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry    = entry?;
        let ty       = entry.file_type()?;
        let dest     = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_preserve_config(&entry.path(), &dest)?;
        } else {
            // Never overwrite the user's saved config.json
            if entry.file_name() == "config.json" && dest.exists() {
                continue;
            }
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

// ─── Spawn the Express sidecar ────────────────────────────────────────────────
fn start_sidecar(app: tauri::AppHandle) {
    let data_dir = app.path().app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    // Built frontend ships as a resource (under _up_/dist because of the ../ path)
    // so the sidecar can serve it same-origin.
    let frontend_dir = app.path().resource_dir().ok()
        .map(|r| {
            let up = r.join("_up_");
            let base = if up.exists() { up } else { r };
            base.join("dist").to_string_lossy().into_owned()
        })
        .unwrap_or_default();

    // Fallback: show window after 15 s even if sidecar never announces its port
    let app_fallback = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        if let Some(w) = app_fallback.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
    });

    tauri::async_runtime::spawn(async move {
        let sidecar = app
            .shell()
            .sidecar("server")
            .expect("'server' sidecar not found — run `npm run build:server` first")
            .env("TAURI_SIDECAR", "1")
            .env("RESOURCE_DIR",   &data_dir)
            .env("DATA_DIR",       &data_dir)
            .env("FRONTEND_DIR",   &frontend_dir);

        let (mut rx, _child) = match sidecar.spawn() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[sidecar] failed to spawn: {e}");
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval(&format!(
                        "document.body.innerHTML='<pre style=\"color:red;padding:2rem\">Sidecar failed to start:\\n{e}</pre>'"
                    ));
                    let _ = w.show();
                }
                return;
            }
        };

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim();
                    eprintln!("[sidecar] {line}");

                    if let Some(port_str) = line.strip_prefix("VECTOR_PORT:") {
                        if let Ok(port) = port_str.trim().parse::<u16>() {
                            // Update managed state so get_api_port returns the real port
                            *app.state::<SidecarPort>().0.lock().unwrap() = port;

                            // Navigate the window to the sidecar so the app loads
                            // same-origin with the Express server (no CORS, cookies work).
                            if let Some(w) = app.get_webview_window("main") {
                                if let Ok(url) = format!("http://localhost:{port}/").parse() {
                                    let _ = w.navigate(url);
                                }
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[sidecar:err] {}", String::from_utf8_lossy(&bytes).trim());
                }
                CommandEvent::Error(e) => {
                    eprintln!("[sidecar] error: {e}");
                }
                _ => {}
            }
        }
    });
}

// ─── System tray ─────────────────────────────────────────────────────────────
fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "Show Vector",  true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Vector",  true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Vector")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
