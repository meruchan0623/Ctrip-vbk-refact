//! All `log::*` records pass through this local-only privacy boundary.
use core_diag::{Event, RotatingLog};
use std::{
    io,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Mutex, OnceLock},
};

#[derive(Debug)]
struct Logger;
static LOGGER: Logger = Logger;
static OUTPUT: OnceLock<Mutex<RotatingLog>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);

/// Initialize before opening the state store. Fail closed if another logger has
/// already claimed the facade; silently falling back could expose legacy text.
pub fn init(dir: impl AsRef<Path>) -> io::Result<()> {
    let output = RotatingLog::open(dir)?;
    OUTPUT.set(Mutex::new(output)).map_err(|_| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "diagnostics already initialized",
        )
    })?;
    log::set_logger(&LOGGER).map_err(|_| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "another logger already registered",
        )
    })?;
    log::set_max_level(log::LevelFilter::Info);
    record(log::Level::Info, Event::new("diagnostics_started", &[]));
    Ok(())
}
/// No raw error or raw record is emitted on write failure (including stderr).
pub fn record(level: log::Level, event: Event) {
    let ok = OUTPUT
        .get()
        .and_then(|output| output.lock().ok())
        .map(|mut output| output.write(level.as_str(), &event).is_ok())
        .unwrap_or(false);
    if !ok {
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
}
pub fn dropped_records() -> u64 {
    DROPPED.load(Ordering::Relaxed)
}
impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }
    fn log(&self, raw: &log::Record<'_>) {
        if self.enabled(raw.metadata()) {
            // Never format raw.args(): arbitrary Display implementations and all
            // third-party free text are outside the structured whitelist.
            record(raw.level(), Event::legacy());
        }
    }
    fn flush(&self) {
        if let Some(output) = OUTPUT.get() {
            if let Ok(mut output) = output.lock() {
                let _ = output.flush();
            }
        }
    }
}

/// Typed whitelist values are required; unknown field names are masked by core-diag.
#[macro_export]
macro_rules! diag_log {
    ($level:expr, $event:expr, { $($key:ident = $value:expr),* $(,)? }) => {
        $crate::diagnostics::record($level, core_diag::Event::new($event, &[$((stringify!($key), $value)),*]))
    };
}
