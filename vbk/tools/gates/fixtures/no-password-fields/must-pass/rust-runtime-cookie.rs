// runtime cookie handling: header prefixes and untyped locals are not schema fields
const SECRET_PATTERNS: [&str; 3] = ["bticket=", "Cookie:", "vbkticket="];
fn strip(jar: &[String]) -> usize { let cookies = jar.len(); cookies }
fn fresh() { cookie::Jar::new(); }
