//! Field values accepted by `diag_log!`. Deliberately no `Debug`/`Display`
//! blanket impl: a struct cannot be dumped into a log by accident.

/// Log severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
            Level::Trace => "TRACE",
        }
    }
}

/// A single field value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Str(String),
    Int(i64),
    Bool(bool),
}

impl Value {
    /// Type label used in `<redacted:TYPE>`.
    pub fn type_label(&self) -> &'static str {
        match self {
            Value::Str(_) => "str",
            Value::Int(_) => "int",
            Value::Bool(_) => "bool",
        }
    }
}

/// Conversion used by the macro. Implemented for strings, integers and
/// bool (and references to them) only.
pub trait ToValue {
    fn to_value(&self) -> Value;
}

impl ToValue for str {
    fn to_value(&self) -> Value {
        Value::Str(self.to_string())
    }
}
impl ToValue for String {
    fn to_value(&self) -> Value {
        Value::Str(self.clone())
    }
}
impl ToValue for bool {
    fn to_value(&self) -> Value {
        Value::Bool(*self)
    }
}
impl<T: ToValue + ?Sized> ToValue for &T {
    fn to_value(&self) -> Value {
        (**self).to_value()
    }
}

macro_rules! int_value {
    ($($t:ty),*) => {$(
        impl ToValue for $t {
            fn to_value(&self) -> Value {
                Value::Int(i64::try_from(*self).unwrap_or(i64::MAX))
            }
        }
    )*};
}
int_value!(i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);
