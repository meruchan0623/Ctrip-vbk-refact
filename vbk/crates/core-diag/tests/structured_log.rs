//! I-10a acceptance 2 (unknown keys are masked, with a counter-example),
//! the per-class field policies, the `diag_log!` macro end to end, and
//! acceptance 3's scanner over real rotated output.

use std::fs;
use std::path::PathBuf;

use core_diag::scan::scan_dir;
use core_diag::{
    account_tag, format_record, policy_of, render_field, slice_paths, Config, Level, Logger,
    ToValue, Value, ALLOW_LIST,
};

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("core-diag-it-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
}

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}

#[test]
fn unregistered_key_is_always_masked() {
    // Counter-example: a brand-new key nobody registered. Whatever the
    // value looks like, it must not appear.
    assert!(policy_of("customer_note_v2").is_none());
    for v in [
        s("张三 13812345678"),
        s("harmless"),
        s("1"),
        Value::Int(424242),
        Value::Bool(true),
    ] {
        let out = render_field("customer_note_v2", &v, "salt");
        assert_eq!(out, format!("<redacted:{}>", v.type_label()));
    }
    let line = format_record(
        0,
        Level::Info,
        "evt",
        "m",
        "t",
        &[
            ("brand_new_key", s("SECRET-VALUE")),
            ("count", Value::Int(3)),
        ],
        "salt",
    );
    assert!(!line.contains("SECRET-VALUE"));
    assert!(line.contains("brand_new_key=<redacted:str>"));
    assert!(line.contains("count=3"));
}

#[test]
fn every_registered_key_accepts_only_its_type() {
    for (key, _) in ALLOW_LIST {
        // A value of the wrong shape never passes through verbatim.
        let out = render_field(key, &s("not allowed: 13812345678 a@b.com"), "salt");
        assert!(
            !out.contains("13812345678") && !out.contains("a@b.com"),
            "{key}: {out}"
        );
    }
    // Names that are plainly sensitive are not registered.
    for k in [
        "name",
        "customer_name",
        "message",
        "content",
        "body",
        "text",
        "cookie",
        "ticket",
        "phone",
        "email",
        "password",
    ] {
        assert!(policy_of(k).is_none(), "{k} must not be allow-listed");
        assert!(render_field(k, &s("v"), "x").starts_with("<redacted:"));
    }
}

#[test]
fn per_class_policies() {
    // account -> 8 hex, stable, never the id.
    let a = render_field("account_id", &s("A-10086"), "salt");
    assert_eq!(a, account_tag("salt", "A-10086"));
    assert_eq!(a.len(), 8);
    assert!(!a.contains("10086"));
    assert_eq!(render_field("buid", &Value::Int(10086), "salt").len(), 8);
    // gid mask
    assert_eq!(render_field("gid", &s("1234567890123"), "x"), "12***23");
    // URL: query gone, host+path kept
    assert_eq!(
        render_field("url", &s("https://h.example.com/p/q?ticket=T0P&a=1"), "x"),
        "https://h.example.com/p/q"
    );
    // path: file name only
    assert_eq!(
        render_field("path", &s("/home/alice/.vbk/logs/vbk.log"), "x"),
        "<dir>/vbk.log"
    );
    assert_eq!(
        render_field("file", &s("C:\\Users\\Bob\\a.txt"), "x"),
        "<dir>/a.txt"
    );
    // ids: strict charset; anything odd is masked
    assert_eq!(render_field("msg_id", &s("m-123_4"), "x"), "m-123_4");
    assert_eq!(
        render_field("msg_id", &s("hello world"), "x"),
        "<redacted:str>"
    );
    assert_eq!(
        render_field("msg_id", &s("13812345678"), "x"),
        "<redacted:str>"
    );
    // ints / bools must really be ints / bools
    assert_eq!(render_field("count", &Value::Int(7), "x"), "7");
    assert_eq!(render_field("count", &s("7"), "x"), "<redacted:str>");
    assert_eq!(render_field("ok", &Value::Bool(false), "x"), "false");
    // free text: masked and bounded
    let t = render_field(
        "error",
        &s(&format!("fail ticket=ABC {}", "y".repeat(2000))),
        "x",
    );
    assert!(!t.contains("ABC") && t.chars().count() <= 512);
}

#[test]
fn macro_writes_masked_lines_and_scanner_finds_nothing() {
    let dir = temp_dir("macro");
    let mut cfg = Config::new(&dir);
    cfg.max_file_bytes = 2048;
    cfg.total_cap_bytes = 2048 * 4;
    cfg.salt = "test-salt".into();
    core_diag::init(&cfg).expect("init");

    let account = "acct-777".to_string();
    let url = "https://h.example.com/x?ticket=ABCDEF123";
    for i in 0..200u32 {
        core_diag::diag_log!(Level::Info, "sync.tick", {
            account_id = account,
            count = i,
            url = url,
            customer_name = "张三",
            note = "13812345678",
            gid = "98765432100123",
        });
    }
    core_diag::diag_log!(Level::Error, "net.fail", { error = "cookie: sid=abc123; boom", ok = false });
    core_diag::diag_log!(Level::Info, "plain");

    let slices = slice_paths(&dir, "vbk");
    assert!(slices.len() >= 2, "rotation happened: {slices:?}");
    let all: String = slices
        .iter()
        .map(|p| fs::read_to_string(p).expect("read"))
        .collect();
    assert!(all.contains(&format!(
        "account_id={}",
        account_tag("test-salt", &account)
    )));
    assert!(all.contains("customer_name=<redacted:str>"));
    assert!(all.contains("note=<redacted:str>"));
    assert!(all.contains("gid=98***23"));
    assert!(all.contains("url=https://h.example.com/x "));
    for secret in [
        "acct-777",
        "ABCDEF123",
        "张三",
        "13812345678",
        "sid=abc123",
        "98765432100123",
    ] {
        assert!(!all.contains(secret), "leaked {secret}");
    }
    assert!(all.contains("net.fail"));
    // Acceptance 3: the same scanner over every produced slice, zero hits.
    let report = scan_dir(&dir).expect("scan");
    assert!(report.files.len() >= 2);
    assert!(report.is_clean(), "{report:?}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn free_text_bridge_masks_and_truncates() {
    let dir = temp_dir("text");
    let logger = Logger::open(&Config::new(&dir)).expect("open");
    let long = format!("mobile 13812345678 mail a@b.com {}", "z".repeat(3000));
    logger.log_text(Level::Warn, "vbk_host::login", &long);
    let body = fs::read_to_string(dir.join("vbk.log")).expect("read");
    assert!(!body.contains("13812345678") && !body.contains("a@b.com"));
    assert!(body.lines().count() == 1);
    assert!(body.len() < 900, "bounded line: {}", body.len());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn to_value_only_for_plain_types() {
    assert_eq!(7u32.to_value(), Value::Int(7));
    assert_eq!("x".to_value(), Value::Str("x".into()));
    assert_eq!(String::from("y").to_value(), Value::Str("y".into()));
    assert_eq!(true.to_value(), Value::Bool(true));
}
