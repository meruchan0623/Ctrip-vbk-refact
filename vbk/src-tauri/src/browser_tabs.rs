//! Built-in browser: every web page the app opens is a child webview of the main
//! window, switched from the same title bar as the accounts. Pages run in their
//! account's profile, get no adapter and no capability (all capabilities are
//! local-only, so a remote page in the `main` window still cannot reach the IPC).
//! Their only init script keeps the official tones out of the OS media session.
//!
//! Once a tab exists the main window has several webviews, and Tauri's
//! `get_webview_window` / `webview_windows` stop reporting it: reach it with
//! `get_window`, its pages with `get_webview`, its UI webview with `views::MAIN`.

use std::sync::Mutex;

use contracts::{codes, AppError};
use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, State, Url, Webview, WebviewBuilder,
    WebviewUrl, Window,
};

use crate::dto::AppErrorDto;
use crate::events;
use crate::login::profiles;
use crate::state::HostState;
use crate::views;

const TAB_OPENED: &str = "browser://tab-opened"; // BrowserTabDto; opened by a page, activate it
const TAB_CHANGED: &str = "browser://tab-changed"; // BrowserTabDto
const TAB_CLOSED: &str = "browser://tab-closed"; // {tab_id}
const MAX_TABS: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BrowserTabDto {
    pub tab_id: String,
    pub account_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct BoundsDto {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BoundsDto {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.x >= 0.0
            && self.y >= 0.0
            && self.width > 0.0
            && self.height > 0.0
    }
    /// The page reports CSS px; the window wants logical px.
    fn rect(&self, zoom: f64) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x * zoom, self.y * zoom).into(),
            size: LogicalSize::new(self.width * zoom, self.height * zoom).into(),
        }
    }
}

#[derive(Default)]
struct Inner {
    seq: u64,
    tabs: Vec<BrowserTabDto>,
    bounds: Option<BoundsDto>,
}

#[derive(Default)]
pub struct BrowserTabs(Mutex<Inner>);

