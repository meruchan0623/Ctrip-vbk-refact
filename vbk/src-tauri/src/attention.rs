//! 系统环境读数：全屏 / 演示 / 系统勿扰，以及把它们和“勿扰时段”一起喂给提醒核心
//! （`SystemState`）。按固定节奏轮询，设置变化时立即补一次。

use contracts::AppError;
use tauri::{AppHandle, Manager};

use crate::prefs;
use crate::state::HostState;

/// 操作系统当前的打扰状态。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OsAttention {
    /// 有其他应用占满整块屏幕。
    pub fullscreen: bool,
    pub presentation: bool,
    /// macOS 专注模式 / Windows 专注助手。
    pub quiet: bool,
}

pub fn read() -> OsAttention {
    imp::read()
}

/// 打开“跟随系统勿扰”前确认确实读得到系统状态，读不到就让开关如实失败。
pub fn ensure_follow_system_available() -> Result<(), AppError> {
    imp::focus_readable().map_err(|why| AppError::new("prefs.system_integration", why))
}

/// 把当前设置与 `os` 读数同步进提醒核心。
pub fn sync(app: &AppHandle, os: OsAttention) {
    let Some(dnd) = prefs::dnd_prefs(app) else {
        return;
    };
    app.state::<HostState>().apply_environment(
        dnd.schedule_enabled,
        dnd.follow_system && os.quiet,
        os.fullscreen,
        os.presentation,
    );
}

/// `Assertions.json` 里 `storeAssertionRecords` 非空即有手动开启的专注模式；
/// 无任何专注时该字段不存在。不是预期结构时返回 `None`。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn focus_active_from_assertions(bytes: &[u8]) -> Option<bool> {
    let root: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let data = root.get("data")?.as_array()?;
    Some(data.iter().any(|entry| {
        entry
            .get("storeAssertionRecords")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|records| !records.is_empty())
    }))
}

