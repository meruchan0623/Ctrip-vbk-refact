//! Ctrip-only import into the attempt's isolated WK cookie store. Wry's cookie
//! conversion strips a leading domain dot, so use native cookies here. Every
//! operation completes asynchronously on the main run loop; no UI-thread waits.
use contracts::AppError;
use tauri::webview::Cookie;

fn failed() -> AppError {
    AppError::new(
        "account.browser_cookie_failed",
        "无法应用浏览器登录态，请使用官方登录页。",
    )
}

pub async fn apply(remote: tauri::Webview, items: Vec<Cookie<'static>>) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        mac::apply(remote, items).await
    }
    #[cfg(target_os = "windows")]
    {
        win::apply(remote, items).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (remote, items);
        Err(failed())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use block2::RcBlock;
    use objc2::{rc::Retained, runtime::AnyObject};
    use objc2_foundation::{
        ns_string, NSArray, NSDate, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieExpires,
        NSHTTPCookieName, NSHTTPCookiePath, NSHTTPCookiePropertyKey, NSHTTPCookieSecure,
        NSHTTPCookieValue, NSMutableDictionary, NSString,
    };
    use objc2_web_kit::{WKHTTPCookieStore, WKWebView};
    use std::{
        cell::RefCell,
        ptr::NonNull,
        rc::Rc,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tauri::webview::cookie::SameSite;
    use tokio::sync::oneshot;

    struct CancelOnDrop(Arc<AtomicBool>);
    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }

    struct Operation {
        store: Retained<WKHTTPCookieStore>,
        expected: Vec<Retained<NSHTTPCookie>>,
        completion: RefCell<Option<oneshot::Sender<Result<(), AppError>>>>,
        active: Arc<AtomicBool>,
    }
    impl Operation {
        fn running(&self) -> bool {
            self.active.load(Ordering::Acquire)
                && self
                    .completion
                    .borrow()
                    .as_ref()
                    .is_some_and(|tx| !tx.is_closed())
        }
        fn finish(&self, result: Result<(), AppError>) {
            self.active.store(false, Ordering::Release);
            if let Some(tx) = self.completion.borrow_mut().take() {
                let _ = tx.send(result);
            }
        }
    }

    fn managed(cookie: &NSHTTPCookie) -> bool {
        let name = cookie.name().to_string();
        let domain = cookie.domain().to_string();
        let domain = domain.strip_prefix('.').unwrap_or(&domain);
        matches!(name.as_str(), "bticket" | "vbkticket" | "BDUID")
            && (domain == "ctrip.com" || domain.ends_with(".ctrip.com"))
    }

    fn native_cookie(item: &Cookie<'_>) -> Result<Retained<NSHTTPCookie>, AppError> {
        // The reader only accepts original .ctrip.com or host-only vbooking.
        // Cookie::domain() normalizes away the dot; reconstruct it only for the
        // former, whose host-only form is excluded by the reader's SQL.
        let domain = match item.domain() {
            Some("ctrip.com") => ".ctrip.com",
            Some("vbooking.ctrip.com") => "vbooking.ctrip.com",
            _ => return Err(failed()),
        };
        if !matches!(item.name(), "bticket" | "vbkticket" | "BDUID")
            || item.path() != Some("/")
            || item.secure() != Some(true)
            || item.value().is_empty()
            || item.value().len() > 16384
            || !item
                .value()
                .bytes()
                .all(|b| (0x21..=0x7e).contains(&b) && b != b';')
        {
            return Err(failed());
        }
        let name = NSString::from_str(item.name());
        let value = NSString::from_str(item.value());
        let domain = NSString::from_str(domain);
        // This dictionary never reaches IPC, logging, or file persistence.
        let properties: Retained<NSMutableDictionary<NSHTTPCookiePropertyKey, AnyObject>> = unsafe {
            NSMutableDictionary::from_slices(
                &[
                    NSHTTPCookieName,
                    NSHTTPCookieValue,
                    NSHTTPCookieDomain,
                    NSHTTPCookiePath,
                    NSHTTPCookieSecure,
                ],
                &[&name, &value, &domain, ns_string!("/"), ns_string!("TRUE")],
            )
        };
        // Foundation treats a present HttpOnly string as enabled, even "FALSE".
        // Omit the property for source cookies such as the non-HttpOnly BDUID.
        if item.http_only().unwrap_or(false) {
            properties.insert(ns_string!("HttpOnly"), ns_string!("TRUE"));
        }
        match item.same_site() {
            Some(SameSite::Lax) => {
                properties.insert(ns_string!("SameSite"), ns_string!("lax"));
            }
            Some(SameSite::Strict) => {
                properties.insert(ns_string!("SameSite"), ns_string!("strict"));
            }
            _ => {}
        }
        if let Some(expires) = item.expires_datetime() {
            let date = NSDate::dateWithTimeIntervalSince1970(expires.unix_timestamp() as f64);
            unsafe {
                properties.insert(NSHTTPCookieExpires, &date);
            }
        }
        unsafe { NSHTTPCookie::cookieWithProperties(&properties).ok_or_else(failed) }
    }

    fn same_cookie(actual: &NSHTTPCookie, expected: &NSHTTPCookie) -> bool {
        actual.name() == expected.name()
            && actual.domain() == expected.domain()
            && actual.path() == expected.path()
            && actual.value() == expected.value()
            && actual.isSecure() == expected.isSecure()
            && actual.isHTTPOnly() == expected.isHTTPOnly()
            && actual.sameSitePolicy() == expected.sameSitePolicy()
            && match (actual.expiresDate(), expected.expiresDate()) {
                (None, None) => true,
                (Some(a), Some(e)) => {
                    (a.timeIntervalSince1970() - e.timeIntervalSince1970()).abs() < 1.0
                }
                _ => false,
            }
    }

    fn verified(actual: &[Retained<NSHTTPCookie>], expected: &[Retained<NSHTTPCookie>]) -> bool {
        let managed: Vec<_> = actual.iter().filter(|cookie| managed(cookie)).collect();
        managed.len() == expected.len()
            && expected
                .iter()
                .all(|wanted| managed.iter().any(|found| same_cookie(found, wanted)))
    }

    fn readback(op: Rc<Operation>) {
        if !op.running() {
            return;
        }
        let next = op.clone();
        unsafe {
            op.store.getAllCookies(&RcBlock::new(
                move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
                    if !next.running() {
                        return;
                    }
                    let actual = cookies.as_ref().to_vec();
                    next.finish(if verified(&actual, &next.expected) {
                        Ok(())
                    } else {
                        Err(failed())
                    });
                },
            ));
        }
    }

    fn write_next(op: Rc<Operation>, index: usize) {
        if !op.running() {
            return;
        }
        let Some(cookie) = op.expected.get(index) else {
            return readback(op);
        };
        let next = op.clone();
        unsafe {
            op.store.setCookie_completionHandler(
                cookie,
                Some(&RcBlock::new(move || {
                    write_next(next.clone(), index + 1);
                })),
            );
        }
    }

    fn delete_next(op: Rc<Operation>, stale: Rc<Vec<Retained<NSHTTPCookie>>>, index: usize) {
        if !op.running() {
            return;
        }
        let Some(cookie) = stale.get(index) else {
            return write_next(op, 0);
        };
        let next = op.clone();
        let remaining = stale.clone();
        unsafe {
            op.store.deleteCookie_completionHandler(
                cookie,
                Some(&RcBlock::new(move || {
                    delete_next(next.clone(), remaining.clone(), index + 1);
                })),
            );
        }
    }

    pub(super) async fn apply(
        remote: tauri::Webview,
        items: Vec<Cookie<'static>>,
    ) -> Result<(), AppError> {
        if items.is_empty() || items.len() > 64 || !items.iter().any(|c| c.name() == "bticket") {
            return Err(failed());
        }
        let active = Arc::new(AtomicBool::new(true));
        let _cancel = CancelOnDrop(active.clone());
        let (tx, rx) = oneshot::channel();
        remote
            .with_webview(move |platform| {
                if !active.load(Ordering::Acquire) || tx.is_closed() {
                    return;
                }
                // with_webview guarantees main-thread execution and a live WKWebView
                // for this closure. Native completion blocks retain only its store.
                let webview = unsafe { &*(platform.inner() as *const WKWebView) };
                let expected: Result<Vec<_>, _> = items.iter().map(native_cookie).collect();
                let expected = match expected {
                    Ok(expected) => expected,
                    Err(error) => {
                        let _ = tx.send(Err(error));
                        return;
                    }
                };
                // Reject ambiguous duplicate source cookies before mutating the store.
                for (index, item) in expected.iter().enumerate() {
                    if expected[..index].iter().any(|old| {
                        old.name() == item.name()
                            && old.domain() == item.domain()
                            && old.path() == item.path()
                    }) {
                        let _ = tx.send(Err(failed()));
                        return;
                    }
                }
                let store = unsafe { webview.configuration().websiteDataStore().httpCookieStore() };
                let op = Rc::new(Operation {
                    store,
                    expected,
                    completion: RefCell::new(Some(tx)),
                    active,
                });
                let next = op.clone();
                unsafe {
                    op.store.getAllCookies(&RcBlock::new(
                        move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
                            if !next.running() {
                                return;
                            }
                            let stale = cookies
                                .as_ref()
                                .to_vec()
                                .into_iter()
                                .filter(|cookie| managed(cookie))
                                .collect();
                            delete_next(next.clone(), Rc::new(stale), 0);
                        },
                    ));
                }
            })
            .map_err(|_| failed())?;
        tokio::time::timeout(Duration::from_secs(15), rx)
            .await
            .map_err(|_| failed())?
            .map_err(|_| failed())?
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn cookie(domain: &str) -> Cookie<'static> {
            let mut cookie = Cookie::new("bticket", "synthetic-ticket");
            cookie.set_domain(domain.to_string());
            cookie.set_path("/");
            cookie.set_secure(true);
            cookie.set_http_only(true);
            cookie.set_same_site(SameSite::None);
            cookie
        }
        #[test]
        fn native_conversion_preserves_domain_scope_and_security() {
            let parent = native_cookie(&cookie(".ctrip.com")).unwrap();
            assert_eq!(parent.domain().to_string(), ".ctrip.com");
            assert!(parent.isSecure());
            assert!(parent.isHTTPOnly());
            let host = native_cookie(&cookie("vbooking.ctrip.com")).unwrap();
            assert_eq!(host.domain().to_string(), "vbooking.ctrip.com");
            assert!(verified(
                std::slice::from_ref(&parent),
                std::slice::from_ref(&parent)
            ));
            assert!(native_cookie(&cookie("other.test")).is_err());
        }
        #[test]
        fn readback_rejects_missing_changed_and_extra_authentication() {
            let expected = native_cookie(&cookie(".ctrip.com")).unwrap();
            assert!(!verified(&[], std::slice::from_ref(&expected)));
            let mut changed = cookie(".ctrip.com");
            changed.set_value("other-synthetic-ticket");
            assert!(!verified(
                &[native_cookie(&changed).unwrap()],
                std::slice::from_ref(&expected)
            ));
            let extra = native_cookie(&cookie("vbooking.ctrip.com")).unwrap();
            assert!(!verified(&[expected.clone(), extra], &[expected]));
        }
        #[test]
        fn native_conversion_keeps_expiry_same_site_and_non_http_only() {
            use tauri::webview::cookie::time::OffsetDateTime;
            let mut item = cookie(".ctrip.com");
            item.set_name("BDUID");
            item.set_http_only(false);
            item.set_same_site(SameSite::Strict);
            // Foundation caps long-lived cookies. Stay within its lifetime cap
            // so this assertion covers conversion, independent of today's date.
            let expires = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
                + 86_400;
            item.set_expires(OffsetDateTime::from_unix_timestamp(expires).unwrap());
            let native = native_cookie(&item).unwrap();
            assert!(!native.isHTTPOnly());
            assert_eq!(native.sameSitePolicy().unwrap().to_string(), "strict");
            assert_eq!(
                native.expiresDate().unwrap().timeIntervalSince1970(),
                expires as f64
            );
            item.set_secure(false);
            assert!(native_cookie(&item).is_err());
        }
    }
}

