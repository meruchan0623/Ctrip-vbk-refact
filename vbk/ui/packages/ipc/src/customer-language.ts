import type { UiConversation, UiMessage } from './client.ts';

const HAN = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * 文字脚本启发式（与 core-assistant `suggest_language` 同序）：假名→ja、谚文→ko、
 * 泰文→th、阿拉伯文→ar、西里尔文→ru、汉字→zh、拉丁字母→en。中文至少 2 字，其它至少 4 字；更短时视为低置信。
 */
export function suggestLanguage(text: string): string | null {
  let kana = 0, hangul = 0, thai = 0, arabic = 0, cyrillic = 0, han = 0, latin = 0;
  for (const ch of text.replace(/https?:\/\/\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]+|\b[A-Za-z]*\d[\w-]*\b/g, '')) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3041 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF) || (c >= 0xFF66 && c <= 0xFF9F)) kana++;
    else if ((c >= 0xAC00 && c <= 0xD7AF) || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F) || (c >= 0xA960 && c <= 0xA97F)) hangul++;
    else if ((c >= 0x0E01 && c <= 0x0E3A) || (c >= 0x0E40 && c <= 0x0E4E)) thai++;
    else if ((c >= 0x0600 && c <= 0x06FF) || (c >= 0x0750 && c <= 0x077F) || (c >= 0xFB50 && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF)) arabic++;
    else if (c >= 0x0400 && c <= 0x052F) cyrillic++;
    else if (HAN.test(ch) || c === 0x3005 || c === 0x3007 || (c >= 0x20000 && c <= 0x2A6DF)) han++;
    else if ((c < 0x80 && /[A-Za-z]/.test(ch)) || (c >= 0x00C0 && c <= 0x024F) || (c >= 0x1E00 && c <= 0x1EFF)) latin++;
  }
  const [lang, count] = kana > 0 ? ['ja', kana + han] : hangul > 0 ? ['ko', hangul] : thai > 0 ? ['th', thai] : arabic > 0 ? ['ar', arabic] : cyrillic > 0 ? ['ru', cyrillic] : han > 0 ? ['zh', han] : latin > 0 ? ['en', latin] : [null, 0];
  return lang !== null && count >= (lang === 'zh' ? 2 : 4) ? lang : null;
}

/** 识别时最多回看的客户文字消息条数。 */
export const LANGUAGE_SCAN_LIMIT = 5;

type LanguageMessage = Pick<UiMessage, 'sender_role' | 'kind' | 'text'>;
// Cache only script evidence: the conversation's fallback language may change
// independently of the immutable message snapshot.
const scriptLanguages = new WeakMap<readonly LanguageMessage[], string | null>();
const LATIN_LANGUAGES = new Set(['en', 'fr', 'de', 'es', 'pt', 'it', 'vi', 'id', 'ms', 'tr', 'nl', 'pl']);

function scriptLanguage(messages: readonly LanguageMessage[]): string | null {
  if (scriptLanguages.has(messages)) return scriptLanguages.get(messages)!;
  let seen = 0;
  let result: string | null = null;
  for (let i = messages.length - 1; i >= 0 && seen < LANGUAGE_SCAN_LIMIT; i--) {
    const m = messages[i]!;
    if (m.sender_role !== 'customer' || m.kind !== 'text' || !m.text) continue;
    seen++;
    result = suggestLanguage(m.text);
    if (result !== null) break;
  }
  scriptLanguages.set(messages, result);
  return result;
}

/**
 * 会话的有效客户语言。官方行的 `languageInfo.lang / ext.locale` 是客户端界面区域
 * （Trip-App 常见 `zh_HK`，或整个缺失而被归为 zh），不等于客户实际书写的语言；
 * 优先客户原文；短句、编号等无可靠证据时才回退地区语言。拉丁文字不能独自区分英法等语言。
 */
export function customerLanguage(conv: Pick<UiConversation, 'lang'>, messages: readonly LanguageMessage[]): string {
  const lang = scriptLanguage(messages);
  return lang === null || (lang === 'en' && LATIN_LANGUAGES.has(conv.lang)) ? conv.lang : lang;
}