impl BrowserTabs {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Reuses the account's tab showing this exact URL; otherwise reserves a new label.
fn reserve(
    inner: &mut Inner,
    account_id: &str,
    url: &Url,
) -> Result<(BrowserTabDto, bool), AppError> {
    if let Some(tab) = inner
        .tabs
        .iter()
        .find(|t| t.account_id == account_id && t.url == url.as_str())
    {
        return Ok((tab.clone(), false));
    }
    if inner.tabs.len() >= MAX_TABS {
        return Err(AppError::new(
            codes::HOST_UNSUPPORTED,
            "网页标签已达上限，请先关闭不用的标签",
        ));
    }
    inner.seq += 1;
    let tab = BrowserTabDto {
        tab_id: profiles::view_label(inner.seq),
        account_id: account_id.to_string(),
        url: url.to_string(),
        title: String::new(),
        loading: true,
    };
    inner.tabs.push(tab.clone());
    Ok((tab, true))
}

fn change(app: &AppHandle, label: &str, apply: impl FnOnce(&mut BrowserTabDto)) {
    let Some(tabs) = app.try_state::<BrowserTabs>() else {
        return;
    };
    let changed = {
        let mut inner = tabs.lock();
        inner
            .tabs
            .iter_mut()
            .find(|t| t.tab_id == label)
            .map(|tab| {
                apply(tab);
                tab.clone()
            })
    };
    if let Some(tab) = changed {
        events::to_main(app, TAB_CHANGED, tab);
    }
}

fn opened_by_page(app: AppHandle, account_id: String, profile_id: String, url: Url) {
    tauri::async_runtime::spawn(async move {
        if crate::shell::check_external_url(url.as_str()).is_err() {
            events::toast(&app, "已阻止打开非官方网页");
            return;
        }
        match open(&app, &account_id, &profile_id, url) {
            Ok(tab) => events::to_main(&app, TAB_OPENED, tab),
            Err(e) => events::toast(&app, e.to_string()),
        }
    });
}

/// A tab opened from another local window: main owns the tab strip, so it takes over and comes forward.
pub fn hand_to_main(app: &AppHandle, tab: &BrowserTabDto) {
    events::to_main(app, TAB_OPENED, tab.clone());
    crate::windows::show_main(app);
}

/// Must not run on the main thread (`add_child` blocks on it).
pub fn open(
    app: &AppHandle,
    account_id: &str,
    profile_id: &str,
    url: Url,
) -> Result<BrowserTabDto, AppError> {
    let tabs = app.state::<BrowserTabs>();
    let (tab, created) = reserve(&mut tabs.lock(), account_id, &url)?;
    if !created {
        return Ok(tab);
    }
    let view = match build(app, &tab, profile_id, url) {
        Ok(view) => view,
        Err(e) => {
            tabs.lock().tabs.retain(|t| t.tab_id != tab.tab_id);
            return Err(AppError::new(
                codes::HOST_UNSUPPORTED,
                format!("webview: {e}"),
            ));
        }
    };
    // The account may have gone while the webview was being created.
    if !tabs.lock().tabs.iter().any(|t| t.tab_id == tab.tab_id) {
        let _ = view.close();
        return Err(AppError::new(codes::HOST_UNSUPPORTED, "网页标签已关闭"));
    }
    Ok(tab)
}

fn build(
    app: &AppHandle,
    tab: &BrowserTabDto,
    profile_id: &str,
    url: Url,
) -> tauri::Result<Webview> {
    let main = app
        .get_window(views::MAIN)
        .ok_or(tauri::Error::WindowNotFound)?;
    let (load_app, title_app, new_app) = (app.clone(), app.clone(), app.clone());
    let (account, profile) = (tab.account_id.clone(), profile_id.to_string());
    let builder = WebviewBuilder::new(&tab.tab_id, WebviewUrl::External(url))
        .initialization_script(crate::adapter::tone_silencer_script(app))
        .on_navigation(profiles::allowed_navigation)
        .on_page_load(move |view, load| {
            let url = load.url().to_string();
            let loading = matches!(load.event(), PageLoadEvent::Started);
            change(&load_app, view.label(), |t| {
                t.url = url;
                t.loading = loading;
            });
        })
        .on_document_title_changed(move |view, title| {
            change(&title_app, view.label(), |t| t.title = title);
        })
        .on_new_window(move |url, _| {
            opened_by_page(new_app.clone(), account.clone(), profile.clone(), url);
            NewWindowResponse::Deny
        })
        // Drops on a page belong to that page; only the main UI turns them into attachments.
        .disable_drag_drop_handler();
    let builder = profiles::isolate!(builder, app, profile_id);
    let bounds = app.state::<BrowserTabs>().lock().bounds;
    let zoom = crate::ui_zoom::factor();
    let (position, size) = bounds.map_or(
        (LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)),
        |b| {
            (
                LogicalPosition::new(b.x * zoom, b.y * zoom),
                LogicalSize::new(b.width * zoom, b.height * zoom),
            )
        },
    );
    let view = main.add_child(builder, position, size)?;
    view.hide()?;
    Ok(view)
}

fn known(app: &AppHandle, tab_id: &str) -> Result<Webview, AppErrorDto> {
    let exists = app
        .state::<BrowserTabs>()
        .lock()
        .tabs
        .iter()
        .any(|t| t.tab_id == tab_id);
    exists
        .then(|| app.get_webview(tab_id))
        .flatten()
        .ok_or_else(|| AppError::new(codes::HOST_UNSUPPORTED, "网页标签已关闭").into())
}

/// Zoom changed: keep every tab over the stage until the page reports new bounds.
pub fn reapply_bounds(app: &AppHandle) {
    let Some(tabs) = app.try_state::<BrowserTabs>() else {
        return;
    };
    let (bounds, labels): (_, Vec<String>) = {
        let inner = tabs.lock();
        (
            inner.bounds,
            inner.tabs.iter().map(|t| t.tab_id.clone()).collect(),
        )
    };
    let Some(bounds) = bounds else { return };
    let rect = bounds.rect(crate::ui_zoom::factor());
    for label in labels {
        if let Some(view) = app.get_webview(&label) {
            let _ = view.set_bounds(rect);
        }
    }
}

fn host_err(e: tauri::Error) -> AppErrorDto {
    AppError::new(codes::HOST_UNSUPPORTED, e.to_string()).into()
}

