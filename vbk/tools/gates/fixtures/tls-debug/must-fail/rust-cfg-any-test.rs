#[cfg(any(test, feature = "insecure"))]
fn c() {
    let _ = reqwest::Client::builder().danger_accept_invalid_certs(true);
}
