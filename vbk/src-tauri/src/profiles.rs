//! Per-account webview factory (plan D2 / M2-1).
//!
//! Every account (and every login attempt) owns one isolated web profile:
//! * macOS: a `WKWebsiteDataStore` selected by a 16-byte identifier derived
//!   deterministically from the `profile_id` (`data_store_identifier`).
//! * Windows / Linux: a dedicated data directory
//!   `app_data_dir/profiles/<profile_id>`.
//!
//! Cookies live only inside that store; the host never reads or copies them.
//! Remote pages built here never get a capability except the `acct-*`
//! adapter pages (see `capabilities/adapter.json`); the login page and the
//! `webview-*` detail windows get none and no injected script.

use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::views;

/// Height of the local login header (logical px).
pub const LOGIN_HEADER_HEIGHT: f64 = 68.0;
/// Login window inner size (logical px). The official login page is a
/// desktop layout whose form sits right of a hero image (~1200 px wide);
/// at the prototype's 420 px the form is off-screen, so the default is wide
/// enough to show it and the prototype size is the minimum.
pub const LOGIN_WIDTH: f64 = 1240.0;
pub const LOGIN_HEIGHT: f64 = 740.0;
pub const LOGIN_MIN_WIDTH: f64 = 420.0;
pub const LOGIN_MIN_HEIGHT: f64 = 520.0;
/// Label prefix of the remote official login webview (no capability).
pub const LOGIN_REMOTE_PREFIX: &str = "login-remote-";
/// Label prefix of visible official detail windows (no capability, no
/// script). Must not start with `acct-` so the adapter ACL never matches.
pub const VIEW_LABEL_PREFIX: &str = "webview-";

/// Official IM page loaded in every hidden account webview.
pub const ACCOUNT_IM_URL: &str = "https://vbooking.ctrip.com/vbk/im/main";
/// Path prefix of the official login page.
pub const LOGIN_PATH_PREFIX: &str = "/ivbk/accountV2/login";
/// Path prefix of the official account pages (login, register, password
/// reset, verification). Navigation inside it never counts as "logged in".
pub const ACCOUNT_PAGES_PREFIX: &str = "/ivbk/accountV2/";

pub fn account_label(profile_id: &str) -> String {
    format!("{}{profile_id}", views::ACCOUNT_WEBVIEW_PREFIX)
}

pub fn login_remote_label(attempt_id: &str) -> String {
    format!("{LOGIN_REMOTE_PREFIX}{attempt_id}")
}

pub fn view_label(seq: u64) -> String {
    format!("{VIEW_LABEL_PREFIX}{seq}")
}

/// Stable 16-byte data store identifier for a profile (two FNV-1a 64-bit
/// lanes with different offsets, formatted as an RFC 4122 v8 UUID).
pub fn data_store_id(profile_id: &str) -> [u8; 16] {
    fn fnv1a(seed: u64, data: &[u8]) -> u64 {
        let mut h = seed;
        for b in data {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h
    }
    let input = format!("vbk-profile:{profile_id}");
    let a = fnv1a(0xcbf2_9ce4_8422_2325, input.as_bytes());
    let b = fnv1a(0x6c62_272e_07bb_0142, input.as_bytes());
    let mut out = [0u8; 16];
    out[..8].copy_from_slice(&a.to_be_bytes());
    out[8..].copy_from_slice(&b.to_be_bytes());
    out[6] = (out[6] & 0x0f) | 0x80; // version 8
    out[8] = (out[8] & 0x3f) | 0x80; // RFC 4122 variant
    out
}

/// Data directory of a profile (used on Windows / Linux; on macOS only for
/// cleanup of anything WebKit may have put there).
pub fn data_dir(app: &AppHandle, profile_id: &str) -> Option<PathBuf> {
    let base = app.path().app_data_dir().ok()?;
    Some(base.join("profiles").join(profile_id))
}

/// Whether a remote webview may navigate to `url`. Only secure web URLs (and
/// the inert about/blob/data schemes used inside official pages); never
/// the app's own `tauri:` / `ipc:` origins or `file:`.
pub fn allowed_navigation(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "about" | "blob" | "data")
}

fn is_vbooking(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(core_net::url::IM_HOST_VBOOKING)
}

/// The official login page (an account webview landing here means the web
/// session is gone).
pub fn is_login_page(url: &Url) -> bool {
    is_vbooking(url) && url.path().starts_with(LOGIN_PATH_PREFIX)
}

/// D6 candidate success: the login webview left the official account pages
/// for another vbooking page (the portal redirects there after login).
pub fn is_login_complete_candidate(url: &Url) -> bool {
    is_vbooking(url) && !url.path().starts_with(ACCOUNT_PAGES_PREFIX)
}

/// Official URLs that `shell_open_webview` may open inside an account
/// profile: order detail and notice links on the two official hosts.
pub fn is_openable_official_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(
            url.host_str(),
            Some(core_net::url::IM_HOST_VBOOKING) | Some(core_net::url::IM_HOST_IMVENDOR)
        )
}

