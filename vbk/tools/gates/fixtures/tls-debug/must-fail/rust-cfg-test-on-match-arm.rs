fn c(x: u8) {
    match x {
        #[cfg(test)]
        0 => {}
        _ => {
            let _ = reqwest::Client::builder().danger_accept_invalid_certs(true);
        }
    }
}
