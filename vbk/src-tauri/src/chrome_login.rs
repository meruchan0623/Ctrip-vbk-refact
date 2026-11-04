//! Import only the observed Ctrip authentication cookies from macOS Chrome.
//! Values never cross IPC. Chrome owns the source session; official IM must
//! still publish a verified identity before this becomes a logged-in account.
use contracts::AppError;
use serde::Serialize;

fn unavailable() -> AppError {
    AppError::new(
        "account.browser_unavailable",
        "无法读取 Chrome 携程登录态，请检查系统授权，或使用下方官方登录页。",
    )
}

#[derive(Serialize)]
pub struct Choice {
    pub id: String,
    pub label: String,
}

pub fn choices() -> Result<Vec<Choice>, AppError> {
    #[cfg(target_os = "macos")]
    {
        mac::profiles().map(|items| {
            items
                .into_iter()
                .map(|(name, _)| Choice {
                    label: format!("Chrome · {name}"),
                    id: name,
                })
                .collect()
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}

pub fn read(profile: &str) -> Result<Vec<tauri::webview::Cookie<'static>>, AppError> {
    #[cfg(target_os = "macos")]
    {
        mac::read(profile)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = profile;
        Err(unavailable())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    use rusqlite::{Connection, OpenFlags};
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tauri::webview::{
        cookie::{time::OffsetDateTime, SameSite},
        Cookie,
    };
    use zeroize::Zeroizing;

    fn valid_profile(name: &str) -> bool {
        name == "Default"
            || name.strip_prefix("Profile ").is_some_and(|s| {
                !s.is_empty() && s.len() <= 10 && s.bytes().all(|b| b.is_ascii_digit())
            })
    }
    fn safe(path: &Path) -> Result<(), AppError> {
        if !path.is_absolute() {
            return Err(unavailable());
        }
        for item in path.ancestors() {
            let meta = fs::symlink_metadata(item).map_err(|_| unavailable())?;
            if meta.file_type().is_symlink() {
                return Err(unavailable());
            }
        }
        Ok(())
    }
    pub(super) fn profiles() -> Result<Vec<(String, PathBuf)>, AppError> {
        let root = PathBuf::from(std::env::var_os("HOME").ok_or_else(unavailable)?)
            .join("Library/Application Support/Google/Chrome");
        if !root.exists() {
            return Ok(Vec::new());
        }
        safe(&root)?;
        let mut result = Vec::new();
        for item in fs::read_dir(&root).map_err(|_| unavailable())? {
            let item = item.map_err(|_| unavailable())?;
            let name = item.file_name().to_string_lossy().into_owned();
            if !valid_profile(&name) {
                continue;
            }
            safe(&item.path())?;
            // Current Chrome uses Cookies on macOS; Network/Cookies is also
            // accepted for releases that use the cross-platform layout.
            let paths = [
                item.path().join("Network/Cookies"),
                item.path().join("Cookies"),
            ];
            if let Some(path) = paths.into_iter().find(|path| path.is_file()) {
                safe(&path)?;
                result.push((name, path));
                if result.len() > 64 {
                    return Err(unavailable());
                }
            }
        }
        result.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(result)
    }
    fn decrypt(bytes: &[u8], host: &str, version: i64, key: &[u8; 16]) -> Result<String, AppError> {
        let payload = bytes.strip_prefix(b"v10").ok_or_else(unavailable)?;
        let clear = Zeroizing::new(
            cbc::Decryptor::<aes::Aes128>::new(key.into(), (&[b' '; 16]).into())
                .decrypt_padded_vec_mut::<Pkcs7>(payload)
                .map_err(|_| unavailable())?,
        );
        let value = if version >= 24 {
            let hash = Sha256::digest(host.as_bytes());
            if clear.len() < 32 || clear[..32] != hash[..] {
                return Err(unavailable());
            }
            &clear[32..]
        } else {
            &clear[..]
        };
        if value.is_empty()
            || value.len() > 16384
            || !value
                .iter()
                .all(|b| (0x21..=0x7e).contains(b) && *b != b';')
        {
            return Err(unavailable());
        }
        String::from_utf8(value.to_vec()).map_err(|_| unavailable())
    }
    pub(super) fn read(profile: &str) -> Result<Vec<Cookie<'static>>, AppError> {
        let path = profiles()?
            .into_iter()
            .find(|(name, _)| name == profile)
            .map(|(_, path)| path)
            .ok_or_else(unavailable)?;
        if fs::metadata(&path).map_err(|_| unavailable())?.len() > 128 * 1024 * 1024 {
            return Err(unavailable());
        }
        let db = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| unavailable())?;
        read_database(db, || {
            security_framework::passwords::get_generic_password("Chrome Safe Storage", "Chrome")
                .map_err(|_| unavailable())
        })
    }
    fn read_database(
        db: Connection,
        mut password: impl FnMut() -> Result<Vec<u8>, AppError>,
    ) -> Result<Vec<Cookie<'static>>, AppError> {
        db.busy_timeout(Duration::from_millis(500))
            .map_err(|_| unavailable())?;
        db.execute_batch("PRAGMA query_only = ON; BEGIN DEFERRED")
            .map_err(|_| unavailable())?;
        let version: i64 = db
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'version'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| unavailable())?;
        if !(20..=24).contains(&version) {
            return Err(unavailable());
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| unavailable())?
            .as_secs() as i64;
        let chrome_now = (now + 11644473600) * 1_000_000;
        let mut stmt = db.prepare("SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE host_key IN ('.ctrip.com','vbooking.ctrip.com') AND name IN ('bticket','vbkticket','BDUID') AND path = '/' AND (expires_utc = 0 OR expires_utc > ?1) AND top_frame_site_key = '' LIMIT 65").map_err(|_|unavailable())?;
        let mut rows = stmt.query([chrome_now]).map_err(|_| unavailable())?;
        // Do not access the Keychain until an eligible cookie actually exists.
        let mut key: Option<Zeroizing<[u8; 16]>> = None;
        let mut output = Vec::new();
        while let Some(row) = rows.next().map_err(|_| unavailable())? {
            if output.len() == 64 {
                return Err(unavailable());
            }
            if key.is_none() {
                let secret = Zeroizing::new(password()?);
                let mut derived = Zeroizing::new([0; 16]);
                pbkdf2::pbkdf2_hmac::<sha1::Sha1>(&secret, b"saltysalt", 1003, &mut *derived);
                key = Some(derived);
            }
            let host: String = row.get(0).map_err(|_| unavailable())?;
            let name: String = row.get(1).map_err(|_| unavailable())?;
            let encrypted: Vec<u8> = row.get(2).map_err(|_| unavailable())?;
            let value = decrypt(&encrypted, &host, version, key.as_ref().unwrap())?;
            let secure: bool = row.get(5).map_err(|_| unavailable())?;
            if !secure {
                return Err(unavailable());
            }
            let mut item = Cookie::new(name, value);
            item.set_domain(host);
            item.set_path("/");
            item.set_secure(true);
            item.set_http_only(row.get::<_, bool>(6).map_err(|_| unavailable())?);
            item.set_same_site(match row.get::<_, i32>(7).map_err(|_| unavailable())? {
                0 => SameSite::None,
                1 => SameSite::Lax,
                2 => SameSite::Strict,
                _ => SameSite::Lax,
            });
            let expires: i64 = row.get(4).map_err(|_| unavailable())?;
            if expires != 0 {
                item.set_expires(
                    OffsetDateTime::from_unix_timestamp(expires / 1_000_000 - 11644473600)
                        .map_err(|_| unavailable())?,
                );
            }
            output.push(item);
        }
        if !output.iter().any(|c| c.name() == "bticket") {
            return Err(AppError::new(
                "account.browser_no_session",
                "此 Chrome 配置中没有可用的携程登录态，请先在 Chrome 登录或使用下方官方登录页。",
            ));
        }
        Ok(output)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use aes::cipher::BlockEncryptMut;
        #[test]
        fn profile_names_cannot_escape_root() {
            for name in ["Default", "Profile 2"] {
                assert!(valid_profile(name));
            }
            for name in ["../Default", "Profile ../1", "Guest Profile", "Profile "] {
                assert!(!valid_profile(name));
            }
        }
        #[test]
        fn decrypt_checks_domain_version_padding_and_scheme() {
            let key = [7; 16];
            let mut clear = Sha256::digest(b".ctrip.com").to_vec();
            clear.extend_from_slice(b"synthetic-ticket");
            let mut encrypted = b"v10".to_vec();
            encrypted.extend(
                cbc::Encryptor::<aes::Aes128>::new((&key).into(), (&[b' '; 16]).into())
                    .encrypt_padded_vec_mut::<Pkcs7>(&clear),
            );
            assert_eq!(
                decrypt(&encrypted, ".ctrip.com", 24, &key).unwrap(),
                "synthetic-ticket"
            );
            assert!(decrypt(&encrypted, "evil.test", 24, &key).is_err());
            assert!(decrypt(&encrypted, ".ctrip.com", 24, &[0; 16]).is_err());
            encrypted[2] = b'1';
            assert!(decrypt(&encrypted, ".ctrip.com", 24, &key).is_err());
        }
        fn fixture() -> Connection {
            let db = Connection::open_in_memory().unwrap();
            db.execute_batch("CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT);").unwrap();
            db
        }
        #[test]
        fn ignores_unrelated_expired_partitioned_sessions_without_keychain_access() {
            let db = fixture();
            db.execute_batch("INSERT INTO cookies VALUES('.other.test','bticket',X'00','/',0,1,1,0,''); INSERT INTO cookies VALUES('.ctrip.com','tracking',X'00','/',0,1,1,0,''); INSERT INTO cookies VALUES('.ctrip.com','bticket',X'00','/',1,1,1,0,''); INSERT INTO cookies VALUES('.ctrip.com','bticket',X'00','/',0,1,1,0,'https://other.test');").unwrap();
            let result = read_database(db, || panic!("must not ask for Chrome key"));
            assert_eq!(result.unwrap_err().code, "account.browser_no_session");
        }
        #[test]
        fn text_schema_version_and_synthetic_cookie_round_trip() {
            let db = fixture();
            let mut key = [0; 16];
            pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"test-password", b"saltysalt", 1003, &mut key);
            let mut clear = Sha256::digest(b".ctrip.com").to_vec();
            clear.extend_from_slice(b"synthetic-ticket");
            let mut encrypted = b"v10".to_vec();
            encrypted.extend(
                cbc::Encryptor::<aes::Aes128>::new((&key).into(), (&[b' '; 16]).into())
                    .encrypt_padded_vec_mut::<Pkcs7>(&clear),
            );
            db.execute(
                "INSERT INTO cookies VALUES('.ctrip.com','bticket',?1,'/',0,1,1,0,'')",
                [encrypted],
            )
            .unwrap();
            let result = read_database(db, || Ok(b"test-password".to_vec())).unwrap();
            assert_eq!(result.len(), 1);
            assert_eq!(result[0].value(), "synthetic-ticket");
            assert_eq!(result[0].secure(), Some(true));
            assert_eq!(result[0].http_only(), Some(true));
            assert_eq!(result[0].same_site(), Some(SameSite::None));
        }
    }
}
