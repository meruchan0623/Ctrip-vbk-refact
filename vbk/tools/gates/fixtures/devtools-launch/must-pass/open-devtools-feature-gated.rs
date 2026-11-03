#[cfg(feature = "devtools")]
fn a(w: &tauri::WebviewWindow) {
    w.open_devtools();
}
