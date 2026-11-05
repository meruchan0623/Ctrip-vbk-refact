//! Local UTC offset of the OS time zone (east positive, minutes).
//!
//! `std` has no zone API and the host carries no date crate, so the two
//! platform calls are declared directly. Only used to find the next local 08:00
//! for "勿扰至明天"; any failure degrades to UTC (0), never a panic.

/// Offset in effect at `utc_ms` (Unix milliseconds).
pub fn local_utc_offset_minutes(utc_ms: i64) -> i32 {
    imp::offset_minutes(utc_ms.div_euclid(1000)).unwrap_or(0)
}

#[cfg(windows)]
mod imp {
    #[repr(C)]
    struct SystemTime([u16; 8]);

    #[repr(C)]
    struct TimeZoneInformation {
        bias: i32,
        standard_name: [u16; 32],
        standard_date: SystemTime,
        standard_bias: i32,
        daylight_name: [u16; 32],
        daylight_date: SystemTime,
        daylight_bias: i32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetTimeZoneInformation(info: *mut TimeZoneInformation) -> u32;
    }

    // The Win32 call reports the zone in force *now*; for a DND edge that is
    // the offset we want.
    pub fn offset_minutes(_unix_s: i64) -> Option<i32> {
        let mut info = TimeZoneInformation {
            bias: 0,
            standard_name: [0; 32],
            standard_date: SystemTime([0; 8]),
            standard_bias: 0,
            daylight_name: [0; 32],
            daylight_date: SystemTime([0; 8]),
            daylight_bias: 0,
        };
        // SAFETY: `info` is a live repr(C) TIME_ZONE_INFORMATION (172 bytes).
        let kind = unsafe { GetTimeZoneInformation(&mut info) };
        let extra = match kind {
            1 => info.standard_bias,
            2 => info.daylight_bias,
            0 => 0,
            _ => return None, // TIME_ZONE_ID_INVALID
        };
        // UTC = local + (Bias + extra)  =>  local offset = -(Bias + extra)
        Some(-(info.bias + extra))
    }
}

#[cfg(unix)]
mod imp {
    use std::ffi::{c_char, c_int, c_long};

    #[repr(C)]
    struct Tm {
        tm_sec: c_int,
        tm_min: c_int,
        tm_hour: c_int,
        tm_mday: c_int,
        tm_mon: c_int,
        tm_year: c_int,
        tm_wday: c_int,
        tm_yday: c_int,
        tm_isdst: c_int,
        tm_gmtoff: c_long,
        tm_zone: *const c_char,
    }

    extern "C" {
        fn localtime_r(time: *const i64, out: *mut Tm) -> *mut Tm;
    }

    pub fn offset_minutes(unix_s: i64) -> Option<i32> {
        let mut tm = Tm {
            tm_sec: 0,
            tm_min: 0,
            tm_hour: 0,
            tm_mday: 0,
            tm_mon: 0,
            tm_year: 0,
            tm_wday: 0,
            tm_yday: 0,
            tm_isdst: 0,
            tm_gmtoff: 0,
            tm_zone: std::ptr::null(),
        };
        // SAFETY: both pointers are live for the call; `Tm` matches the
        // glibc/BSD/macOS `struct tm` layout on 64-bit targets.
        let r = unsafe { localtime_r(&unix_s, &mut tm) };
        if r.is_null() {
            return None;
        }
        i32::try_from(tm.tm_gmtoff / 60).ok()
    }
}

#[cfg(not(any(windows, unix)))]
mod imp {
    pub fn offset_minutes(_unix_s: i64) -> Option<i32> {
        None
    }
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn offset_is_sane() {
        let m = super::local_utc_offset_minutes(1_700_000_000_000);
        assert!((-14 * 60..=14 * 60).contains(&m));
    }
}
