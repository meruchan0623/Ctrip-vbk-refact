#[cfg(debug_assertions)]
fn a(w: &tauri::WebviewWindow) {
    w.open_devtools();
}
