//! Structured redacting file log and sensitive-content scanner (std-only).
//!
//! * [`diag_log!`] — `diag_log!(Level::Info, "login.ok", { account_id = id, count = 3 })`.
//!   Only keys in [`ALLOW_LIST`] are printed (rendered per policy: account
//!   -> 8-hex hash, gid -> mask, URL -> no query, path -> file name only);
//!   every other key is written as `<redacted:TYPE>` regardless of value.
//! * [`sanitize_text`] / [`Logger::log_text`] — free text (the `log::*`
//!   bridge): ticket / cookie / phone / order no. / e-mail / citizen ID /
//!   URL query / home paths masked, then cut to 512 chars.
//! * [`RotatingFile`] — 20 MB slices, slice count derived from the total cap.
//! * [`scan`] — the one detector shared by the masker, the diagnostic-export
//!   sanitizer ([`export`]) and the acceptance scan of rotated log slices.

pub mod detect;
pub mod export;
mod logger;
mod policy;
mod rotate;
pub mod scan;
mod sha256;
mod value;

pub use detect::{basename, detect as detect_spans, mask as mask_text, Kind, Span};
pub use logger::{
    emit, format_record, format_utc, global, init, load_or_create_salt, Config, Logger,
    DEFAULT_SALT,
};
pub use policy::{
    account_tag, mask_gid, policy_of, render_field, sanitize_text, truncate_chars, Policy,
    ALLOW_LIST, MAX_TEXT_CHARS,
};
pub use rotate::{
    rotated_slices, slice_paths, RotatingFile, DEFAULT_MAX_FILE_BYTES, DEFAULT_TOTAL_CAP_BYTES,
};
pub use value::{Level, ToValue, Value};

/// Structured log call. Field names are identifiers; values must be
/// strings, integers or bools. Unregistered keys are masked at render time.
#[macro_export]
macro_rules! diag_log {
    ($level:expr, $event:expr) => {
        $crate::emit($level, $event, module_path!(), &[])
    };
    ($level:expr, $event:expr, { $($key:ident = $val:expr),* $(,)? }) => {
        $crate::emit(
            $level,
            $event,
            module_path!(),
            &[ $( (stringify!($key), $crate::ToValue::to_value(&$val)) ),* ],
        )
    };
}
