//! Native window lifecycle (docs/dev/01-shell.md, 03-strong-alert.md §6).
//!
//! * `main`: resident; close → hide to tray.
//! * `alarm`: singleton, always-on-top, shown without stealing focus,
//!   hidden (never destroyed) on close, positioned bottom-right of the work
//!   area and clamped into the visible region after monitor changes.
//! * `setting`, `update`: singletons; same D1 chrome as `main`
//!   (macOS overlay title bar + traffic lights, Windows undecorated with the
//!   page drawing its caption buttons, see `ui/apps/_shared/window-controls.ts`).
//! * `media-viewer`: singleton attachment viewer, same chrome; reused across
//!   attachments and destroyed on close so playback stops with the window.
//!
//! All windows are created here; other modules only submit policy.

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::views;

/// Alarm window size in logical px (prototype: ≤ 60% of work-area height).
pub const ALARM_WIDTH: f64 = 380.0;
pub const ALARM_MAX_HEIGHT_RATIO: f64 = 0.6;
pub const ALARM_MIN_HEIGHT: f64 = 72.0;
/// Header plus one row, until the page reports its real content height.
const ALARM_FIRST_HEIGHT: u32 = 112;
/// Last content height the page reported, kept across hide/show.
static ALARM_HEIGHT: AtomicU32 = AtomicU32::new(ALARM_FIRST_HEIGHT);
const MARGIN: f64 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Corner {
    BottomRight,
    BottomLeft,
}

impl Corner {
    pub fn from_bottom_right(bottom_right: bool) -> Self {
        if bottom_right {
            Self::BottomRight
        } else {
            Self::BottomLeft
        }
    }
}

/// Rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Pure placement: computes the alarm window rect inside `work_area`
/// (physical px) for the requested corner and scale factor, clamping into
/// the visible region. Tested without a display.
pub fn place_alarm(
    work_area: Rect,
    scale: f64,
    corner: Corner,
    wanted_height_logical: f64,
) -> Rect {
    let margin = (MARGIN * scale).round() as i32;
    let w = ((ALARM_WIDTH * scale).round() as u32).min(work_area.w.max(1));
    let max_h = (work_area.h as f64 * ALARM_MAX_HEIGHT_RATIO).round() as u32;
    let min_h = (ALARM_MIN_HEIGHT * scale).round() as u32;
    let wanted = (wanted_height_logical * scale).round() as u32;
    let h = wanted.clamp(min_h.min(max_h.max(1)), max_h.max(1));
    let x = match corner {
        Corner::BottomRight => work_area.x + work_area.w as i32 - w as i32 - margin,
        Corner::BottomLeft => work_area.x + margin,
    };
    let y = work_area.y + work_area.h as i32 - h as i32 - margin;
    // Clamp into the work area (monitor removed / shrunk).
    let x = x.clamp(
        work_area.x,
        (work_area.x + work_area.w as i32 - w as i32).max(work_area.x),
    );
    let y = y.clamp(
        work_area.y,
        (work_area.y + work_area.h as i32 - h as i32).max(work_area.y),
    );
    Rect { x, y, w, h }
}

fn work_area_of_primary(app: &AppHandle) -> Option<(Rect, f64)> {
    let main = app.get_window(views::MAIN)?;
    let monitor = main
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| main.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    Some((
        Rect {
            x: area.position.x,
            y: area.position.y,
            w: area.size.width,
            h: area.size.height,
        },
        monitor.scale_factor(),
    ))
}

/// Creates the alarm window hidden. Called once at startup after the main
/// shell is interactive (pre-created so a later show is instant).
pub fn ensure_alarm(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(views::ALARM).is_some() {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
        app,
        views::ALARM,
        WebviewUrl::App("apps/alarm/index.html".into()),
    )
    .title("回复超时提醒")
    .inner_size(ALARM_WIDTH, f64::from(ALARM_FIRST_HEIGHT))
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    // macOS: follow the user across Spaces and over full-screen apps
    // (strong-alert §2 "全屏时仍弹回复超时"); ignored on Windows.
    .visible_on_all_workspaces(true)
    // Windows only; macOS has no per-window Dock entry to skip.
    .skip_taskbar(true)
    .focused(false)
    .visible(false);
    // The red ring is the window edge: DWM's undecorated shadow would round it
    // away on Windows 11 and add a 1px white border on Windows 10.
    #[cfg(target_os = "windows")]
    let builder = builder.shadow(false);
    let win = builder.build()?;
    // Close → hide; the window is a singleton reused for every round.
    let handle = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
        }
    });
    Ok(())
}

