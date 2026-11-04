//! Strict startup/second-instance argument whitelist. No Chromium flags,
//! foreign protocols, file paths, or mixed link/flag invocations.
use core_update::deeplink::{self, DeepLinkAction};

pub fn request(args: impl IntoIterator<Item = String>) -> Option<DeepLinkAction> {
    let mut args = args.into_iter();
    let first = args.next();
    if args.next().is_some() {
        return None;
    }
    match first.as_deref() {
        None | Some("--show") => Some(DeepLinkAction::FocusMain),
        Some(url) => deeplink::parse(url).ok(),
    }
}

pub fn allows(args: impl IntoIterator<Item = String>) -> bool {
    request(args).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_activation_or_single_whitelisted_link() {
        assert!(allows(Vec::<String>::new()));
        assert!(allows(["--show".into()]));
        assert!(allows(["vbkdesk://settings?section=keys".into()]));
        assert!(allows(["vbkdesk://conversation?session=g-1".into()]));
        for args in [
            vec!["--remote-debugging-port=9222"],
            vec!["--ignore-certificate-errors"],
            vec!["--show", "https://example.invalid"],
            vec!["vbookingChat://send?text=x"],
            vec!["--show", "--show"],
            vec!["vbkdesk://open", "--remote-debugging-port=1"],
            vec!["vbkdesk://conversation?session=g&auth=x"],
            vec!["vbkdesk://settings?section=network&proxy=x"],
        ] {
            assert!(!allows(args.into_iter().map(str::to_owned)));
        }
    }
    #[test]
    fn stops_consuming_unbounded_arguments() {
        let args = std::iter::repeat_with(|| "--show".to_owned());
        assert!(!allows(args));
    }
}
