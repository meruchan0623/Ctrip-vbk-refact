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
            logger.log_text(map(record.level()), record.target(), &record.args().to_string());
        }
    }

    fn flush(&self) {}
}

/// Opens the file log and installs the bridge. Failure to open the file
/// leaves logging disabled; it never blocks startup.
pub fn install(dir: PathBuf) {
    if core_diag::init(&core_diag::Config::new(dir)).is_err() {
        return;
    }
    if log::set_logger(&BRIDGE).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}
