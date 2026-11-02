//! I-10a acceptance 1: every sensitive class has >= 10 samples (incl. URL
//! query and home-directory paths) and 100% are masked. Each sample is
//! `(text, secret)`: after masking `secret` must be gone, the scanner must
//! flag the original with the expected kind, and must find nothing in the
//! masked text (so masker and scanner can never disagree).

use core_diag::scan::scan_text;
use core_diag::{mask_text, sanitize_text, Kind};

fn check(kind: Kind, samples: &[(&str, &str)]) {
    assert!(samples.len() >= 10, "{kind:?}: need >= 10 samples");
    for (text, secret) in samples {
        assert!(text.contains(secret), "bad fixture: {text}");
        let (masked, n) = mask_text(text);
        assert!(n >= 1, "{kind:?} not detected: {text}");
        assert!(!masked.contains(secret), "{kind:?} leaked: {masked}");
        let hits = scan_text(text);
        assert!(
            hits.iter().any(|f| f.kind == kind),
            "{kind:?} not reported for: {text} (got {hits:?})"
        );
        assert!(
            hits.iter().all(|f| !f.excerpt.contains(secret)),
            "excerpt leaked secret"
        );
        assert!(
            scan_text(&masked).is_empty(),
            "masked text still hits: {masked}"
        );
        assert_eq!(
            mask_text(&masked).0,
            masked,
            "mask not idempotent: {masked}"
        );
        let free = sanitize_text(text);
        assert!(!free.contains(secret), "sanitize_text leaked: {free}");
    }
}

#[test]
fn ticket_samples() {
    check(
        Kind::Ticket,
        &[
            ("ticket=AbCdEf0123456789", "AbCdEf0123456789"),
            (
                "GET /restapi/soa2/12345/getX?ticket=ZZ99ZZ99&x=1",
                "ZZ99ZZ99",
            ),
            ("{\"ticket\":\"tk_7f3a9c21d4\"}", "tk_7f3a9c21d4"),
            ("ctripTicket: 5E8B0C1D2F3A4B5C", "5E8B0C1D2F3A4B5C"),
            ("access_token=eyAAAA.BBBB.CCCC", "eyAAAA.BBBB.CCCC"),
            ("grant Bearer 0123456789abcdef", "0123456789abcdef"),
            (
                "auth failed, Bearer abcdefgh12345678 rejected",
                "abcdefgh12345678",
            ),
            ("password=hunter2hunter2", "hunter2hunter2"),
            ("pwd: 's3cr3t-value'", "s3cr3t-value"),
            ("client_secret=sk_live_51Habcdef", "sk_live_51Habcdef"),
            ("session_id=9a8b7c6d5e4f", "9a8b7c6d5e4f"),
            (
                "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.sig_abcDEF12345 end",
                "eyJzdWIiOiIxMjM0NSJ9",
            ),
            ("login https://user:p4ssw0rd@host.example.com/a", "p4ssw0rd"),
            ("x-csrf-token=Q1W2E3R4T5Y6", "Q1W2E3R4T5Y6"),
        ],
    );
}

#[test]
fn cookie_samples() {
    check(
        Kind::Cookie,
        &[
            ("Cookie: sid=abc123; uid=xyz789; _bfa=1.2.3", "sid=abc123"),
            ("cookie=GUID=09ABCDEF; Union=OUID=x", "GUID=09ABCDEF"),
            ("Set-Cookie: ctoken=ZXCV1234; Path=/; HttpOnly", "ZXCV1234"),
            ("\"cookie\":\"a=1; b=2; c=3\"", "a=1; b=2; c=3"),
            ("Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"),
            (
                "authorization=Digest username=\"u\", response=\"r\"",
                "Digest username",
            ),
            ("request cookie: _fpa=zzzz1111; _ga=GA1.2.3", "zzzz1111"),
            ("cookieStr=login=1; ticket9=abcd", "login=1"),
            ("Cookie:   JSESSIONID=ABCDEF0123456789", "ABCDEF0123456789"),
            ("set-cookie: session=s%3Aabc.def; Secure", "s%3Aabc.def"),
            ("cookie: x=y", "x=y"),
        ],
    );
}

#[test]
fn phone_samples() {
    check(
        Kind::Phone,
        &[
            ("customer 13812345678 called", "13812345678"),
            ("tel:15900001111", "15900001111"),
            ("手机号18611112222已绑定", "18611112222"),
            ("+8613712340000", "13712340000"),
            ("call 138-1234-5678 now", "138-1234-5678"),
            ("call 139 8765 4321 now", "139 8765 4321"),
            ("phone=17700008888;", "17700008888"),
            ("{\"mobile\":\"19912345678\"}", "19912345678"),
            ("联系人 13500135000，备注", "13500135000"),
            ("to 14712345678.", "14712345678"),
            ("16688887777", "16688887777"),
            ("(18012345678)", "18012345678"),
        ],
    );
}

#[test]
fn order_samples() {
    check(
        Kind::Order,
        &[
            ("订单号1234567890123", "1234567890123"),
            ("订单号：9876543210", "9876543210"),
            ("订单编号 20240101123456", "20240101123456"),
            ("orderId=1122334455667788", "1122334455667788"),
            ("{\"orderId\":\"5544332211\"}", "5544332211"),
            ("order_no: 99887766", "99887766"),
            ("Order 10203040506070 refunded", "10203040506070"),
            ("order number 7000123456", "7000123456"),
            ("订单 8123456789 超时", "8123456789"),
            ("oid=3141592653589", "3141592653589"),
            ("order id: 1357924680", "1357924680"),
        ],
    );
}

