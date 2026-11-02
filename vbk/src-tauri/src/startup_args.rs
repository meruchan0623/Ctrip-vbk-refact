//! Only local window activation is supported. URL/deep-link handling is not
//! enabled until a typed, allowlisted route has been implemented.

pub fn allows(args: impl IntoIterator<Item = String>) -> bool {
    let args: Vec<String> = args.into_iter().collect();
    args.is_empty() || args == ["--show"]
}

#[cfg(test)]
mod tests {
    use super::allows;

    #[test]
    fn allows_only_empty_or_explicit_window_activation() {
        assert!(allows(Vec::<String>::new()));
        assert!(allows(["--show".into()]));
        for args in [
            vec!["--remote-debugging-port=9222"],
            vec!["--ignore-certificate-errors"],
            vec!["--show", "https://example.invalid"],
            vec!["vbookingChat://send?text=synthetic"],
            vec!["--show", "--show"],
        ] {
            assert!(!allows(args.into_iter().map(str::to_owned)));
        }
    }
}