#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tauri::webview::cookie::SameSite;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::{Interface, HSTRING};

    struct CancelOnDrop(Arc<AtomicBool>);
    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    fn managed(c: &Cookie<'_>) -> bool {
        matches!(c.name(), "bticket" | "vbkticket" | "BDUID")
            && matches!(c.domain(), Some("ctrip.com" | "vbooking.ctrip.com"))
    }
    fn valid(items: &[Cookie<'_>]) -> bool {
        !items.is_empty()
            && items.len() <= 64
            && items.iter().any(|c| c.name() == "bticket")
            && items.iter().enumerate().all(|(index, c)| {
                managed(c)
                    && c.path() == Some("/")
                    && c.secure() == Some(true)
                    && !c.value().is_empty()
                    && c.value().len() <= 16384
                    && c.value()
                        .bytes()
                        .all(|b| (0x21..=0x7e).contains(&b) && b != b';')
                    && c.expires_datetime()
                        // `map_or(true, ..)`: `is_none_or` needs Rust 1.82 (MSRV 1.80).
                        .map_or(true, |e| {
                            e > tauri::webview::cookie::time::OffsetDateTime::now_utc()
                        })
                    && !items[..index].iter().any(|old| {
                        old.name() == c.name()
                            && old.domain() == c.domain()
                            && old.path() == c.path()
                    })
            })
    }
    fn same(actual: &Cookie<'_>, expected: &Cookie<'_>) -> bool {
        actual.name() == expected.name()
            && actual.domain() == expected.domain()
            && actual.path() == expected.path()
            && actual.value() == expected.value()
            && actual.secure().unwrap_or(false) == expected.secure().unwrap_or(false)
            && actual.http_only().unwrap_or(false) == expected.http_only().unwrap_or(false)
            && actual.same_site().unwrap_or(SameSite::Lax)
                == expected.same_site().unwrap_or(SameSite::Lax)
            && match (actual.expires_datetime(), expected.expires_datetime()) {
                (None, None) => true,
                (Some(a), Some(e)) => (a.unix_timestamp() - e.unix_timestamp()).abs() <= 1,
                _ => false,
            }
    }
    pub(super) async fn apply(
        remote: tauri::Webview,
        items: Vec<Cookie<'static>>,
    ) -> Result<(), AppError> {
        if !valid(&items) {
            return Err(failed());
        }
        let active = Arc::new(AtomicBool::new(true));
        let _cancel = CancelOnDrop(active.clone());
        let task = async {
            // Tauri documents cookies() as blocking on Windows: always read
            // from a worker, never from a synchronous command/main callback.
            let read = remote.clone();
            let stale = tauri::async_runtime::spawn_blocking(move || read.cookies())
                .await
                .map_err(|_| failed())?
                .map_err(|_| failed())?;
            for cookie in stale.into_iter().filter(managed) {
                if !active.load(Ordering::Acquire) {
                    return Err(failed());
                }
                remote.delete_cookie(cookie).map_err(|_| failed())?;
            }
            let expected = items.clone();
            let running = active.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            remote
                .with_webview(move |platform| {
                    let result = (|| -> Result<(), AppError> {
                        if !running.load(Ordering::Acquire) || tx.is_closed() {
                            return Err(failed());
                        }
                        let webview = unsafe { platform.controller().CoreWebView2() }
                            .map_err(|_| failed())?;
                        let webview: ICoreWebView2_2 = webview.cast().map_err(|_| failed())?;
                        let manager = unsafe { webview.CookieManager() }.map_err(|_| failed())?;
                        for item in &items {
                            if !running.load(Ordering::Acquire) || tx.is_closed() {
                                return Err(failed());
                            }
                            // Wry normalizes away leading dots. Supplying the raw
                            // parent domain to WebView2 preserves subdomain scope.
                            let domain = match item.domain() {
                                Some("ctrip.com") => ".ctrip.com",
                                Some("vbooking.ctrip.com") => "vbooking.ctrip.com",
                                _ => return Err(failed()),
                            };
                            unsafe {
                                let native = manager
                                    .CreateCookie(
                                        &HSTRING::from(item.name()),
                                        &HSTRING::from(item.value()),
                                        &HSTRING::from(domain),
                                        &HSTRING::from("/"),
                                    )
                                    .map_err(|_| failed())?;
                                native.SetIsSecure(true).map_err(|_| failed())?;
                                native
                                    .SetIsHttpOnly(item.http_only().unwrap_or(false))
                                    .map_err(|_| failed())?;
                                let site = match item.same_site().unwrap_or(SameSite::Lax) {
                                    SameSite::Strict => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
                                    SameSite::None => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
                                    SameSite::Lax => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
                                };
                                native.SetSameSite(site).map_err(|_| failed())?;
                                if let Some(expires) = item.expires_datetime() {
                                    native
                                        .SetExpires(expires.unix_timestamp() as f64)
                                        .map_err(|_| failed())?;
                                }
                                manager.AddOrUpdateCookie(&native).map_err(|_| failed())?;
                            }
                        }
                        Ok(())
                    })();
                    let _ = tx.send(result);
                })
                .map_err(|_| failed())?;
            rx.await.map_err(|_| failed())??;
            // Readback is queued after every native write on the same UI loop.
            let actual = tauri::async_runtime::spawn_blocking(move || remote.cookies())
                .await
                .map_err(|_| failed())?
                .map_err(|_| failed())?;
            let actual: Vec<_> = actual.into_iter().filter(managed).collect();
            if !active.load(Ordering::Acquire)
                || actual.len() != expected.len()
                || !expected
                    .iter()
                    .all(|wanted| actual.iter().any(|found| same(found, wanted)))
            {
                return Err(failed());
            }
            Ok(())
        };
        tokio::time::timeout(Duration::from_secs(15), task)
            .await
            .map_err(|_| failed())?
    }
}
