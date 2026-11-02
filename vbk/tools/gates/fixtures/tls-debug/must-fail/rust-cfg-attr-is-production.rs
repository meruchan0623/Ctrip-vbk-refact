#[cfg_attr(test, allow(dead_code))]
fn c() {
    let _ = reqwest::Client::builder().danger_accept_invalid_certs(true);
}
