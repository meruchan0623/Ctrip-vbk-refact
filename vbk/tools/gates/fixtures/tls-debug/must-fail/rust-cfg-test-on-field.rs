struct S {
    #[cfg(test)]
    a: u8,
    b: u8,
}
fn c() {
    let _ = reqwest::Client::builder().danger_accept_invalid_certs(true);
}