/// Applies the profile isolation to any builder that exposes the two wry
/// knobs (`WebviewBuilder` and `WebviewWindowBuilder` both do).
macro_rules! isolate {
    ($builder:expr, $app:expr, $profile:expr) => {{
        let b = $builder;
        #[cfg(target_os = "macos")]
        let b = {
            let _ = $app;
            b.data_store_identifier(crate::login::profiles::data_store_id($profile))
        };
        #[cfg(not(target_os = "macos"))]
        let b = match crate::login::profiles::data_dir($app, $profile) {
            Some(dir) => b.data_directory(dir),
            None => b,
        };
        b
    }};
}
pub(crate) use isolate;

/// Options of a top-level window that runs inside an account profile.
pub struct ProfileWindow<'a> {
    pub label: &'a str,
    pub profile_id: &'a str,
    pub url: Url,
    pub title: &'a str,
    pub visible: bool,
    /// Only the `acct-*` adapter pages get the boot script.
    pub init_script: Option<String>,
}

/// Builds a top-level webview window in the profile. `on_nav` sees every
/// navigation that passed [`allowed_navigation`].
pub fn open_profile_window<F>(
    app: &AppHandle,
    opts: ProfileWindow<'_>,
    on_nav: F,
) -> tauri::Result<WebviewWindow>
where
    F: Fn(&Url) + Send + 'static,
{
    let mut b = WebviewWindowBuilder::new(app, opts.label, WebviewUrl::External(opts.url))
        .title(opts.title)
        .inner_size(1200.0, 800.0)
        .visible(opts.visible)
        .focused(opts.visible)
        .on_navigation(move |url| {
            if !allowed_navigation(url) {
                return false;
            }
            on_nav(url);
            true
        });
    if !opts.visible {
        b = b.skip_taskbar(true);
    }
    if let Some(script) = opts.init_script.filter(|s| !s.is_empty()) {
        b = b.initialization_script(script);
    }
    let b = isolate!(b, app, opts.profile_id);
    b.build()
}

/// Closes (destroys) a webview window if it exists.
pub fn destroy_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.destroy();
    }
}

/// Deletes a profile's web data after its webviews are gone. Runs in the
/// background: WebKit / WebView2 release the store asynchronously after a
/// webview is destroyed.
pub fn remove_profile_data(app: &AppHandle, profile_id: &str) {
    let app = app.clone();
    let profile_id = profile_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        #[cfg(target_os = "macos")]
        {
            match app.remove_data_store(data_store_id(&profile_id)).await {
                Ok(()) => log::info!("profile {profile_id}: data store removed"),
                Err(e) => log::warn!("profile {profile_id}: data store not removed: {e}"),
            }
        }
        if let Some(dir) = data_dir(&app, &profile_id) {
            if dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(&dir) {
                    log::warn!("profile {profile_id}: data directory not removed: {e}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_store_id_is_stable_and_distinct() {
        let a = data_store_id("p_0123456789abcdef");
        assert_eq!(a, data_store_id("p_0123456789abcdef"));
        assert_ne!(a, data_store_id("p_0123456789abcdee"));
        assert_eq!(a[6] >> 4, 8);
    }

    #[test]
    fn login_detection() {
        let u = |s: &str| Url::parse(s).expect("url");
        assert!(is_login_page(&u(core_net::url::LOGIN_PAGE_URL)));
        assert!(!is_login_complete_candidate(&u(
            core_net::url::LOGIN_PAGE_URL
        )));
        assert!(!is_login_complete_candidate(&u(
            "https://vbooking.ctrip.com/ivbk/accountV2/forgetPassword"
        )));
        assert!(is_login_complete_candidate(&u(
            "https://vbooking.ctrip.com/ivbk/home"
        )));
        assert!(!is_login_complete_candidate(&u(
            "https://passport.ctrip.com/x"
        )));
        assert!(!allowed_navigation(&u(
            "tauri://localhost/apps/main/index.html"
        )));
        assert!(!allowed_navigation(&u("http://vbooking.ctrip.com/")));
    }

    #[test]
    fn openable_urls() {
        let u = |s: &str| Url::parse(s).expect("url");
        assert!(is_openable_official_url(&u(
            "https://vbooking.ctrip.com/ticket_order/order/detail?orderId=1"
        )));
        assert!(is_openable_official_url(&u(
            "https://imvendor.ctrip.com/main"
        )));
        assert!(!is_openable_official_url(&u("https://evil.example.com/")));
        assert!(!is_openable_official_url(&u(
            "https://vbooking.ctrip.com.evil.com/"
        )));
        assert!(!is_openable_official_url(&u(
            "https://a:b@vbooking.ctrip.com/"
        )));
        assert!(!is_openable_official_url(&u("http://vbooking.ctrip.com/")));
    }
}
