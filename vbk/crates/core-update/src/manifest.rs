//! Update manifest policy: what a (signature-less, untrusted) manifest must
//! satisfy before anything is downloaded.

use crate::keystatus::KeyStatus;
use crate::version::Version;
use crate::Refusal;

/// Compiled-in key material: fingerprints only (the host maps a fingerprint
/// to the embedded public key). `next` is present only during a rotation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddedKeys {
    pub current: String,
    pub next: Option<String>,
    /// Fingerprints revoked as of this build.
    pub revoked: Vec<String>,
}

/// Fields of the update manifest the policy needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateManifest {
    pub version: Version,
    pub artifact_url: String,
    /// Fingerprint of the key the manifest says it was signed with.
    pub signing_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySlot {
    Current,
    Next,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatePlan {
    pub target: Version,
    pub artifact_url: String,
    pub key_id: String,
    pub slot: KeySlot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanOutcome {
    UpToDate,
    Update(UpdatePlan),
}

/// Everything the policy looks at.
#[derive(Debug, Clone)]
pub struct PlanInput<'a> {
    /// The compiled-in endpoint constant that served the manifest.
    pub manifest_url: &'a str,
    pub manifest: &'a UpdateManifest,
    pub client_version: Version,
    /// Highest manifest version ever accepted (persisted by the host).
    pub highest_seen: Option<Version>,
    pub embedded: &'a EmbeddedKeys,
    /// Output of [`crate::keystatus::effective_status`].
    pub status: &'a KeyStatus,
}

/// `https://host[:port][/...]` only. Rejects userinfo, whitespace, control
/// characters, backslashes and empty / malformed hosts.
pub fn is_https_url(url: &str) -> bool {
    if !url.is_ascii() || url.len() < 8 || !url[..8].eq_ignore_ascii_case("https://") {
        return false;
    }
    let rest = &url[8..];
    if rest.bytes().any(|b| b <= 0x20 || b == 0x7f || b == b'\\') {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    !host.is_empty()
        && !host.starts_with(['.', '-'])
        && !host.ends_with(['.', '-'])
        && !host.contains("..")
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// Decide whether to proceed with `input.manifest`. Check order: https ->
/// `min_client_version` -> key selection (embedded + online revocation,
/// active list) -> version monotonicity.
pub fn plan_update(input: &PlanInput<'_>) -> Result<PlanOutcome, Refusal> {
    if !is_https_url(input.manifest_url) || !is_https_url(&input.manifest.artifact_url) {
        return Err(Refusal::InsecureUrl);
    }
    if input.client_version < input.status.min_client_version {
        return Err(Refusal::ClientTooOld);
    }
    let key = input.manifest.signing_key.as_str();
    let slot = if key == input.embedded.current {
        KeySlot::Current
    } else if input.embedded.next.as_deref() == Some(key) {
        KeySlot::Next
    } else {
        return Err(Refusal::UnknownSigningKey);
    };
    if input.embedded.revoked.iter().any(|k| k == key)
        || input.status.revoked_keys.iter().any(|k| k == key)
    {
        return Err(Refusal::RevokedKey);
    }
    if !input.status.active_keys.iter().any(|k| k == key) {
        return Err(Refusal::KeyNotActive);
    }
    let v = input.manifest.version;
    if input.highest_seen.is_some_and(|h| v < h) {
        return Err(Refusal::VersionRollback);
    }
    if v <= input.client_version {
        return Ok(PlanOutcome::UpToDate);
    }
    Ok(PlanOutcome::Update(UpdatePlan {
        target: v,
        artifact_url: input.manifest.artifact_url.clone(),
        key_id: key.to_string(),
        slot,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EP: &str = "https://updates.example.com/stable/latest.json";

    fn keys() -> EmbeddedKeys {
        EmbeddedKeys {
            current: "KA".into(),
            next: Some("KB".into()),
            revoked: vec!["KOLD".into()],
        }
    }

    fn status() -> KeyStatus {
        KeyStatus {
            version: 1,
            issued_at: 0,
            expires_at: 100,
            active_keys: vec!["KA".into(), "KB".into()],
            revoked_keys: vec![],
            min_client_version: Version::new(1, 0, 0),
        }
    }

    fn manifest(v: Version, key: &str) -> UpdateManifest {
        UpdateManifest {
            version: v,
            artifact_url: "https://cdn.example.com/vbk-1.2.0.exe".into(),
            signing_key: key.into(),
        }
    }

    fn run(
        ep: &str,
        m: &UpdateManifest,
        client: Version,
        seen: Option<Version>,
        st: &KeyStatus,
    ) -> Result<PlanOutcome, Refusal> {
        let k = keys();
        plan_update(&PlanInput {
            manifest_url: ep,
            manifest: m,
            client_version: client,
            highest_seen: seen,
            embedded: &k,
            status: st,
        })
    }

    #[test]
    fn https_only() {
        assert!(is_https_url("https://a.example.com/x"));
        assert!(is_https_url("HTTPS://a.example.com:8443/x?y=1"));
        for bad in [
            "http://a.example.com/x",
            "ftp://a.example.com",
            "https://",
            "https:///x",
            "https://user@a.example.com/",
            "https://a.example.com:/x",
            "https://a.example.com:99999x/x",
            "https://a b.com/",
            "https://a.com\\@evil.com/",
            "https://.a.com/",
            "https://a..com/",
            "https://exämple.com/",
            "//a.example.com/",
            "",
            "https",
        ] {
            assert!(!is_https_url(bad), "{bad:?}");
        }
    }

    #[test]
    fn http_manifest_or_artifact_rejected() {
        let m = manifest(Version::new(1, 2, 0), "KA");
        assert_eq!(
            run(
                "http://updates.example.com/l.json",
                &m,
                Version::new(1, 1, 0),
                None,
                &status()
            ),
            Err(Refusal::InsecureUrl)
        );
        let mut m2 = m.clone();
        m2.artifact_url = "http://cdn.example.com/x.exe".into();
        assert_eq!(
            run(EP, &m2, Version::new(1, 1, 0), None, &status()),
            Err(Refusal::InsecureUrl)
        );
    }

    #[test]
    fn newer_version_plans_update_with_slot() {
        for (key, want) in [("KA", KeySlot::Current), ("KB", KeySlot::Next)] {
            let r = run(
                EP,
                &manifest(Version::new(1, 2, 0), key),
                Version::new(1, 1, 0),
                None,
                &status(),
            );
            match r {
                Ok(PlanOutcome::Update(p)) => {
                    assert_eq!(p.slot, want);
                    assert_eq!(p.key_id, key);
                }
                other => panic!("unexpected {other:?}"),
            }
        }
    }

    #[test]
    fn equal_or_older_than_client_is_up_to_date() {
        let c = Version::new(1, 1, 0);
        for v in [c, Version::new(1, 0, 9)] {
            assert_eq!(
                run(EP, &manifest(v, "KA"), c, None, &status()),
                Ok(PlanOutcome::UpToDate)
            );
        }
    }

    #[test]
    fn version_below_highest_seen_is_rollback() {
        assert_eq!(
            run(
                EP,
                &manifest(Version::new(1, 2, 0), "KA"),
                Version::new(1, 1, 0),
                Some(Version::new(1, 3, 0)),
                &status()
            ),
            Err(Refusal::VersionRollback)
        );
    }

    #[test]
    fn min_client_version_blocks_old_clients() {
        let mut s = status();
        s.min_client_version = Version::new(1, 5, 0);
        assert_eq!(
            run(
                EP,
                &manifest(Version::new(2, 0, 0), "KA"),
                Version::new(1, 4, 9),
                None,
                &s
            ),
            Err(Refusal::ClientTooOld)
        );
    }

    #[test]
    fn unknown_revoked_and_inactive_keys() {
        let c = Version::new(1, 1, 0);
        let v = Version::new(1, 2, 0);
        assert_eq!(
            run(EP, &manifest(v, "KX"), c, None, &status()),
            Err(Refusal::UnknownSigningKey)
        );
        // embedded revocation (a rotated-out key still present as `next`)
        let mut k = keys();
        k.next = Some("KOLD".into());
        let r = plan_update(&PlanInput {
            manifest_url: EP,
            manifest: &manifest(v, "KOLD"),
            client_version: c,
            highest_seen: None,
            embedded: &k,
            status: &status(),
        });
        assert_eq!(r, Err(Refusal::RevokedKey));
        // online revocation of the current key
        let mut s = status();
        s.revoked_keys.push("KA".into());
        assert_eq!(
            run(EP, &manifest(v, "KA"), c, None, &s),
            Err(Refusal::RevokedKey)
        );
        // not in the active list
        let mut s = status();
        s.active_keys = vec!["KB".into()];
        assert_eq!(
            run(EP, &manifest(v, "KA"), c, None, &s),
            Err(Refusal::KeyNotActive)
        );
    }

    #[test]
    fn next_key_not_embedded_is_unknown() {
        let mut k = keys();
        k.next = None;
        let r = plan_update(&PlanInput {
            manifest_url: EP,
            manifest: &manifest(Version::new(1, 2, 0), "KB"),
            client_version: Version::new(1, 1, 0),
            highest_seen: None,
            embedded: &k,
            status: &status(),
        });
        assert_eq!(r, Err(Refusal::UnknownSigningKey));
    }
}
