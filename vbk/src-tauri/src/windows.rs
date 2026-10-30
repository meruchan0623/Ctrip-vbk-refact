//! Native window lifecycle (docs/dev/01-shell.md, 03-strong-alert.md §6).
//!
//! * `main`: resident; close → hide to tray.
//! * `alarm`: singleton, always-on-top, shown without stealing focus,
//!   hidden (never destroyed) on close, positioned bottom-right of the work
//!   area and clamped into the visible region after monitor changes.
//! * `setting`, `update`: singletons.
//!
//! All windows are created here; other modules only submit policy.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::views;

/// Alarm window size in logical px (prototype: ≤ 60% of work-area height).
pub const ALARM_WIDTH: f64 = 380.0;
pub const ALARM_MAX_HEIGHT_RATIO: f64 = 0.6;
pub const ALARM_MIN_HEIGHT: f64 = 220.0;
const MARGIN: f64 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Corner {
    BottomRight,
    BottomLeft,
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
pub fn place_alarm(work_area: Rect, scale: f64, corner: Corner, wanted_height_logical: f64) -> Rect {
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
    let x = x.clamp(work_area.x, (work_area.x + work_area.w as i32 - w as i32).max(work_area.x));
    let y = y.clamp(work_area.y, (work_area.y + work_area.h as i32 - h as i32).max(work_area.y));
    Rect { x, y, w, h }
}

fn work_area_of_primary(app: &AppHandle) -> Option<(Rect, f64)> {
    let main = app.get_webview_window(views::MAIN)?;
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
    let win = WebviewWindowBuilder::new(app, views::ALARM, WebviewUrl::App("apps/alarm/index.html".into()))
        .title("回复超时提醒")
        .inner_size(ALARM_WIDTH, 320.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()?;
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
pub fn show_alarm(app: &AppHandle, corner: Corner, wanted_height_logical: f64, raise: bool) -> tauri::Result<()> {
    ensure_alarm(app)?;
    let Some(win) = app.get_webview_window(views::ALARM) else {
        return Ok(());
    };
    if let Some((area, scale)) = work_area_of_primary(app) {
        let r = place_alarm(area, scale, corner, wanted_height_logical);
        win.set_size(PhysicalSize::new(r.w, r.h))?;
        win.set_position(PhysicalPosition::new(r.x, r.y))?;
    }
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

pub fn hide_alarm(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(views::ALARM) {
        let _ = win.hide();
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(views::MAIN) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

pub fn toggle_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(views::MAIN) {
        if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
            let _ = win.hide();
        } else {
            show_main(app);
        }
    }
}

pub fn open_singleton(app: &AppHandle, label: &str, title: &str, url: &str, w: f64, h: f64) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(label) {
        win.show()?;
        win.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(w, h)
        .build()?;
    Ok(())
}

pub fn open_setting(app: &AppHandle) -> tauri::Result<()> {
    open_singleton(app, views::SETTING, "设置", "apps/setting/index.html", 900.0, 640.0)
}

pub fn open_update(app: &AppHandle) -> tauri::Result<()> {
    open_singleton(app, views::UPDATE, "客户端更新", "apps/update/index.html", 480.0, 360.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bottom_right_inside_work_area() {
        let area = Rect { x: 0, y: 0, w: 1920, h: 1040 };
        let r = place_alarm(area, 1.0, Corner::BottomRight, 320.0);
        assert_eq!(r.w, 380);
        assert_eq!(r.h, 320);
        assert_eq!(r.x, 1920 - 380 - 12);
        assert_eq!(r.y, 1040 - 320 - 12);
    }

    #[test]
    fn height_capped_to_60_percent_and_clamped_on_small_screen() {
        let area = Rect { x: 100, y: 50, w: 300, h: 400 };
        let r = place_alarm(area, 1.0, Corner::BottomLeft, 900.0);
        assert!(r.h <= 240);
        assert!(r.w <= 300);
        assert!(r.x >= area.x && r.x + r.w as i32 <= area.x + area.w as i32);
        assert!(r.y >= area.y && r.y + r.h as i32 <= area.y + area.h as i32);
    }

    #[test]
    fn dpi_scale_applies() {
        let area = Rect { x: 0, y: 0, w: 3840, h: 2080 };
        let r = place_alarm(area, 2.0, Corner::BottomRight, 320.0);
        assert_eq!(r.w, 760);
        assert_eq!(r.h, 640);
    }
}
