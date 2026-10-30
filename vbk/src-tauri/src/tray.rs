//! Tray icon and menu (docs/dev/01-shell.md): left click shows the main
//! window; right-click menu 显示主窗口 / 设置 / 勿扰 ▸ 1 小时 / 直到明天 / 退出;
//! tooltip carries the unread count; the icon is swapped at 500 ms for L1
//! flashing (driven by the scheduler, not by a timer here).

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::state::HostState;
use crate::windows;

pub const TRAY_ID: &str = "main";
pub const MENU_SHOW: &str = "tray.show";
pub const MENU_SETTING: &str = "tray.setting";
pub const MENU_DND_1H: &str = "tray.dnd.1h";
pub const MENU_DND_TOMORROW: &str = "tray.dnd.tomorrow";
pub const MENU_DND_OFF: &str = "tray.dnd.off";
pub const MENU_QUIT: &str = "tray.quit";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id(MENU_SHOW, "显示主窗口").build(app)?;
    let setting = MenuItemBuilder::with_id(MENU_SETTING, "设置").build(app)?;
    let dnd_1h = MenuItemBuilder::with_id(MENU_DND_1H, "勿扰 1 小时").build(app)?;
    let dnd_tomorrow = MenuItemBuilder::with_id(MENU_DND_TOMORROW, "勿扰直到明天").build(app)?;
    let dnd_off = MenuItemBuilder::with_id(MENU_DND_OFF, "关闭勿扰").build(app)?;
    let dnd = SubmenuBuilder::with_id(app, "tray.dnd", "勿扰")
        .items(&[&dnd_1h, &dnd_tomorrow, &dnd_off])
        .build()?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &setting])
        .separator()
        .item(&dnd)
        .separator()
        .item(&quit)
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("VBooking 商家客户端")
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => windows::show_main(app),
            MENU_SETTING => {
                let _ = windows::open_setting(app);
            }
            MENU_DND_1H => app.state::<HostState>().set_dnd_hours(1),
            MENU_DND_TOMORROW => app.state::<HostState>().set_dnd_until_tomorrow(),
            MENU_DND_OFF => app.state::<HostState>().clear_dnd(),
            MENU_QUIT => app.state::<HostState>().request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                windows::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// Updates tooltip text with the aggregate unread count (L0).
pub fn set_unread_tooltip(app: &AppHandle, unread_text: Option<&str>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let text = match unread_text {
            Some(n) => format!("VBooking 商家客户端 · 未读 {n}"),
            None => "VBooking 商家客户端".to_string(),
        };
        let _ = tray.set_tooltip(Some(text));
    }
}

/// L1 flashing: the scheduler alternates `on` every 500 ms. On Windows this
/// hides/shows the notification-area icon so no second asset is required at
/// this stage. On macOS hiding a menu-bar status item makes neighbouring
/// items jump and can reorder them, so the phase is ignored there; the Dock
/// attention request in the scheduler is the macOS L1 signal instead.
pub fn set_flash_phase(app: &AppHandle, visible: bool) {
    #[cfg(not(target_os = "macos"))]
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(visible);
    }
    #[cfg(target_os = "macos")]
    let _ = (app, visible);
}
