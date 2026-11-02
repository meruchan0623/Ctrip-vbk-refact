//! Deep-link whitelist parser and second-instance argument plan.
//!
//! Security stance (plan I-20, official SEC-14):
//!
//! * own scheme only ([`SCHEME`]); the official client's `vbookingChat`
//!   scheme is never registered or handled;
//! * a fixed set of actions, each with a fixed parameter whitelist; unknown
//!   actions / parameters / duplicates reject the whole link;
//! * parameter values are short ids from `[A-Za-z0-9_-]` (after strict
//!   percent-decoding); there are no URLs, paths, commands or free text;
//! * the result is a navigation request only: nothing in this module writes
//!   configuration, touches login state or sends anything. The host decides
//!   whether the request is currently acceptable (e.g. window exists).
//!
//! Grammar: `vbkdesk://<action>[/][?k=v[&k=v]*]`.

/// The only scheme this application registers.
pub const SCHEME: &str = "vbkdesk";
/// The official client's scheme. Must never be registered here.
pub const FOREIGN_SCHEME: &str = "vbookingChat";

pub const MAX_LINK_LEN: usize = 512;
pub const MAX_ID_LEN: usize = 64;
/// Second instance: only this many arguments are looked at.
pub const MAX_ARGS_SCANNED: usize = 16;

