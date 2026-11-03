pub fn prod() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    fn t() {
        let _ = reqwest::Client::builder().danger_accept_invalid_certs(true);
        let _ = "--ignore-certificate-errors";
    }
}

pub fn after() -> u32 {
    2
}
