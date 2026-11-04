//! 界面缩放（`display.zoom`）：由宿主直接作用于本地窗口的 webview，立即生效且
//! 不需要任何页面权限。
//!
//! * 只碰本地界面；登录窗（官方页面 + 固定高度页头）与远程 webview 不缩放。
//! * 页面缩放后 CSS 像素不再等于窗口逻辑像素：页面上报的尺寸（强提醒、通知卡片、
//!   内置浏览器区域）由 `windows` / `browser_tabs` 乘上 [`factor`] 再落到窗口。
//! * macOS 红绿灯的位置不随页面缩放，页面用 `--ui-zoom` 换算让出的宽度。

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Webview, Window};

use crate::views;

static PERCENT: AtomicU32 = AtomicU32::new(100);

/// `tauri.conf.json` 里主窗在 100% 时的最小内容尺寸。
const MAIN_MIN: (f64, f64) = (980.0, 640.0);

pub fn factor() -> f64 {
    f64::from(PERCENT.load(Ordering::Relaxed)) / 100.0
}

fn zoomable(label: &str) -> bool {
    matches!(
        label,
        views::MAIN
            | views::ALARM
            | views::NOTICE
            | views::SETTING
            | views::UPDATE
            | views::MEDIA_VIEWER
    ) || label.starts_with(views::PACKAGE_DETAIL_PREFIX)
}

/// 随缩放等比变化的独立窗口（强提醒与通知卡片由 `windows` 自己定位）。
fn scales_with_zoom(label: &str) -> bool {
    matches!(label, views::SETTING | views::UPDATE | views::MEDIA_VIEWER)
        || label.starts_with(views::PACKAGE_DETAIL_PREFIX)
}

fn clamp_to_area(wanted: (f64, f64), area: Option<(f64, f64)>) -> (f64, f64) {
    match area {
        Some((w, h)) => (wanted.0.min(w), wanted.1.min(h)),
        None => wanted,
    }
}

fn logical_area(window: &Window) -> Option<(f64, f64)> {
    let monitor = window.current_monitor().ok().flatten()?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    Some((
        f64::from(area.size.width) / scale,
        f64::from(area.size.height) / scale,
    ))
}

fn push_to_page(view: &Webview) {
    if let Err(e) = view.set_zoom(factor()) {
        log::warn!("ui zoom: {e}");
    }
    let script = format!(
        "document.documentElement.style.setProperty('--ui-zoom','{}')",
        factor()
    );
    let _ = view.eval(script);
}

/// 新文档也要拿到当前缩放；每个本地窗口的创建与重载都经过这里。
pub fn on_page_load(view: &Webview) {
    if zoomable(view.label()) {
        push_to_page(view);
    }
}

/// 让主窗在当前缩放下仍放得下按 100% 设计的最小布局（不超过屏幕工作区）。
fn fit_main(app: &AppHandle) {
    let Some(win) = app.get_window(views::MAIN) else {
        return;
    };
    let f = factor();
    let (min_w, min_h) = clamp_to_area((MAIN_MIN.0 * f, MAIN_MIN.1 * f), logical_area(&win));
    let _ = win.set_min_size(Some(LogicalSize::new(min_w, min_h)));
    if win.is_fullscreen().unwrap_or(false) || win.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) else {
        return;
    };
    let (w, h) = (
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
    );
    if w < min_w || h < min_h {
        let _ = win.set_size(LogicalSize::new(w.max(min_w), h.max(min_h)));
    }
}

/// 设置、更新、套餐详情这类小窗与内容同比缩放，并保持整窗留在屏幕内。
fn rescale_secondary(win: &Window, ratio: f64) {
    let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) else {
        return;
    };
    let wanted = (
        f64::from(size.width) / scale * ratio,
        f64::from(size.height) / scale * ratio,
    );
    let (w, h) = clamp_to_area(wanted, logical_area(win));
    let _ = win.set_size(LogicalSize::new(w, h));
    let (Ok(Some(monitor)), Ok(pos)) = (win.current_monitor(), win.outer_position()) else {
        return;
    };
    let area = monitor.work_area();
    let right = area.position.x + area.size.width as i32 - (w * scale).round() as i32;
    let bottom = area.position.y + area.size.height as i32 - (h * scale).round() as i32;
    let x = pos.x.min(right).max(area.position.x);
    let y = pos.y.min(bottom).max(area.position.y);
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// 独立窗口创建时的逻辑尺寸。
pub fn scaled_size(app: &AppHandle, width: f64, height: f64) -> (f64, f64) {
    let f = factor();
    let area = app.get_window(views::MAIN).and_then(|m| logical_area(&m));
    clamp_to_area((width * f, height * f), area)
}

/// 启动时恢复已保存的缩放（已创建的窗口立即应用）。
pub fn init(app: &AppHandle, percent: u32) {
    PERCENT.store(percent, Ordering::Relaxed);
    for (label, view) in app.webviews() {
        if zoomable(&label) {
            push_to_page(&view);
        }
    }
    fit_main(app);
}

/// `prefs_set(display.zoom)`：所有本地窗口立即改变大小。
pub fn apply(app: &AppHandle, percent: u32) {
    let old = PERCENT.swap(percent, Ordering::Relaxed);
    if old == percent {
        return;
    }
    let ratio = f64::from(percent) / f64::from(old);
    for (label, view) in app.webviews() {
        if zoomable(&label) {
            push_to_page(&view);
        }
    }
    fit_main(app);
    for (label, win) in app.windows() {
        if scales_with_zoom(&label) {
            rescale_secondary(&win, ratio);
        }
    }
    crate::windows::refit_floating(app);
    crate::browser_tabs::reapply_bounds(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_interface_windows_are_zoomed() {
        for label in [
            "main",
            "alarm",
            "notice",
            "setting",
            "update",
            "media-viewer",
        ] {
            assert!(zoomable(label), "{label}");
        }
        assert!(zoomable(&format!("{}x", views::PACKAGE_DETAIL_PREFIX)));
        for label in ["login", "acct-prod-1", "browser-tab-1", "tsim"] {
            assert!(!zoomable(label), "{label}");
        }
    }

    #[test]
    fn floating_and_main_windows_do_not_scale_proportionally() {
        for label in ["main", "alarm", "notice"] {
            assert!(!scales_with_zoom(label), "{label}");
        }
        assert!(scales_with_zoom("setting"));
    }

    #[test]
    fn window_never_exceeds_the_work_area() {
        assert_eq!(clamp_to_area((1350.0, 960.0), None), (1350.0, 960.0));
        assert_eq!(
            clamp_to_area((1350.0, 960.0), Some((1512.0, 900.0))),
            (1350.0, 900.0)
        );
    }
}
