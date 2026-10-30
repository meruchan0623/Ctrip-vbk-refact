//! Declares the app-level commands so `tauri_build` autogenerates one
//! `allow-<command>` permission each (used by `capabilities/*.json`). Keep
//! this list identical to `commands::COMMAND_NAMES` and to
//! `ui/packages/ipc/src/commands.ts`.
fn main() {
    let commands: Vec<&str> = include_str!("commands.txt")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&commands)),
    )
    .expect("tauri_build");
}