/// Shows one tab at `bounds` (logical px in the main window) and hides the rest.
/// `tab_id: null` hides them all, e.g. while a menu or dialog sits over the stage.
#[tauri::command(rename_all = "snake_case")]
pub async fn browser_show(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    tab_id: Option<String>,
    bounds: Option<BoundsDto>,
) -> Result<(), AppErrorDto> {
    state
        .authorize(window.label(), "browser_show")
        .map_err(AppErrorDto::from)?;
    let bounds = bounds.filter(BoundsDto::valid);
    let others: Vec<String> = {
        let tabs = app.state::<BrowserTabs>();
        let mut inner = tabs.lock();
        if bounds.is_some() {
            inner.bounds = bounds;
        }
        inner
            .tabs
            .iter()
            .map(|t| t.tab_id.clone())
            .filter(|id| Some(id) != tab_id.as_ref())
            .collect()
    };
    let had_tabs = !others.is_empty();
    for label in others {
        if let Some(view) = app.get_webview(&label) {
            let _ = view.hide();
        }
    }
    if let Some(id) = tab_id {
        let view = known(&app, &id)?;
        if let Some(b) = bounds {
            view.set_bounds(b.rect(crate::ui_zoom::factor()))
                .map_err(host_err)?;
        }
        view.show().map_err(host_err)?;
    } else if had_tabs {
        // A hidden page must not keep the keyboard, or the UI would count as unfocused.
        if let Some(ui) = app.get_webview(views::MAIN) {
            let _ = ui.set_focus();
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn browser_nav(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    tab_id: String,
    action: String,
) -> Result<(), AppErrorDto> {
    state
        .authorize(window.label(), "browser_nav")
        .map_err(AppErrorDto::from)?;
    let view = known(&app, &tab_id)?;
    match action.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        other => {
            return Err(AppError::new(
                codes::HOST_UNSUPPORTED,
                format!("unknown browser action {other:?}"),
            )
            .into())
        }
    }
    .map_err(host_err)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn browser_close(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    tab_id: String,
) -> Result<(), AppErrorDto> {
    state
        .authorize(window.label(), "browser_close")
        .map_err(AppErrorDto::from)?;
    // Idempotent: the tab may already have gone with its account.
    let view = known(&app, &tab_id).ok();
    app.state::<BrowserTabs>()
        .lock()
        .tabs
        .retain(|t| t.tab_id != tab_id);
    match view {
        Some(view) => view.close().map_err(host_err),
        None => Ok(()),
    }
}

/// An account's pages hold its session, so they go when the account does.
pub fn close_account(app: &AppHandle, account_id: &str) {
    let Some(tabs) = app.try_state::<BrowserTabs>() else {
        return;
    };
    let closing: Vec<String> = {
        let mut inner = tabs.lock();
        let ids = inner
            .tabs
            .iter()
            .filter(|t| t.account_id == account_id)
            .map(|t| t.tab_id.clone())
            .collect();
        inner.tabs.retain(|t| t.account_id != account_id);
        ids
    };
    for id in closing {
        if let Some(view) = app.get_webview(&id) {
            let _ = view.close();
        }
        events::to_main(app, TAB_CLOSED, serde_json::json!({ "tab_id": id }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(path: &str) -> Url {
        Url::parse(&format!("https://vbooking.ctrip.com/{path}")).unwrap()
    }

    #[test]
    fn same_account_and_url_reuses_the_tab_but_accounts_stay_separate() {
        let mut inner = Inner::default();
        let (first, created) = reserve(&mut inner, "a", &url("x")).unwrap();
        assert!(created);
        let (again, created) = reserve(&mut inner, "a", &url("x")).unwrap();
        assert!(!created);
        assert_eq!(first, again);
        let (other, created) = reserve(&mut inner, "b", &url("x")).unwrap();
        assert!(created);
        assert_ne!(first.tab_id, other.tab_id);
    }

    #[test]
    fn tab_count_is_capped() {
        let mut inner = Inner::default();
        for n in 0..MAX_TABS {
            reserve(&mut inner, "a", &url(&n.to_string())).unwrap();
        }
        assert!(reserve(&mut inner, "a", &url("over")).is_err());
        assert!(reserve(&mut inner, "a", &url("0")).is_ok());
    }

    #[test]
    fn stage_bounds_scale_from_css_to_window_px() {
        let b = BoundsDto {
            x: 100.0,
            y: 40.0,
            width: 800.0,
            height: 600.0,
        };
        let want = Rect {
            position: LogicalPosition::new(150.0, 60.0).into(),
            size: LogicalSize::new(1200.0, 900.0).into(),
        };
        assert_eq!(format!("{:?}", b.rect(1.5)), format!("{want:?}"));
    }

    #[test]
    fn bounds_must_be_finite_and_positive() {
        let b = |x, width| BoundsDto {
            x,
            y: 40.0,
            width,
            height: 600.0,
        };
        assert!(b(0.0, 800.0).valid());
        assert!(!b(-1.0, 800.0).valid());
        assert!(!b(0.0, 0.0).valid());
        assert!(!b(f64::NAN, 800.0).valid());
    }
}