/// 窗口是否恰好盖满某块屏幕（x, y, w, h，全局坐标）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn covers_display(window: [f64; 4], displays: &[[f64; 4]]) -> bool {
    displays
        .iter()
        .any(|d| d.iter().zip(window).all(|(a, b)| (a - b).abs() < 1.0))
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;

    use super::{covers_display, focus_active_from_assertions, OsAttention};

    type CfRef = *const c_void;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CgRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    impl CgRect {
        fn parts(self) -> [f64; 4] {
            [self.x, self.y, self.width, self.height]
        }
    }

    const ON_SCREEN_ONLY: u32 = 1;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    const NULL_WINDOW: u32 = 0;
    const CF_NUMBER_SINT32: isize = 3;
    const CF_NUMBER_FLOAT64: isize = 6;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        static kCGWindowLayer: CfRef;
        static kCGWindowBounds: CfRef;
        static kCGWindowOwnerPID: CfRef;
        static kCGWindowAlpha: CfRef;
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CfRef;
        fn CGRectMakeWithDictionaryRepresentation(dict: CfRef, rect: *mut CgRect) -> bool;
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayBounds(display: u32) -> CgRect;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: CfRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CfRef, index: isize) -> CfRef;
        fn CFDictionaryGetValue(dict: CfRef, key: CfRef) -> CfRef;
        fn CFNumberGetValue(number: CfRef, kind: isize, out: *mut c_void) -> bool;
        fn CFRelease(value: CfRef);
    }

    fn displays() -> Vec<[f64; 4]> {
        let mut ids = [0u32; 16];
        let mut count = 0u32;
        // SAFETY: 缓冲区长度与传入的 max 一致，count 由系统写入且不超过 max。
        let status = unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
        if status != 0 {
            return Vec::new();
        }
        ids[..count.min(16) as usize]
            .iter()
            // SAFETY: id 来自上面的活动显示器列表。
            .map(|id| unsafe { CGDisplayBounds(*id) }.parts())
            .collect()
    }

    /// SAFETY: `dict` 必须是有效的 CFDictionary，`key` 必须是有效的 CFString。
    unsafe fn number<T: Default>(dict: CfRef, key: CfRef, kind: isize) -> Option<T> {
        let value = CFDictionaryGetValue(dict, key);
        if value.is_null() {
            return None;
        }
        let mut out = T::default();
        CFNumberGetValue(value, kind, (&mut out as *mut T).cast()).then_some(out)
    }

    /// 只看本屏当前空间：其他应用的普通层窗口恰好盖满整块屏幕，才算全屏。
    /// 这里只取几何信息，不需要屏幕录制权限。
    fn other_app_fullscreen() -> bool {
        let displays = displays();
        let own_pid = std::process::id() as i32;
        // SAFETY: 所有 CF 对象都来自系统调用并在本函数内使用；copy 出的列表最后释放。
        unsafe {
            let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, NULL_WINDOW);
            if list.is_null() {
                return false;
            }
            let mut found = false;
            for i in 0..CFArrayGetCount(list) {
                let dict = CFArrayGetValueAtIndex(list, i);
                if number::<i32>(dict, kCGWindowLayer, CF_NUMBER_SINT32) != Some(0)
                    || number::<i32>(dict, kCGWindowOwnerPID, CF_NUMBER_SINT32) == Some(own_pid)
                    || number::<f64>(dict, kCGWindowAlpha, CF_NUMBER_FLOAT64).unwrap_or(0.0) <= 0.0
                {
                    continue;
                }
                let bounds = CFDictionaryGetValue(dict, kCGWindowBounds);
                let mut rect = CgRect::default();
                if !bounds.is_null()
                    && CGRectMakeWithDictionaryRepresentation(bounds, &mut rect)
                    && covers_display(rect.parts(), &displays)
                {
                    found = true;
                    break;
                }
            }
            CFRelease(list);
            found
        }
    }

    fn assertions() -> std::io::Result<Vec<u8>> {
        let home = std::env::var_os("HOME").unwrap_or_default();
        std::fs::read(std::path::Path::new(&home).join("Library/DoNotDisturb/DB/Assertions.json"))
    }

    pub fn read() -> OsAttention {
        OsAttention {
            fullscreen: other_app_fullscreen(),
            presentation: false,
            quiet: assertions()
                .ok()
                .and_then(|bytes| focus_active_from_assertions(&bytes))
                .unwrap_or(false),
        }
    }

    pub fn focus_readable() -> Result<(), String> {
        let unreadable = || {
            "无法读取 macOS 专注模式状态，请在“系统设置 → 隐私与安全性 → 完全磁盘访问权限”中允许本应用后重试"
                .to_string()
        };
        let bytes = assertions().map_err(|_| unreadable())?;
        focus_active_from_assertions(&bytes)
            .map(|_| ())
            .ok_or_else(unreadable)
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use windows::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_QUIET_TIME,
        QUNS_RUNNING_D3D_FULL_SCREEN,
    };

    use super::OsAttention;

    pub fn read() -> OsAttention {
        // SAFETY: 无参数的只读系统查询。
        let Ok(state) = (unsafe { SHQueryUserNotificationState() }) else {
            return OsAttention::default();
        };
        OsAttention {
            fullscreen: state == QUNS_BUSY || state == QUNS_RUNNING_D3D_FULL_SCREEN,
            presentation: state == QUNS_PRESENTATION_MODE,
            quiet: state == QUNS_QUIET_TIME,
        }
    }

    pub fn focus_readable() -> Result<(), String> {
        // SAFETY: 同上。
        unsafe { SHQueryUserNotificationState() }
            .map(|_| ())
            .map_err(|_| "无法读取 Windows 专注助手状态".to_string())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::OsAttention;

    pub fn read() -> OsAttention {
        OsAttention::default()
    }

    pub fn focus_readable() -> Result<(), String> {
        Err("当前系统不支持跟随系统勿扰".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_is_active_only_with_assertion_records() {
        let parse = |v: serde_json::Value| focus_active_from_assertions(v.to_string().as_bytes());
        assert_eq!(
            parse(serde_json::json!({"data":[{"storeAssertionRecords":[{"x":1}]}]})),
            Some(true)
        );
        assert_eq!(
            parse(serde_json::json!({"data":[{"storeInvalidationRecords":[{}]}]})),
            Some(false)
        );
        assert_eq!(
            parse(serde_json::json!({"data":[{"storeAssertionRecords":[]}]})),
            Some(false)
        );
        assert_eq!(parse(serde_json::json!({"nope":1})), None);
        assert_eq!(focus_active_from_assertions(b"{broken"), None);
    }

    #[test]
    fn only_an_exact_display_cover_counts_as_fullscreen() {
        let displays = [[0.0, 0.0, 1512.0, 982.0], [1512.0, 0.0, 2560.0, 1440.0]];
        assert!(covers_display([0.0, 0.0, 1512.0, 982.0], &displays));
        assert!(covers_display([1512.0, 0.0, 2560.0, 1440.0], &displays));
        // 普通最大化窗口让出了菜单栏，不算全屏。
        assert!(!covers_display([0.0, 37.0, 1512.0, 945.0], &displays));
        assert!(!covers_display([0.0, 0.0, 1512.0, 982.0], &[]));
    }

    #[test]
    fn reading_the_real_system_state_does_not_panic() {
        let _ = read();
    }
}
