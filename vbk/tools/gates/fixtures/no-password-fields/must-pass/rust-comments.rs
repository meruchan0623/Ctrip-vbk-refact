// no password is ever stored here
/// remember_password stays unsupported
pub struct Prefs { pub theme: String }
const NOTE: &str = "passwords live in the OS keychain, not in prefs";