/// Setting sections a deep link may open (mirrors `SECTIONS` in
/// `ui/apps/setting/viewmodel.ts`).
pub const SETTING_SECTIONS: [&str; 9] = [
    "general",
    "display",
    "notify",
    "keys",
    "assistant",
    "network",
    "storage",
    "privacy",
    "about",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkAction {
    /// Show and focus the main window.
    FocusMain,
    /// Ask the main window to select a conversation.
    OpenConversation { session_id: String },
    /// Open the settings window on a section.
    OpenSettings { section: &'static str },
}

impl DeepLinkAction {
    /// Invariant used by tests: the action only carries whitelisted data.
    pub fn is_within_whitelist(&self) -> bool {
        match self {
            DeepLinkAction::FocusMain => true,
            DeepLinkAction::OpenConversation { session_id } => valid_id(session_id),
            DeepLinkAction::OpenSettings { section } => SETTING_SECTIONS.contains(section),
        }
    }

    /// Canonical link text for this action (round-trips through
    /// [`parse`]).
    pub fn to_link(&self) -> String {
        match self {
            DeepLinkAction::FocusMain => format!("{SCHEME}://open"),
            DeepLinkAction::OpenConversation { session_id } => {
                format!("{SCHEME}://conversation?session={session_id}")
            }
            DeepLinkAction::OpenSettings { section } => {
                format!("{SCHEME}://settings?section={section}")
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeepLinkError {
    TooLong,
    /// Non-ASCII or control characters.
    BadCharacter,
    /// Carries the official client's scheme.
    ForeignScheme,
    NotOurScheme,
    /// Fragment, userinfo, extra path segments or other disallowed syntax.
    BadSyntax,
    UnknownAction,
    UnknownParam,
    DuplicateParam,
    MissingParam,
    BadValue,
    BadEscape,
}

fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_ID_LEN
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Strict percent-decoding into an id candidate. Any malformed escape, or a
/// decoded byte outside the id charset, is an error.
fn decode_id(raw: &str) -> Result<String, DeepLinkError> {
    let b = raw.as_bytes();
    let mut out = String::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let byte = if b[i] == b'%' {
            let hi = b
                .get(i + 1)
                .copied()
                .and_then(hex)
                .ok_or(DeepLinkError::BadEscape)?;
            let lo = b
                .get(i + 2)
                .copied()
                .and_then(hex)
                .ok_or(DeepLinkError::BadEscape)?;
            i += 3;
            hi * 16 + lo
        } else {
            i += 1;
            b[i - 1]
        };
        if !(byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') {
            return Err(DeepLinkError::BadValue);
        }
        out.push(byte as char);
    }
    if valid_id(&out) {
        Ok(out)
    } else {
        Err(DeepLinkError::BadValue)
    }
}

/// Parse one link. Never panics, never allocates beyond the input bound.
pub fn parse(input: &str) -> Result<DeepLinkAction, DeepLinkError> {
    if input.len() > MAX_LINK_LEN {
        return Err(DeepLinkError::TooLong);
    }
    if !input.bytes().all(|b| (0x21..0x7f).contains(&b)) {
        return Err(DeepLinkError::BadCharacter);
    }
    let (scheme, rest) = input.split_once(':').ok_or(DeepLinkError::NotOurScheme)?;
    if scheme.eq_ignore_ascii_case(FOREIGN_SCHEME) {
        return Err(DeepLinkError::ForeignScheme);
    }
    if !scheme.eq_ignore_ascii_case(SCHEME) {
        return Err(DeepLinkError::NotOurScheme);
    }
    let rest = rest.strip_prefix("//").ok_or(DeepLinkError::BadSyntax)?;
    if rest.contains('#') {
        return Err(DeepLinkError::BadSyntax);
    }
    let (head, query) = match rest.split_once('?') {
        Some((h, q)) => (h, Some(q)),
        None => (rest, None),
    };
    let action = head.strip_suffix('/').unwrap_or(head);
    let allowed: &[&str] = match action {
        "open" => &[],
        "conversation" => &["session"],
        "settings" => &["section"],
        _ => {
            return Err(if action.bytes().all(|b| b.is_ascii_lowercase()) {
                DeepLinkError::UnknownAction
            } else {
                DeepLinkError::BadSyntax
            })
        }
    };

    let mut value: Option<String> = None;
    if let Some(q) = query.filter(|q| !q.is_empty()) {
        for pair in q.split('&') {
            let (k, v) = pair.split_once('=').ok_or(DeepLinkError::BadSyntax)?;
            if !allowed.contains(&k) {
                return Err(DeepLinkError::UnknownParam);
            }
            if value.is_some() {
                return Err(DeepLinkError::DuplicateParam);
            }
            value = Some(decode_id(v)?);
        }
    }

    match (action, value) {
        ("open", None) => Ok(DeepLinkAction::FocusMain),
        ("conversation", Some(session_id)) => Ok(DeepLinkAction::OpenConversation { session_id }),
        ("settings", Some(s)) => SETTING_SECTIONS
            .iter()
            .find(|x| **x == s)
            .map(|section| DeepLinkAction::OpenSettings { section })
            .ok_or(DeepLinkError::BadValue),
        ("open", Some(_)) => Err(DeepLinkError::UnknownParam),
        _ => Err(DeepLinkError::MissingParam),
    }
}

/// What to do when a second instance is launched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecondInstancePlan {
    /// Always true: the existing instance shows and focuses its main window.
    pub focus_main: bool,
    /// First valid deep link among the arguments, if any.
    pub action: Option<DeepLinkAction>,
    /// Arguments that were not acted on (count only; their text may carry
    /// secrets and is never echoed into diagnostics).
    pub ignored_args: usize,
}

/// Plan for a second launch. `args[0]` (the executable) is skipped. Anything
/// that is not a valid deep link is ignored: arguments are never treated as
/// file paths, flags or commands.
pub fn plan_second_instance(args: &[String]) -> SecondInstancePlan {
    let mut action = None;
    let mut acted = 0;
    for a in args.iter().skip(1).take(MAX_ARGS_SCANNED) {
        if action.is_none() {
            if let Ok(act) = parse(a) {
                action = Some(act);
                acted += 1;
            }
        }
    }
    SecondInstancePlan {
        focus_main: true,
        action,
        ignored_args: args.len().saturating_sub(1).saturating_sub(acted),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_scheme_never_collides_with_official() {
        assert!(!SCHEME.eq_ignore_ascii_case(FOREIGN_SCHEME));
        assert!(SCHEME.bytes().all(|b| b.is_ascii_lowercase()));
    }

    #[test]
    fn valid_links() {
        assert_eq!(parse("vbkdesk://open"), Ok(DeepLinkAction::FocusMain));
        assert_eq!(parse("VBKDESK://open/"), Ok(DeepLinkAction::FocusMain));
        assert_eq!(parse("vbkdesk://open?"), Ok(DeepLinkAction::FocusMain));
        assert_eq!(
            parse("vbkdesk://conversation?session=ab-12_Z"),
            Ok(DeepLinkAction::OpenConversation {
                session_id: "ab-12_Z".into()
            })
        );
        assert_eq!(
            parse("vbkdesk://conversation?session=a%62c"),
            Ok(DeepLinkAction::OpenConversation {
                session_id: "abc".into()
            })
        );
        assert_eq!(
            parse("vbkdesk://settings?section=notify"),
            Ok(DeepLinkAction::OpenSettings { section: "notify" })
        );
    }

    #[test]
    fn foreign_and_other_schemes_rejected() {
        assert_eq!(
            parse("vbookingChat://open"),
            Err(DeepLinkError::ForeignScheme)
        );
        assert_eq!(
            parse("VBOOKINGCHAT://x?y=1"),
            Err(DeepLinkError::ForeignScheme)
        );
        for s in [
            "https://example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "open",
            "",
        ] {
            assert!(parse(s).is_err(), "{s:?}");
        }
    }

    #[test]
    fn hostile_inputs_rejected() {
        for s in [
            "vbkdesk://open#frag",
            "vbkdesk://open?x=1",
            "vbkdesk://conversation",
            "vbkdesk://conversation?session=",
            "vbkdesk://conversation?session=a&session=b",
            "vbkdesk://conversation?session=a&x=b",
            "vbkdesk://conversation?session=../../etc",
            "vbkdesk://conversation?session=a%2Fb",
            "vbkdesk://conversation?session=a%2",
            "vbkdesk://conversation?session=a%zz",
            "vbkdesk://conversation?session=a%00b",
            "vbkdesk://conversation?session=https://evil",
            "vbkdesk://settings?section=nonexistent",
            "vbkdesk://settings?section=notify&x=1",
            "vbkdesk://settings/notify",
            "vbkdesk://admin@host/open",
            "vbkdesk://exec?cmd=calc",
            "vbkdesk:open",
            "vbkdesk:/open",
            "vbkdesk://open\n",
            "vbkdesk://open with space",
            "vbkdesk://open\u{e9}",
        ] {
            assert!(parse(s).is_err(), "{s:?}");
        }
        let long = format!("vbkdesk://conversation?session={}", "a".repeat(65));
        assert_eq!(parse(&long), Err(DeepLinkError::BadValue));
        let huge = format!("vbkdesk://open?{}", "a".repeat(600));
        assert_eq!(parse(&huge), Err(DeepLinkError::TooLong));
    }

    #[test]
    fn canonical_link_round_trips() {
        for a in [
            DeepLinkAction::FocusMain,
            DeepLinkAction::OpenConversation {
                session_id: "S-1_x".into(),
            },
            DeepLinkAction::OpenSettings { section: "about" },
        ] {
            assert_eq!(parse(&a.to_link()), Ok(a));
        }
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    const TOKENS: [&str; 30] = [
        "vbkdesk://",
        "vbookingChat://",
        "open",
        "conversation",
        "settings",
        "session",
        "section",
        "notify",
        "?",
        "&",
        "=",
        "%",
        "%2F",
        "%00",
        "%zz",
        "#",
        "@",
        "/",
        "..",
        "\\",
        "\0",
        "\n",
        " ",
        "é",
        "日本",
        "\u{202e}",
        "a",
        "Z9_-",
        ":",
        "//",
    ];

    fn random_input(r: &mut Rng) -> String {
        match r.below(3) {
            0 => {
                let n = r.below(40);
                let bytes: Vec<u8> = (0..n).map(|_| r.next() as u8).collect();
                String::from_utf8_lossy(&bytes).into_owned()
            }
            1 => {
                let mut s = String::new();
                for _ in 0..r.below(14) {
                    s.push_str(TOKENS[r.below(TOKENS.len())]);
                }
                s
            }
            _ => {
                // mutate a valid link
                let seeds = [
                    "vbkdesk://open",
                    "vbkdesk://conversation?session=abc-123",
                    "vbkdesk://settings?section=keys",
                ];
                let mut b = seeds[r.below(seeds.len())].as_bytes().to_vec();
                for _ in 0..=r.below(4) {
                    let i = r.below(b.len());
                    match r.below(3) {
                        0 => b[i] = r.next() as u8,
                        1 => {
                            b.remove(i);
                        }
                        _ => b.insert(i, r.next() as u8),
                    }
                }
                String::from_utf8_lossy(&b).into_owned()
            }
        }
    }

    /// 10 000 random inputs: no panic, and every accepted link is within
    /// the whitelist and in canonical form.
    #[test]
    fn fuzz_ten_thousand_inputs_no_panic_no_escalation() {
        let mut r = Rng(0x9E37_79B9_7F4A_7C15);
        let mut accepted = 0;
        for _ in 0..10_000 {
            let s = random_input(&mut r);
            if let Ok(a) = parse(&s) {
                accepted += 1;
                assert!(a.is_within_whitelist(), "{s:?} -> {a:?}");
                assert_eq!(parse(&a.to_link()), Ok(a.clone()), "{s:?}");
                assert!(!s.to_ascii_lowercase().starts_with("vbookingchat"));
            }
        }
        // the mutation arm must actually hit valid links, otherwise the
        // fuzz would only be testing rejection
        assert!(accepted > 0);
    }

    #[test]
    fn second_instance_always_focuses_and_takes_first_valid_link() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let p = plan_second_instance(&args(&["app.exe"]));
        assert_eq!(
            p,
            SecondInstancePlan {
                focus_main: true,
                action: None,
                ignored_args: 0
            }
        );
        let p = plan_second_instance(&args(&[
            "app.exe",
            "--flag",
            "C:\\x.txt",
            "vbookingChat://open",
            "vbkdesk://settings?section=keys",
            "vbkdesk://open",
        ]));
        assert!(p.focus_main);
        assert_eq!(
            p.action,
            Some(DeepLinkAction::OpenSettings { section: "keys" })
        );
        assert_eq!(p.ignored_args, 4);
        let p = plan_second_instance(&[]);
        assert!(p.focus_main && p.action.is_none());
    }

    #[test]
    fn second_instance_scans_a_bounded_number_of_args() {
        let mut v: Vec<String> = vec!["app".into()];
        v.extend((0..MAX_ARGS_SCANNED).map(|_| "x".to_string()));
        v.push("vbkdesk://open".into());
        assert_eq!(plan_second_instance(&v).action, None);
    }
}
