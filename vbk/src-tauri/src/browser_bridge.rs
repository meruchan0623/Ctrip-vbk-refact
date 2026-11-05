//! Explicit browser consent -> one pending login attempt. Never persists cookies.
use contracts::AppError;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::webview::{
    cookie::{time::OffsetDateTime, SameSite},
    Cookie,
};

const MAX: usize = 128 * 1024;
const TTL: Duration = Duration::from_secs(120);
const EXTENSION: &str = "dhfnfakligkclahdpejdeoocanjbmkco";
static STATE: OnceLock<Mutex<Bridge>> = OnceLock::new();
fn state() -> &'static Mutex<Bridge> {
    STATE.get_or_init(|| Mutex::new(Bridge::default()))
}
fn error() -> AppError {
    AppError::new(
        "account.browser_bridge",
        "请在 Chrome 或 Edge 的 VBK 连接扩展中授权，再刷新账号列表。",
    )
}
#[derive(Default)]
struct Bridge {
    started: bool,
    pending: Option<Pending>,
    offers: HashMap<String, Offer>,
}
struct Pending {
    attempt: String,
    challenge: String,
    created: Instant,
}
struct Offer {
    source: String,
    label: String,
    cookies: Vec<WireCookie>,
    created: Instant,
}
#[derive(Serialize)]
pub struct Choice {
    pub id: String,
    pub label: String,
}
#[derive(Serialize, Deserialize)]
struct Rendezvous {
    port: u16,
    secret: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    secret: String,
    extension: String,
    action: String,
    #[serde(default)]
    source_id: String,
    #[serde(default)]
    challenge: String,
    #[serde(default)]
    browser: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    cookies: Vec<WireCookie>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireCookie {
    domain: String,
    name: String,
    value: String,
    path: String,
    secure: bool,
    http_only: bool,
    host_only: bool,
    same_site: String,
    expiration: Option<i64>,
}
fn rendezvous_path() -> Result<PathBuf, AppError> {
    #[cfg(target_os = "windows")]
    let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or_else(error)?).join("VBK");
    #[cfg(not(target_os = "windows"))]
    let root = PathBuf::from(std::env::var_os("HOME").ok_or_else(error)?)
        .join("Library/Application Support/VBK");
    Ok(root.join("browser-bridge/session.json"))
}
fn prepare(path: &std::path::Path) -> Result<(), AppError> {
    let dir = path.parent().ok_or_else(error)?;
    fs::create_dir_all(dir).map_err(|_| error())?;
    if fs::symlink_metadata(dir)
        .map_err(|_| error())?
        .file_type()
        .is_symlink()
    {
        return Err(error());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|_| error())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // User-private ACL even if LOCALAPPDATA inherited a permissive ACL.
        // Granted by SID: whoami prints account names in the OEM code page.
        let who = std::process::Command::new("whoami")
            .args(["/user", "/fo", "csv", "/nh"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|_| error())?;
        if !who.status.success() {
            return Err(error());
        }
        let sid = sid_from_whoami(&who.stdout).ok_or_else(error)?;
        let status = std::process::Command::new("icacls")
            .arg(dir)
            .args(["/inheritance:r", "/grant:r", &format!("*{sid}:(OI)(CI)F")])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|_| error())?;
        if !status.status.success() {
            return Err(error());
        }
    }
    Ok(())
}
/// The SID from `whoami /user /fo csv /nh`, whose name column may not be UTF-8.
#[cfg(any(target_os = "windows", test))]
fn sid_from_whoami(stdout: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stdout);
    let sid = text[text.rfind("S-1-")?..].split('"').next()?.trim();
    let valid = sid.len() > 4 && sid[4..].bytes().all(|b| b.is_ascii_digit() || b == b'-');
    valid.then(|| sid.to_string())
}
/// Call once at app setup (or lazily from begin). No cookies are written here.
pub fn start() -> Result<(), AppError> {
    let mut guard = state().lock().map_err(|_| error())?;
    if guard.started {
        return Ok(());
    }
    let path = rendezvous_path()?;
    prepare(&path)?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|_| error())?;
    listener.set_nonblocking(true).map_err(|_| error())?;
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let data = serde_json::to_vec(&Rendezvous {
        port: listener.local_addr().map_err(|_| error())?.port(),
        secret: secret.clone(),
    })
    .map_err(|_| error())?;
    // New inode, mode 0600; refuse a pre-existing symlink. A stale file is safe to replace.
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            return Err(error());
        }
        fs::remove_file(&path).map_err(|_| error())?;
    }
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(&path)
        .and_then(|mut f| f.write_all(&data))
        .map_err(|_| error())?;
    std::thread::Builder::new()
        .name("browser-bridge".into())
        .spawn(move || loop {
            if let Ok(mut s) = state().lock() {
                fresh(&mut s);
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = serve(stream, &secret);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                Err(_) => break,
            }
        })
        .map_err(|_| error())?;
    guard.started = true;
    Ok(())
}
pub fn begin(attempt: &str) -> Result<(), AppError> {
    start()?;
    let mut s = state().lock().map_err(|_| error())?;
    if s.pending
        .as_ref()
        .is_some_and(|p| p.attempt == attempt && p.created.elapsed() < TTL)
    {
        return Ok(());
    }
    s.offers.clear();
    s.pending = Some(Pending {
        attempt: attempt.into(),
        challenge: uuid::Uuid::new_v4().to_string(),
        created: Instant::now(),
    });
    Ok(())
}
pub fn cancel(attempt: &str) {
    if let Ok(mut s) = state().lock() {
        if s.pending.as_ref().is_some_and(|p| p.attempt == attempt) {
            s.pending = None;
            s.offers.clear();
        }
    }
}
fn fresh(s: &mut Bridge) -> bool {
    if s.pending
        .as_ref()
        .map_or(true, |p| p.created.elapsed() >= TTL)
    {
        s.pending = None;
        s.offers.clear();
        return false;
    }
    s.offers.retain(|_, o| o.created.elapsed() < TTL);
    true
}
pub fn choices() -> Result<Vec<Choice>, AppError> {
    let mut s = state().lock().map_err(|_| error())?;
    if !fresh(&mut s) {
        return Ok(Vec::new());
    }
    let mut choices = s
        .offers
        .iter()
        .map(|(id, o)| Choice {
            id: id.clone(),
            label: if s
                .offers
                .values()
                .filter(|other| other.label == o.label)
                .count()
                > 1
            {
                format!("{} · {}", o.label, &o.source[..4])
            } else {
                o.label.clone()
            },
        })
        .collect::<Vec<_>>();
    choices.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(choices)
}
pub fn read(id: &str) -> Result<Vec<Cookie<'static>>, AppError> {
    let mut s = state().lock().map_err(|_| error())?;
    if !fresh(&mut s) {
        return Err(error());
    }
    let offer = s.offers.remove(id).ok_or_else(error)?;
    validate_cookies(&offer.cookies)?;
    offer
        .cookies
        .into_iter()
        .map(|c| {
            let mut cookie = Cookie::new(c.name, c.value);
            cookie.set_domain(c.domain);
            cookie.set_path(c.path);
            cookie.set_secure(true);
            cookie.set_http_only(c.http_only);
            cookie.set_same_site(match c.same_site.as_str() {
                "no_restriction" => SameSite::None,
                "strict" => SameSite::Strict,
                _ => SameSite::Lax,
            });
            if let Some(t) = c.expiration {
                cookie.set_expires(OffsetDateTime::from_unix_timestamp(t).map_err(|_| error())?);
            }
            Ok(cookie)
        })
        .collect()
}
fn validate_cookies(cookies: &[WireCookie]) -> Result<(), AppError> {
    if cookies.is_empty() || cookies.len() > 6 {
        return Err(error());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| error())?
        .as_secs() as i64;
    let mut seen = HashSet::new();
    for c in cookies {
        let domain_ok = c.domain == ".ctrip.com" && !c.host_only
            || c.domain == "vbooking.ctrip.com" && c.host_only;
        if !domain_ok
            || !matches!(c.name.as_str(), "bticket" | "vbkticket" | "BDUID")
            || c.path != "/"
            || !c.secure
            || c.value.is_empty()
            || c.value.len() > 16384
            || !c
                .value
                .bytes()
                .all(|b| (0x21..=0x7e).contains(&b) && b != b';')
            || c.expiration.is_some_and(|t| t <= now)
            || !matches!(
                c.same_site.as_str(),
                "no_restriction" | "lax" | "strict" | "unspecified"
            )
            || !seen.insert((&c.domain, &c.name))
        {
            return Err(error());
        }
    }
    if !cookies.iter().any(|c| c.name == "bticket") {
        return Err(error());
    }
    Ok(())
}
fn read_frame(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut len = [0; 4];
    stream.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 || len > MAX {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut bytes = vec![0; len];
    stream.read_exact(&mut bytes)?;
    Ok(bytes)
}
fn serve(mut stream: TcpStream, secret: &str) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let bytes = read_frame(&mut stream)?;
    let result = serde_json::from_slice::<Request>(&bytes)
        .ok()
        .and_then(|r| handle(r, secret).ok());
    let reply=serde_json::to_vec(&result.unwrap_or_else(||serde_json::json!({"ok":false,"message":"连接请求无效、已过期或客户端未打开添加账号窗口。"})))?;
    stream.write_all(&(reply.len() as u32).to_le_bytes())?;
    stream.write_all(&reply)
}
fn handle(r: Request, secret: &str) -> Result<serde_json::Value, AppError> {
    if r.secret != secret || r.extension != EXTENSION {
        return Err(error());
    }
    let mut s = state().lock().map_err(|_| error())?;
    if !fresh(&mut s) {
        return Err(error());
    }
    if r.action == "status" {
        return Ok(
            serde_json::json!({"ok":true,"challenge":s.pending.as_ref().unwrap().challenge}),
        );
    }
    if r.action != "offer"
        || r.challenge != s.pending.as_ref().unwrap().challenge
        || !matches!(r.browser.as_str(), "Chrome" | "Edge")
        || uuid::Uuid::parse_str(&r.source_id).is_err()
        || r.label.chars().count() > 40
        || r.label.chars().any(char::is_control)
        || s.offers.len() >= 16
    {
        return Err(error());
    }
    validate_cookies(&r.cookies)?;
    let id = uuid::Uuid::new_v4().to_string();
    let label = format!(
        "{} · {}",
        r.browser,
        if r.label.trim().is_empty() {
            "当前配置"
        } else {
            r.label.trim()
        }
    );
    // Replace same user-labelled source instead of accumulating duplicates.
    s.offers.retain(|_, o| o.source != r.source_id);
    s.offers.insert(
        id,
        Offer {
            source: r.source_id,
            label,
            cookies: r.cookies,
            created: Instant::now(),
        },
    );
    Ok(serde_json::json!({"ok":true,"message":"已授权，请回客户端刷新并选择该浏览器账号。"}))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> WireCookie {
        WireCookie {
            domain: ".ctrip.com".into(),
            name: "bticket".into(),
            value: "synthetic-ticket".into(),
            path: "/".into(),
            secure: true,
            http_only: true,
            host_only: false,
            same_site: "lax".into(),
            expiration: None,
        }
    }
    #[test]
    fn rejects_cookie_scope_and_expiry() {
        let mut c = fixture();
        assert!(validate_cookies(&[c.clone()]).is_ok());
        c.domain = "evil.ctrip.com".into();
        assert!(validate_cookies(&[c.clone()]).is_err());
        c = fixture();
        c.host_only = true;
        assert!(validate_cookies(&[c.clone()]).is_err());
        c = fixture();
        c.expiration = Some(1);
        assert!(validate_cookies(&[c.clone()]).is_err());
        c = fixture();
        c.value = "x;secret".into();
        assert!(validate_cookies(&[c]).is_err());
    }
    #[test]
    fn rejects_duplicate_and_missing_ticket() {
        assert!(validate_cookies(&[fixture(), fixture()]).is_err());
        let mut c = fixture();
        c.name = "BDUID".into();
        assert!(validate_cookies(&[c]).is_err());
    }
    #[test]
    fn expiry_removes_all_credentials() {
        let mut s = Bridge {
            pending: Some(Pending {
                attempt: "a".into(),
                challenge: "b".into(),
                created: Instant::now() - TTL,
            }),
            ..Default::default()
        };
        s.offers.insert(
            "id".into(),
            Offer {
                source: "test".into(),
                label: "x".into(),
                cookies: vec![fixture()],
                created: Instant::now(),
            },
        );
        assert!(!fresh(&mut s));
        assert!(s.offers.is_empty());
        assert!(s.pending.is_none());
    }
    #[test]
    fn rejects_wrong_auth_before_touching_state() {
        let r = Request {
            secret: "wrong".into(),
            extension: EXTENSION.into(),
            action: "status".into(),
            source_id: String::new(),
            challenge: String::new(),
            browser: String::new(),
            label: String::new(),
            cookies: vec![],
        };
        assert!(handle(r, "correct").is_err());
    }
    #[test]
    fn offers_are_scoped_distinct_one_use_and_cancelled() {
        let attempt = "bridge-test-attempt";
        {
            let mut s = state().lock().unwrap();
            s.pending = Some(Pending {
                attempt: attempt.into(),
                challenge: "challenge-a".into(),
                created: Instant::now(),
            });
            s.offers.clear();
        }
        let request = |challenge: &str, source: &str| Request {
            secret: "test-secret".into(),
            extension: EXTENSION.into(),
            action: "offer".into(),
            source_id: source.into(),
            challenge: challenge.into(),
            browser: "Chrome".into(),
            label: "当前配置".into(),
            cookies: vec![fixture()],
        };
        let source1 = "11111111-1111-4111-8111-111111111111".to_string();
        let source2 = "22222222-2222-4222-8222-222222222222".to_string();
        assert!(handle(request("wrong-challenge", &source1), "test-secret").is_err());
        assert!(handle(request("challenge-a", &source1), "test-secret").is_ok());
        assert!(handle(request("challenge-a", &source2), "test-secret").is_ok());
        let choices = choices().unwrap();
        assert_eq!(choices.len(), 2);
        assert_ne!(choices[0].label, choices[1].label);
        let imported = read(&choices[0].id).unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].name(), "bticket");
        assert!(read(&choices[0].id).is_err());
        {
            let mut s = state().lock().unwrap();
            s.pending.as_mut().unwrap().challenge = "challenge-b".into();
        }
        assert!(handle(request("challenge-a", &source1), "test-secret").is_err());
        {
            let mut s = state().lock().unwrap();
            s.pending.as_mut().unwrap().created = Instant::now() - TTL;
        }
        cancel(attempt);
        let s = state().lock().unwrap();
        assert!(s.pending.is_none());
        assert!(s.offers.is_empty());
    }
    #[test]
    fn sid_is_read_from_whoami_csv_even_when_the_name_is_not_utf8() {
        let mut gbk_name = b"\"host\\".to_vec();
        gbk_name.extend([0xd5, 0xc5, 0xc8, 0xfd]);
        gbk_name.extend(b"\",\"S-1-5-21-100-200-1001\"\r\n");
        assert_eq!(
            sid_from_whoami(&gbk_name).as_deref(),
            Some("S-1-5-21-100-200-1001")
        );
        assert_eq!(sid_from_whoami(b"\"host\\name\",\"S-1-x\"\r\n"), None);
        assert_eq!(sid_from_whoami(b""), None);
    }
}
