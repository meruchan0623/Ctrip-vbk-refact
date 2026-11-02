fn client() {
    let _ = reqwest::Client::builder()
        .danger_accept_invalid_certs(
            true)
        .build();
}