/// Shows the alarm window without activating it (strong-alert §6: 置顶、不
/// 激活显示). `raise` re-applies always-on-top once (level change only).
pub fn show_alarm(app: &AppHandle, corner: Corner, raise: bool) -> tauri::Result<()> {
    ensure_alarm(app)?;
    let Some(win) = app.get_webview_window(views::ALARM) else {
        return Ok(());
    };
    fit_alarm(app, &win, corner)?;
    if !win.is_visible().unwrap_or(false) {
        // `show` on a window built with `focused(false)` does not activate it
        // on Windows; we never call `set_focus` here.
        win.show()?;
    }
    if raise {
        win.set_always_on_top(true)?;
    }
    Ok(())
}

/// Windows rescales a window that lands on a monitor with another DPI
/// (WM_DPICHANGED), so it has to arrive there before the final size is set.
fn apply_rect(win: &WebviewWindow, r: Rect) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    win.set_position(PhysicalPosition::new(r.x, r.y))?;
    win.set_size(PhysicalSize::new(r.w, r.h))?;
    win.set_position(PhysicalPosition::new(r.x, r.y))
}

fn fit_alarm(app: &AppHandle, win: &WebviewWindow, corner: Corner) -> tauri::Result<()> {
    if let Some((area, scale)) = work_area_of_primary(app) {
        let height = f64::from(ALARM_HEIGHT.load(Ordering::Relaxed));
        let r = place_alarm(area, scale * crate::ui_zoom::factor(), corner, height);
        apply_rect(win, r)?;
    }
    Ok(())
}

/// Records the page's content height; `place_alarm` bounds it to the screen.
pub fn resize_alarm(app: &AppHandle, corner: Corner, height: f64) -> tauri::Result<()> {
    if !height.is_finite() || height <= 0.0 {
        return Ok(());
    }
    ALARM_HEIGHT.store(height.ceil() as u32, Ordering::Relaxed);
    match app.get_webview_window(views::ALARM) {
        Some(win) => fit_alarm(app, &win, corner),
        None => Ok(()),
    }
}

/// Moves the alarm window to the configured corner at the current zoom.
pub fn refit_alarm(app: &AppHandle) {
    let bottom_right = app
        .state::<crate::state::HostState>()
        .settings()
        .position_bottom_right;
    if let Some(win) = app.get_webview_window(views::ALARM) {
        if let Err(e) = fit_alarm(app, &win, Corner::from_bottom_right(bottom_right)) {
            log::warn!("refit alarm failed: {e}");
        }
    }
}

/// The floating windows size themselves from content heights in CSS px, which
/// do not change with the zoom, so the host has to re-place them.
pub fn refit_floating(app: &AppHandle) {
    refit_alarm(app);
    let visible = app
        .get_webview_window(views::NOTICE)
        .is_some_and(|win| win.is_visible().unwrap_or(false));
    if visible {
        let height = f64::from(NOTICE_HEIGHT.load(Ordering::Relaxed));
        if let Err(e) = place_notice(app, height) {
            log::warn!("refit notice failed: {e}");
        }
    }
}

pub fn alarm_is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(views::ALARM)
        .is_some_and(|win| win.is_visible().unwrap_or(false))
}

pub fn hide_alarm(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(views::ALARM) {
        let _ = win.hide();
    }
}

const NOTICE_WIDTH: f64 = 372.0;
const NOTICE_MAX_HEIGHT: f64 = 480.0;
/// One card (`ui/apps/notice/viewmodel.ts` stackHeight); the page refines it.
const NOTICE_FIRST_HEIGHT: f64 = 104.0;
const NOTICE_MARGIN: f64 = 6.0;
/// Last stack height the page reported, for re-placing on a zoom change.
static NOTICE_HEIGHT: AtomicU32 = AtomicU32::new(NOTICE_FIRST_HEIGHT as u32);

/// Pre-created hidden so the first notice is instant. Never focusable, so a
/// notice cannot take focus from what the user is typing in; first-mouse makes
/// the first click on it count while another app is active.
pub fn ensure_notice(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(views::NOTICE).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        views::NOTICE,
        WebviewUrl::App("apps/notice/index.html".into()),
    )
    .title("新消息通知")
    .inner_size(NOTICE_WIDTH, NOTICE_FIRST_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focusable(false)
    .focused(false)
    .accept_first_mouse(true)
    .visible(false)
    .build()?;
    Ok(())
}

