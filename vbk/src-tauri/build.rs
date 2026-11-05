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
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands));
    // tauri-build embeds its manifest only into the app binary, so MSVC test
    // binaries miss Common-Controls v6 and die at startup with
    // STATUS_ENTRYPOINT_NOT_FOUND. Link the same manifest into every target.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("tauri_build");
}
