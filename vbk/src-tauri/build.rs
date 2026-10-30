//! Declares the app-level commands so `tauri_build` autogenerates one
//! `allow-<command>` permission each (used by `capabilities/*.json`). Keep
//! this list identical to `commands::COMMAND_NAMES` and to
//! `ui/packages/ipc/src/commands.ts`.
fn main() {
    println!("cargo:rerun-if-changed=commands.txt");
    // `AppManifest::commands` takes `&'static [&'static str]`; the build
    // script is a short-lived process, so leaking the list is fine.
    let text: &'static str = include_str!("commands.txt");
    let commands: &'static [&'static str] = Box::leak(
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect::<Vec<&'static str>>()
            .into_boxed_slice(),
    );
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("tauri_build");
}
