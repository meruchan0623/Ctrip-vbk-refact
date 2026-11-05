//! Windows-only native parts of the self-drawn title bar.
//!
//! Undecorated windows have no native caption, so a right-click on the page's
//! drag region opens the real system menu here (docs/dev/01-shell.md).

use tauri::Window;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnableMenuItem, GetCursorPos, GetSystemMenu, IsIconic, IsZoomed, PostMessageW,
    SetForegroundWindow, SetMenuDefaultItem, TrackPopupMenu, MF_BYCOMMAND, MF_ENABLED, MF_GRAYED,
    SC_CLOSE, SC_MAXIMIZE, SC_MINIMIZE, SC_MOVE, SC_RESTORE, SC_SIZE, TPM_RETURNCMD,
    TPM_RIGHTBUTTON, WM_SYSCOMMAND,
};

/// Which system-menu commands apply in this window state, matching a native
/// caption: a restored window moves and sizes, a maximized one only restores.
fn enabled_commands(maximized: bool, minimized: bool, resizable: bool) -> [(u32, bool); 5] {
    let normal = !maximized && !minimized;
    [
        (SC_RESTORE, maximized || minimized),
        (SC_MOVE, normal),
        (SC_SIZE, normal && resizable),
        (SC_MINIMIZE, !minimized),
        (SC_MAXIMIZE, !maximized && resizable),
    ]
}

/// Runs on the thread that owns the window, as `TrackPopupMenu` requires. Close
/// is handed back so the caller's close policy applies instead of WM_CLOSE.
pub fn show_system_menu(
    window: &Window,
    on_close: impl FnOnce() + Send + 'static,
) -> tauri::Result<()> {
    let raw = window.hwnd()?.0 as isize;
    let resizable = window.is_resizable().unwrap_or(false);
    window.run_on_main_thread(move || {
        let hwnd = HWND(raw as *mut _);
        match track_system_menu(hwnd, resizable) {
            Some(SC_CLOSE) => on_close(),
            Some(command) => {
                // SAFETY: `hwnd` belongs to a live window of this thread.
                let posted = unsafe {
                    PostMessageW(
                        Some(hwnd),
                        WM_SYSCOMMAND,
                        WPARAM(command as usize),
                        LPARAM(0),
                    )
                };
                if let Err(e) = posted {
                    log::warn!("system menu command failed: {e}");
                }
            }
            None => {}
        }
    })
}

fn track_system_menu(hwnd: HWND, resizable: bool) -> Option<u32> {
    // SAFETY: `hwnd` belongs to a live window of this thread; the system menu is
    // owned by that window and is not freed here.
    unsafe {
        let menu = GetSystemMenu(hwnd, false);
        if menu.is_invalid() {
            return None;
        }
        let states = enabled_commands(
            IsZoomed(hwnd).as_bool(),
            IsIconic(hwnd).as_bool(),
            resizable,
        );
        for (command, enabled) in states {
            let state = if enabled { MF_ENABLED } else { MF_GRAYED };
            let _ = EnableMenuItem(menu, command, MF_BYCOMMAND | state);
        }
        let _ = SetMenuDefaultItem(menu, SC_CLOSE, 0);
        let mut cursor = POINT::default();
        GetCursorPos(&mut cursor).ok()?;
        // Without this the menu does not dismiss on an outside click.
        let _ = SetForegroundWindow(hwnd);
        let picked = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            cursor.x,
            cursor.y,
            None,
            hwnd,
            None,
        );
        (picked.0 != 0).then_some(picked.0 as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled(maximized: bool, minimized: bool, resizable: bool, command: u32) -> bool {
        enabled_commands(maximized, minimized, resizable)
            .into_iter()
            .any(|(c, on)| c == command && on)
    }

    #[test]
    fn restored_window_moves_and_sizes_but_does_not_restore() {
        assert!(enabled(false, false, true, SC_MOVE));
        assert!(enabled(false, false, true, SC_SIZE));
        assert!(enabled(false, false, true, SC_MAXIMIZE));
        assert!(!enabled(false, false, true, SC_RESTORE));
    }

    #[test]
    fn maximized_window_only_restores_or_minimizes() {
        assert!(enabled(true, false, true, SC_RESTORE));
        assert!(enabled(true, false, true, SC_MINIMIZE));
        assert!(!enabled(true, false, true, SC_MOVE));
        assert!(!enabled(true, false, true, SC_MAXIMIZE));
    }

    #[test]
    fn fixed_dialog_never_offers_size_or_maximize() {
        assert!(!enabled(false, false, false, SC_SIZE));
        assert!(!enabled(false, false, false, SC_MAXIMIZE));
        assert!(enabled(false, false, false, SC_MOVE));
    }
}
