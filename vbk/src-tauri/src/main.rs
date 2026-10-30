// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Archive §4.5 step 0: a constrained internal crash-monitor mode is
    // recognised before any Tauri/single-instance/update path. Not shipped in
    // this iteration; the flag is reserved so a later REL-04 cannot collide
    // with ordinary argument handling.
    if std::env::args().any(|a| a == "--vbk-crash-monitor") {
        eprintln!("crash-monitor mode is not implemented in this build");
        std::process::exit(2);
    }
    vbk_host::run();
}