/// Top-right of the work area; the stack only ever grows downward from there.
fn place_notice(app: &AppHandle, height: f64) -> tauri::Result<()> {
    let Some(win) = app.get_webview_window(views::NOTICE) else {
        return Ok(());
    };
    NOTICE_HEIGHT.store(height.ceil() as u32, Ordering::Relaxed);
    if let Some((area, scale)) = work_area_of_primary(app) {
        let scale = scale * crate::ui_zoom::factor();
        let w = (NOTICE_WIDTH * scale).round() as u32;
        let h = (height.min(NOTICE_MAX_HEIGHT) * scale).round() as u32;
        let margin = (NOTICE_MARGIN * scale).round() as i32;
        apply_rect(
            &win,
            Rect {
                x: area.x + area.w as i32 - w as i32 - margin,
                y: area.y + margin,
                w,
                h,
            },
        )?;
    }
    Ok(())
}

pub fn show_notice(app: &AppHandle) -> tauri::Result<()> {
    ensure_notice(app)?;
    let Some(win) = app.get_webview_window(views::NOTICE) else {
        return Ok(());
    };
    if !win.is_visible().unwrap_or(false) {
        place_notice(app, NOTICE_FIRST_HEIGHT)?;
        win.show()?;
    }
    Ok(())
}

pub fn resize_notice(app: &AppHandle, height: f64) -> tauri::Result<()> {
    let Some(win) = app.get_webview_window(views::NOTICE) else {
        return Ok(());
    };
    if !height.is_finite() || height <= 0.0 {
        return win.hide();
    }
    place_notice(app, height)
}

pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_window(views::MAIN) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

pub fn toggle_main(app: &AppHandle) {
    if let Some(win) = app.get_window(views::MAIN) {
        if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
            let _ = win.hide();
        } else {
            show_main(app);
        }
    }
}

static SECONDARY_WINDOW_OPEN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The real secondary-window construction seam, shared by command and tray.
/// Serializes the existing-window check and creation as one operation.
pub(crate) async fn dispatch_secondary_window<T: Send + 'static>(
    open: impl FnOnce() -> tauri::Result<T> + Send + 'static,
) -> tauri::Result<T> {
    let _gate = SECONDARY_WINDOW_OPEN.lock().await;
    tauri::async_runtime::spawn_blocking(open)
        .await
        .map_err(|_| tauri::Error::Io(std::io::Error::other("secondary window worker failed")))?
}

pub async fn open_singleton(
    app: &AppHandle,
    label: &str,
    title: &str,
    url: &str,
    w: f64,
    h: f64,
) -> tauri::Result<()> {
    let app = app.clone();
    let label = label.to_string();
    let title = title.to_string();
    let url = url.to_string();
    dispatch_secondary_window(move || {
        if let Some(win) = app.get_webview_window(&label) {
            win.show()?;
            let _ = win.unminimize();
            win.set_focus()?;
            return Ok(());
        }
        let (w, h) = crate::ui_zoom::scaled_size(&app, w, h);
        let (min_w, min_h) = secondary_min_size(&label);
        let (min_w, min_h) = crate::ui_zoom::scaled_size(&app, min_w, min_h);
        // Fixed dialog on Windows: no resize border, and a double-click on its
        // title bar cannot blow it up to full screen. macOS keeps its behaviour.
        #[cfg(target_os = "windows")]
        let resizable = label != views::UPDATE;
        let builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
            .title(title)
            .inner_size(w, h)
            .min_inner_size(min_w, min_h);
        #[cfg(target_os = "windows")]
        let builder = builder.resizable(resizable);
        with_platform_chrome(builder).build()?;
        Ok(())
    })
    .await
}

/// Smallest content size each secondary window still lays out without clipping
/// (logical px at 100% zoom, verified by the Windows-mode layout audit).
fn secondary_min_size(label: &str) -> (f64, f64) {
    match label {
        views::SETTING => (640.0, 480.0),
        views::UPDATE => (420.0, 300.0),
        _ => (520.0, 400.0),
    }
}

/// Traffic-light origin (logical px) that centres the macOS buttons in the
/// 40 px self-drawn title bar; mirrors `trafficLightPosition` of `main` in
/// `tauri.macos.conf.json`.
pub const TRAFFIC_LIGHT_X: f64 = 14.0;
pub const TRAFFIC_LIGHT_Y: f64 = 14.0;

/// Plan D1 window chrome for local secondary windows (setting / update):
/// macOS keeps native decorations with an overlay title bar (traffic lights
/// on the left, no native title text); Windows drops decorations so the page
/// draws its own caption buttons.
fn with_platform_chrome<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(
            TRAFFIC_LIGHT_X,
            TRAFFIC_LIGHT_Y,
        ));
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    builder
}