#[test]
fn email_samples() {
    check(
        Kind::Email,
        &[
            ("mail a@b.com", "a@b.com"),
            (
                "user.name+tag@example.co.uk sent",
                "user.name+tag@example.co.uk",
            ),
            ("to=<zhang_san@ctrip.com>", "zhang_san@ctrip.com"),
            ("\"email\":\"li.si@qq.com\"", "li.si@qq.com"),
            ("wang5@163.com,", "wang5@163.com"),
            (
                "From: Zhao <zhao-liu@sub.domain.org>",
                "zhao-liu@sub.domain.org",
            ),
            ("客户邮箱 test123@gmail.com 已验证", "test123@gmail.com"),
            ("x@y.io.", "x@y.io"),
            ("first.last@company-name.com", "first.last@company-name.com"),
            (
                "bounce: MAILER-DAEMON@mx1.mail.example.net",
                "MAILER-DAEMON@mx1.mail.example.net",
            ),
        ],
    );
}

#[test]
fn id_card_samples() {
    check(
        Kind::IdCard,
        &[
            ("身份证 110101199003074321", "110101199003074321"),
            ("id=11010119900307432X", "11010119900307432X"),
            ("id=11010119900307432x ok", "11010119900307432x"),
            ("310104198512120011", "310104198512120011"),
            ("证件号：440305200001019876", "440305200001019876"),
            ("{\"idNo\":\"320102197001015555\"}", "320102197001015555"),
            ("510107199912314444 (cardholder)", "510107199912314444"),
            ("420106198806061234.", "420106198806061234"),
            ("130102 old 130102800101123 end", "130102800101123"),
            ("证件 610113200205203210 已核验", "610113200205203210"),
            ("330106196511111111", "330106196511111111"),
        ],
    );
}

#[test]
fn url_query_samples() {
    check(
        Kind::UrlQuery,
        &[
            (
                "GET https://vbk.ctrip.com/restapi/soa2/1/x?ticket=AAA111 200",
                "ticket=AAA111",
            ),
            ("https://a.example.com/p?uid=777&sig=zz", "uid=777"),
            (
                "open https://a.example.com/p#access=abc123",
                "access=abc123",
            ),
            ("http://127.0.0.1:8080/cb?code=0xDEAD", "code=0xDEAD"),
            ("wss://im.example.com/ws?token=qwerty12345", "qwerty12345"),
            ("url=\"https://x.com/a/b?c=d\"", "c=d"),
            ("redirect https://x.com/?next=/home/bob/secret.txt", "next="),
            ("https://x.com/a?b=1&c=2&d=3", "b=1&c=2&d=3"),
            ("(https://x.com/a?u=Zhang)", "u=Zhang"),
            ("https://x.com/img.png?w=100&h=100", "w=100"),
            ("see https://x.com/a/b/c?lang=zh-CN.", "lang=zh-CN"),
            ("https://x.com/a?x=1 and https://y.com/b?y=2", "y=2"),
        ],
    );
    // URL still identifies host and path after masking.
    let (m, _) = mask_text("https://vbk.ctrip.com/restapi/soa2/1/x?ticket=AAA111");
    assert_eq!(m, "https://vbk.ctrip.com/restapi/soa2/1/x");
}

#[test]
fn home_path_samples() {
    check(
        Kind::HomePath,
        &[
            ("open /home/alice/.config/vbk/state.json failed", "alice"),
            (
                "/Users/zhangsan/Library/Application Support/vbk/x.db",
                "zhangsan",
            ),
            ("C:\\Users\\Bob\\AppData\\Roaming\\vbk\\a.log", "Bob"),
            ("path=C:/Users/lisi/Desktop/export.txt", "lisi"),
            ("\"file\":\"/Users/wang wu/Documents/a.txt\"", "wang wu"),
            (
                "C:\\Users\\Zhang San\\AppData\\Local\\vbk\\b.log",
                "Zhang San",
            ),
            ("read ~/Downloads/orders.csv", "Downloads"),
            ("cwd=/root/work/vbk", "work"),
            ("(see /home/carol/vbk/crash.dump)", "carol"),
            ("D:\\data\\客户资料\\a.xlsx", "客户资料"),
            ("log at /home/dave/.vbk/logs/vbk.1.log.", "dave"),
            ("e:/Users/eve/x.txt", "eve"),
        ],
    );
    let (m, _) = mask_text("open /home/alice/.config/vbk/state.json failed");
    assert_eq!(m, "open <dir>/state.json failed");
}

#[test]
fn clean_text_is_untouched() {
    for s in [
        "event=sync.done count=42 duration_ms=1800",
        "ts 1700000000123 ok",
        "GET /restapi/soa2/12405/getCurrentUserInfo 200",
        "token bucket refilled",
        "the order of events",
        "界面加载完成 共3条",
    ] {
        assert_eq!(mask_text(s), (s.to_string(), 0), "over-masked: {s}");
    }
}
