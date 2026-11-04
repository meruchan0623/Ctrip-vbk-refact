//! Routes every `log::*` call of the host through `core-diag`: free text is
//! masked (ticket / cookie / phone / order no. / e-mail / ID / URL query /
//! home paths) and cut to 512 chars, then written to the rotating file log
//! under `<app data>/logs`. Structured call sites use `core_diag::diag_log!`.

use std::path::PathBuf;

use core_diag::Level;

struct Bridge;

static BRIDGE: Bridge = Bridge;

fn map(level: log::Level) -> Level {
    match level {
        log::Level::Error => Level::Error,
        log::Level::Warn => Level::Warn,
        log::Level::Info => Level::Info,
        log::Level::Debug => Level::Debug,
        log::Level::Trace => Level::Trace,
    }
}

impl log::Log for Bridge {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        if let Some(logger) = core_diag::global() {
            logger.log_text(
                map(record.level()),
                record.target(),
                &record.args().to_string(),
            );
        }
    }

    fn flush(&self) {}
}

/// Opens the file log and installs the bridge. Failure to open the file
/// leaves logging disabled; it never blocks startup. Calling it twice is
/// harmless: the first logger and the first `log` sink stay in place.
///
/// The account-hash salt is a per-install random value stored next to (not
/// inside) the log directory, so it is neither exported with nor scanned as
/// part of the logs, and the hashes in a diagnostic bundle cannot be
/// reversed with a table built from the public default salt.
pub fn install(dir: PathBuf) {
    let mut cfg = core_diag::Config::new(dir.clone());
    let salt_path = dir
        .parent()
        .map(|p| p.join("diag.salt"))
        .unwrap_or_else(|| dir.join("diag.salt"));
    if let Ok(salt) = core_diag::load_or_create_salt(&salt_path) {
        cfg.salt = salt;
    }
    if let Err(e) = core_diag::init(&cfg) {
        // No file log: nothing is written anywhere in release builds.
        #[cfg(debug_assertions)]
        eprintln!("diag: file log unavailable ({e})");
        let _ = e;
        return;
    }
    if log::set_logger(&BRIDGE).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}
