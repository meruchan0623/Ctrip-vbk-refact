//! Adversarial counter-examples found in review: every sample here leaked (or
//! was judged clean) before the fix it documents. Same contract as
//! `redaction_corpus.rs`: the secret is gone after masking, the scanner
//! flags the original, finds nothing in the masked text, and the mask is
//! idempotent.

use core_diag::export::{prepare_bundle, Candidate, Exclusion, DEFAULT_MAX_FILE_BYTES};
use core_diag::scan::{scan_bytes, scan_text};
use core_diag::{mask_text, sanitize_text, Kind};

fn check(kind: Kind, text: &str, secret: &str) {
    assert!(text.contains(secret), "bad fixture: {text}");
    let (masked, n) = mask_text(text);
    assert!(n >= 1, "{kind:?} not detected: {text}");
    assert!(
        !masked.contains(secret),
        "{kind:?} leaked: {text} -> {masked}"
    );
    let hits = scan_text(text);
    assert!(
        hits.iter().any(|f| f.kind == kind),
        "{kind:?} not reported for: {text} (got {hits:?})"
    );
    assert!(
        scan_text(&masked).is_empty(),
        "masked text still hits: {text} -> {masked}"
    );
    assert_eq!(
        mask_text(&masked).0,
        masked,
        "mask not idempotent: {masked}"
    );
    assert!(
        !sanitize_text(text).contains(secret),
        "sanitize_text leaked"
    );
}

#[test]
fn home_directory_itself_never_shows_the_user_name() {
    // Before: `<dir>/alice` (the "file name" was the user name).
    for (t, s) in [
        ("cwd=/home/alice", "alice"),
        ("cwd=/home/alice/", "alice"),
        ("HOME=/Users/zhangsan", "zhangsan"),
        ("profile C:\\Users\\Bob", "Bob"),
        ("profile C:\\Users\\Zhang San\\", "Zhang San"),
        ("\\\\srv\\Users\\carol", "carol"),
    ] {
        check(Kind::HomePath, t, s);
    }
}

#[test]
fn file_name_kept_from_a_path_is_itself_masked() {
    // Before: `<dir>/13812345678.txt` leaked a phone number through the
    // single masking pass (the scanner then disagreed with the masker).
    check(
        Kind::HomePath,
        "saved /home/bob/13812345678.txt",
        "13812345678",
    );
    check(
        Kind::HomePath,
        "C:\\Users\\Bob\\Desktop\\110101199003074321.pdf",
        "110101199003074321",
    );
    check(Kind::HomePath, "~/a@b.com.eml", "a@b.com");
}

#[test]
fn unc_paths_are_home_paths() {
    for (t, s) in [
        ("open \\\\fileserver\\home$\\bob\\x.log", "bob"),
        ("\\\\?\\C:\\Users\\Carol\\a.txt", "Carol"),
        ("\\\\10.0.0.5\\share\\Users\\dave\\y.txt", "dave"),
    ] {
        check(Kind::HomePath, t, s);
    }
}

#[test]
fn credential_keys_after_dash_or_dot_prefix() {
    // Before: `--password=x` was never recognised because the identifier
    // scanner refused to start right after `-` / `.`.
    for (t, s) in [
        ("spawn --password=hunter2hunter2", "hunter2hunter2"),
        ("-ticket=AbCdEf0123", "AbCdEf0123"),
        (".token=zzzz1111yyyy", "zzzz1111yyyy"),
        ("args: [--api-key=sk_live_51Habcdef]", "sk_live_51Habcdef"),
    ] {
        check(Kind::Ticket, t, s);
    }
}

#[test]
fn percent_encoded_separators() {
    for (t, s) in [
        ("body=user%3Dx%26ticket%3DAbCdEf0123%26v%3D1", "AbCdEf0123"),
        ("ticket%3dlower9876", "lower9876"),
        ("password%3Ahunter2hunter2", "hunter2hunter2"),
    ] {
        check(Kind::Ticket, t, s);
    }
}

#[test]
fn phone_with_leading_zero_country_code() {
    check(Kind::Phone, "dial 008613812345678", "13812345678");
    check(Kind::Phone, "86-13812345678", "13812345678");
}

#[test]
fn chinese_order_phrases() {
    for (t, s) in [
        ("订单号为1234567890123", "1234567890123"),
        ("订单（9876543210）已取消", "9876543210"),
        ("订单[20240101123456]", "20240101123456"),
    ] {
        check(Kind::Order, t, s);
    }
}

#[test]
fn nineteen_digit_message_ids_are_not_orders_or_ids() {
    // msgId (19 digits) without an order keyword must not be masked, and an
    // order keyword nearby must not swallow an unrelated 19-digit id.
    let (m, n) = mask_text("msg_id=1234567890123456789 ack");
    assert_eq!(n, 0, "{m}");
    let (m, n) = mask_text("order sync done, msg 1234567890123456789");
    assert_eq!(n, 0, "{m}");
}

#[test]
fn scanner_sees_through_utf16_and_sniffs_archives() {
    // UTF-16LE log without BOM: NUL-interleaved ASCII.
    let utf16: Vec<u8> = "phone 13812345678\n"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let r = scan_bytes("win.log", &utf16);
    assert!(!r.is_clean(), "UTF-16 without BOM judged clean");
    assert!(r.findings.iter().any(|f| f.kind == Kind::Phone));
    // UTF-16LE with BOM and CJK content.
    let mut bom = vec![0xff, 0xfe];
    bom.extend(
        "订单号1234567890123\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes),
    );
    let r = scan_bytes("win.txt", &bom);
    assert!(r.findings.iter().any(|f| f.kind == Kind::Order), "{r:?}");
    // UTF-16BE with BOM.
    let mut be = vec![0xfe, 0xff];
    be.extend("mail a@b.com\n".encode_utf16().flat_map(u16::to_be_bytes));
    assert!(!scan_bytes("be.log", &be).is_clean());
    // gzip content under an innocent name is never "clean".
    let r = scan_bytes("vbk.1", &[0x1f, 0x8b, 0x08, 0x00, 1, 2, 3]);
    assert!(r.unscannable.is_some() && !r.is_clean());
    let r = scan_bytes("notes.txt", b"PK\x03\x04rest");
    assert!(r.unscannable.is_some());
    // a plain text file with the same letters is still scanned normally
    assert!(scan_bytes("notes.txt", b"PK is fine").is_clean());
}

#[test]
fn export_masks_nul_interleaved_text_instead_of_shipping_it() {
    let utf16: Vec<u8> = "customer 13812345678 called\n"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let b = prepare_bundle(
        vec![Candidate {
            name: "win.log".into(),
            bytes: utf16,
        }],
        DEFAULT_MAX_FILE_BYTES,
    );
    for (_, body) in &b.files {
        assert!(!body.contains("13812345678"), "exported: {body:?}");
        assert!(!body.contains('\0'));
    }
    if let Some(e) = b.manifest.excluded.first() {
        assert!(matches!(e.reason, Exclusion::NotUtf8), "{e:?}");
    } else {
        assert_eq!(b.manifest.included[0].redactions, 1);
    }
}

#[test]
fn truncation_never_splits_a_multibyte_char() {
    let s = format!("{}{}", "a".repeat(511), "界".repeat(10));
    let out = sanitize_text(&s);
    assert_eq!(out.chars().count(), 512);
    assert!(out.ends_with('界'));
    let s = format!("ticket=SECRET{}", "界".repeat(70_000));
    assert!(!sanitize_text(&s).contains("SECRET"));
}
