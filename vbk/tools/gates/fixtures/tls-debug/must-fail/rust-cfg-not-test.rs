#[cfg(not(test))]
fn c() {
    let _ = reqwest::Client::builder().danger_accept_invalid_certs(true);
}