pub async fn open_setting(app: &AppHandle) -> tauri::Result<()> {
    open_singleton(
        app,
        views::SETTING,
        "设置",
        "apps/setting/index.html",
        900.0,
        640.0,
    )
    .await
}

pub async fn open_media_viewer(app: &AppHandle) -> tauri::Result<()> {
    let app = app.clone();
    dispatch_secondary_window(move || {
        if let Some(win) = app.get_webview_window(views::MEDIA_VIEWER) {
            win.show()?;
            let _ = win.unminimize();
            win.set_focus()?;
            return Ok(());
        }
        let builder = WebviewWindowBuilder::new(
            &app,
            views::MEDIA_VIEWER,
            WebviewUrl::App("apps/media-viewer/index.html".into()),
        )
        // Generic on purpose: file names are customer data and this title reaches the OS window list.
        .title("附件查看器")
        .inner_size(1120.0, 820.0)
        .min_inner_size(520.0, 400.0)
        .background_color(tauri::webview::Color(16, 22, 33, 255));
        with_platform_chrome(builder).build()?;
        Ok(())
    })
    .await
}

pub async fn open_update(app: &AppHandle) -> tauri::Result<()> {
    open_singleton(
        app,
        views::UPDATE,
        "客户端更新",
        "apps/update/index.html",
        480.0,
        360.0,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secondary_windows_have_a_usable_minimum() {
        assert_eq!(secondary_min_size(views::SETTING), (640.0, 480.0));
        assert_eq!(secondary_min_size(views::UPDATE), (420.0, 300.0));
        let detail = format!("{}x", views::PACKAGE_DETAIL_PREFIX);
        assert_eq!(secondary_min_size(&detail), (520.0, 400.0));
    }

    #[test]
    fn secondary_window_builder_runs_off_the_invoking_thread() {
        let invoking = std::thread::current().id();
        let actual = tauri::async_runtime::block_on(dispatch_secondary_window(move || {
            Ok(std::thread::current().id())
        }))
        .unwrap();
        assert_ne!(
            actual, invoking,
            "Windows WebView construction must not run on the synchronous invoking/UI thread"
        );
    }

    #[test]
    fn secondary_window_creation_is_serial_and_preserves_builder_errors() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        };
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let ready = Arc::new(Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let active = active.clone();
                let peak = peak.clone();
                let ready = ready.clone();
                std::thread::spawn(move || {
                    ready.wait();
                    tauri::async_runtime::block_on(dispatch_secondary_window(move || {
                        let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(count, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    }))
                    .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(
            peak.load(Ordering::SeqCst),
            1,
            "check/create must be serialized for concurrent singleton requests"
        );
        let result: tauri::Result<()> =
            tauri::async_runtime::block_on(dispatch_secondary_window(|| {
                Err(tauri::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "synthetic builder failure",
                )))
            }));
        assert!(
            matches!(result, Err(tauri::Error::Io(ref error)) if error.kind() == std::io::ErrorKind::PermissionDenied)
        );
    }

    #[test]
    fn bottom_right_inside_work_area() {
        let area = Rect {
            x: 0,
            y: 0,
            w: 1920,
            h: 1040,
        };
        let r = place_alarm(area, 1.0, Corner::BottomRight, 320.0);
        assert_eq!(r.w, 380);
        assert_eq!(r.h, 320);
        assert_eq!(r.x, 1920 - 380 - 12);
        assert_eq!(r.y, 1040 - 320 - 12);
    }

    #[test]
    fn height_capped_to_60_percent_and_clamped_on_small_screen() {
        let area = Rect {
            x: 100,
            y: 50,
            w: 300,
            h: 400,
        };
        let r = place_alarm(area, 1.0, Corner::BottomLeft, 900.0);
        assert!(r.h <= 240);
        assert!(r.w <= 300);
        assert!(r.x >= area.x && r.x + r.w as i32 <= area.x + area.w as i32);
        assert!(r.y >= area.y && r.y + r.h as i32 <= area.y + area.h as i32);
    }

    #[test]
    fn dpi_scale_applies() {
        let area = Rect {
            x: 0,
            y: 0,
            w: 3840,
            h: 2080,
        };
        let r = place_alarm(area, 2.0, Corner::BottomRight, 320.0);
        assert_eq!(r.w, 760);
        assert_eq!(r.h, 640);
    }
}
