//! Strict `major.minor.patch` versions. No pre-release or build suffixes:
//! anything else is rejected rather than guessed at.

/// Ordered by (major, minor, patch).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    pub const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// `"1.2.3"` only: three ASCII-digit components, no leading zeros
    /// (except `0` itself), each fitting in `u64`.
    pub fn parse(s: &str) -> Option<Self> {
        let mut it = s.split('.');
        let a = component(it.next()?)?;
        let b = component(it.next()?)?;
        let c = component(it.next()?)?;
        if it.next().is_some() {
            return None;
        }
        Some(Self::new(a, b, c))
    }
}

fn component(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if s.len() > 1 && s.starts_with('0') {
        return None;
    }
    s.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_orders() {
        assert_eq!(Version::parse("1.2.3"), Some(Version::new(1, 2, 3)));
        assert!(Version::parse("1.10.0") > Version::parse("1.9.9"));
        assert!(Version::parse("2.0.0") > Version::parse("1.99.99"));
    }

    #[test]
    fn rejects_malformed() {
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.2.-3",
            "1.2.3-beta",
            "v1.2.3",
            " 1.2.3",
            "1..3",
            "1.2.3 ",
            "1.2.99999999999999999999999",
        ] {
            assert_eq!(Version::parse(bad), None, "{bad:?}");
        }
    }
}
