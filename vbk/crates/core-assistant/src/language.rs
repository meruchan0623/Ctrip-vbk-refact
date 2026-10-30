//! Customer language suggestion by script heuristics (plan AST-05, archive
//! 09-assistant §4.7). A suggestion only: the user's manual target language
//! always wins, and low confidence must not override it.

/// Languages the suggestion can produce, mapped to TSim `target_lang`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lang {
    Zh,
    Ja,
    Ko,
    Th,
    Ru,
    Ar,
    En,
}

impl Lang {
    pub fn as_tsim_target(self) -> &'static str {
        match self {
            Lang::Zh => "zh",
            Lang::Ja => "ja",
            Lang::Ko => "ko",
            Lang::Th => "th",
            Lang::Ru => "ru",
            Lang::Ar => "ar",
            Lang::En => "en",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Confidence {
    /// Fewer than 4 letters of the deciding script.
    Low,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LanguageSuggestion {
    pub lang: Lang,
    pub confidence: Confidence,
}

fn is_han(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x20000..=0x2A6DF | 0xF900..=0xFAFF | 0x3005 | 0x3007)
}

fn is_kana(c: char) -> bool {
    matches!(c as u32, 0x3041..=0x309F | 0x30A0..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9F)
}

fn is_hangul(c: char) -> bool {
    matches!(c as u32, 0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F)
}

fn is_thai(c: char) -> bool {
    matches!(c as u32, 0x0E01..=0x0E3A | 0x0E40..=0x0E4E)
}

fn is_cyrillic(c: char) -> bool {
    matches!(c as u32, 0x0400..=0x052F)
}

fn is_arabic(c: char) -> bool {
    matches!(c as u32, 0x0600..=0x06FF | 0x0750..=0x077F | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF)
}

fn is_latin(c: char) -> bool {
    c.is_ascii_alphabetic() || matches!(c as u32, 0x00C0..=0x024F | 0x1E00..=0x1EFF)
}

/// Script-presence heuristic. Priority: Kana → ja, Hangul → ko, Thai → th,
/// Arabic → ar, Cyrillic → ru, Han → zh, Latin → en. Mixed Chinese/English
/// therefore reads as zh. Returns `None` when the text has no letters
/// (digits, emoji, punctuation only).
pub fn suggest_language(text: &str) -> Option<LanguageSuggestion> {
    let (mut kana, mut hangul, mut thai, mut arabic, mut cyrillic, mut han, mut latin) =
        (0, 0, 0, 0, 0, 0, 0);
    for c in text.chars() {
        if is_kana(c) {
            kana += 1;
        } else if is_hangul(c) {
            hangul += 1;
        } else if is_thai(c) {
            thai += 1;
        } else if is_arabic(c) {
            arabic += 1;
        } else if is_cyrillic(c) {
            cyrillic += 1;
        } else if is_han(c) {
            han += 1;
        } else if is_latin(c) {
            latin += 1;
        }
    }
    let (lang, count) = if kana > 0 {
        (Lang::Ja, kana + han)
    } else if hangul > 0 {
        (Lang::Ko, hangul)
    } else if thai > 0 {
        (Lang::Th, thai)
    } else if arabic > 0 {
        (Lang::Ar, arabic)
    } else if cyrillic > 0 {
        (Lang::Ru, cyrillic)
    } else if han > 0 {
        (Lang::Zh, han)
    } else if latin > 0 {
        (Lang::En, latin)
    } else {
        return None;
    };
    let confidence = if count >= 4 {
        Confidence::High
    } else {
        Confidence::Low
    };
    Some(LanguageSuggestion { lang, confidence })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lang(t: &str) -> Option<Lang> {
        suggest_language(t).map(|s| s.lang)
    }

    #[test]
    fn scripts() {
        assert_eq!(lang("こんにちは、予約したいです"), Some(Lang::Ja));
        assert_eq!(lang("東京に行きます"), Some(Lang::Ja), "kana wins over han");
        assert_eq!(lang("안녕하세요 예약하고 싶어요"), Some(Lang::Ko));
        assert_eq!(lang("สวัสดีครับ"), Some(Lang::Th));
        assert_eq!(lang("Здравствуйте, хочу забронировать"), Some(Lang::Ru));
        assert_eq!(lang("مرحبا"), Some(Lang::Ar));
        assert_eq!(lang("你好，我想预订门票"), Some(Lang::Zh));
        assert_eq!(lang("Hello, I want to book tickets"), Some(Lang::En));
        assert_eq!(
            lang("Xin chào, tôi muốn đặt vé"),
            Some(Lang::En),
            "latin fallback"
        );
        assert_eq!(
            lang("订单 order 12345 OK"),
            Some(Lang::Zh),
            "mixed zh/en reads as zh"
        );
        assert_eq!(lang("12345 😀 !!!"), None);
        assert_eq!(lang(""), None);
    }

    #[test]
    fn confidence_and_mapping() {
        let s = suggest_language("ok").expect("latin");
        assert_eq!(s.confidence, Confidence::Low);
        let s = suggest_language("okay then").expect("latin");
        assert_eq!(s.confidence, Confidence::High);
        assert_eq!(
            suggest_language("好").map(|s| s.confidence),
            Some(Confidence::Low)
        );
        assert_eq!(Lang::Ja.as_tsim_target(), "ja");
        for l in [
            Lang::Zh,
            Lang::Ja,
            Lang::Ko,
            Lang::Th,
            Lang::Ru,
            Lang::Ar,
            Lang::En,
        ] {
            assert!(crate::translate::is_supported_target(l.as_tsim_target()));
        }
    }
}
