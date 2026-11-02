// Lexical scan of Rust sources (I-02; no AST dependency available offline).
// Comments are dropped, string literals become `str` tokens (never identifiers),
// and `#[cfg(test)]` / `#[test]` items are removed by brace matching.

const isIdStart = (c) => /[A-Za-z_]/.test(c);
const isIdPart = (c) => /[A-Za-z0-9_]/.test(c);

/** Tokens: {t:'id'|'str'|'p'|'num', v, line}. */
export function lexRust(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const adv = (k = 1) => {
    for (let j = 0; j < k; j += 1) if (src[i + j] === '\n') line += 1;
    i += k;
  };
  // Escaped (non-raw) string body up to the closing quote. A backslash before a
  // newline continues the literal on the next line with leading whitespace
  // dropped (Rust semantics), so a switch split across lines still folds.
  const escapedString = () => {
    let value = '';
    while (i < n && src[i] !== '"') {
      if (src[i] === '\\') {
        const next = src[i + 1] ?? '';
        if (next === '\n' || (next === '\r' && src[i + 2] === '\n')) {
          adv(next === '\r' ? 3 : 2);
          while (i < n && /[ \t\r\n]/.test(src[i])) adv();
          continue;
        }
        value += next;
        adv(2);
      } else {
        value += src[i];
        adv();
      }
    }
    adv();
    return value;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      adv();
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
    } else if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      adv(2);
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth += 1;
          adv(2);
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth -= 1;
          adv(2);
        } else adv();
      }
    } else if (
      // raw / byte / raw-byte / C strings: r"..", r#".."#, b"..", br#".."#, c"..", cr".."
      (c === 'r' || c === 'b' || c === 'c') && /^(?:[bc]?r#*"|[bc]")/.test(src.slice(i, i + 12)) && !(i > 0 && isIdPart(src[i - 1]))
    ) {
      const m = /^([bc]?)(r?)(#*)"/.exec(src.slice(i, i + 12));
      const startLine = line;
      adv(m[0].length);
      let value = '';
      if (m[2] === 'r') {
        const close = `"${m[3]}`;
        const end = src.indexOf(close, i);
        const stop = end === -1 ? n : end;
        value = src.slice(i, stop);
        adv(stop - i + (end === -1 ? 0 : close.length));
      } else {
        value = escapedString();
      }
      toks.push({ t: 'str', v: value, line: startLine });
    } else if (c === '"') {
      const startLine = line;
      adv();
      toks.push({ t: 'str', v: escapedString(), line: startLine });
    } else if (c === "'") {
      // char literal ('x', '\n', '\u{..}') versus lifetime ('a)
      const m = /^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^\\'])'/.exec(src.slice(i, i + 14));
      if (m) adv(m[0].length);
      else adv();
    } else if (isIdStart(c)) {
      let j = i;
      while (j < n && isIdPart(src[j])) j += 1;
      let word = src.slice(i, j);
      if (word === 'r' && src[j] === '#' && j + 1 < n && isIdStart(src[j + 1])) {
        let k = j + 1;
        while (k < n && isIdPart(src[k])) k += 1;
        word = src.slice(j + 1, k);
        j = k;
      }
      toks.push({ t: 'id', v: word, line });
      adv(j - i);
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j]) && !(src[j] === '.' && !/[0-9]/.test(src[j + 1] ?? ''))) j += 1;
      toks.push({ t: 'num', v: src.slice(i, j), line });
      adv(j - i);
    } else {
      toks.push({ t: 'p', v: c, line });
      adv();
    }
  }
  return toks;
}

const isP = (t, v) => t !== undefined && t.t === 'p' && t.v === v;

/**
 * `#[cfg(test)]` and `#[cfg(all(test, ...))]` compile only under `cargo test`;
 * `#[test]` functions too. `cfg(any(test, ..))`, `cfg(not(test))` and
 * `cfg_attr(test, ..)` items are PRODUCTION code and must stay in the scan.
 */
export function isCfgTestAttr(attr) {
  const ids = attr.filter((t) => t.t === 'id').map((t) => t.v);
  if (ids.length === 1 && ids[0] === 'test') return true;
  if (ids[0] !== 'cfg') return false;
  return ids.includes('test') && !ids.includes('any') && !ids.includes('not') && !ids.includes('cfg_attr');
}

/** `#[cfg(debug_assertions)]` / `#[cfg(all(debug_assertions, ..))]`: never in a release build. */
export function isDebugOnlyAttr(attr) {
  const ids = attr.filter((t) => t.t === 'id').map((t) => t.v);
  return ids[0] === 'cfg' && ids.includes('debug_assertions') && !ids.includes('any') && !ids.includes('not');
}

/** `#[cfg(feature = "<name>")]` / `#[cfg(all(feature = "<name>", ..))]` for one of `names`. */
export function isFeatureAttr(attr, names) {
  const ids = attr.filter((t) => t.t === 'id').map((t) => t.v);
  if (ids[0] !== 'cfg' || ids.includes('any') || ids.includes('not')) return false;
  for (let i = 0; i < attr.length - 2; i += 1) {
    if (attr[i].t === 'id' && attr[i].v === 'feature' && isP(attr[i + 1], '=') && attr[i + 2].t === 'str' && names.includes(attr[i + 2].v)) return true;
  }
  return false;
}

const ITEM_KEYWORDS = new Set(['fn', 'mod', 'impl', 'struct', 'enum', 'union', 'trait', 'use', 'const', 'static', 'type', 'macro_rules', 'extern', 'pub', 'unsafe', 'async', 'let', 'crate']);

/** Index just past the `]` closing the attribute whose `[` is at `open`. */
function attrEnd(toks, open) {
  let depth = 0;
  for (let j = open; j < toks.length; j += 1) {
    if (isP(toks[j], '[')) depth += 1;
    if (isP(toks[j], ']')) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return toks.length - 1;
}

/**
 * Index just past the thing an attribute at `k` applies to. An item (keyword
 * first) ends at `;` or after its `{...}` body; a struct field, enum variant,
 * match arm or parameter ends at the next top-level `,` or before the
 * enclosing closer, so a `#[cfg(test)]` on a field can never swallow its
 * neighbours.
 */
function skipAttributed(toks, k) {
  const itemMode = toks[k]?.t === 'id' && ITEM_KEYWORDS.has(toks[k].v);
  let depth = 0;
  for (; k < toks.length; k += 1) {
    const x = toks[k];
    if (x.t !== 'p') continue;
    if (x.v === '(' || x.v === '[') depth += 1;
    else if (x.v === ')' || x.v === ']') {
      if (depth === 0) return k; // enclosing closer (parameter list / tuple variant)
      depth -= 1;
    } else if (x.v === '{') {
      if (depth === 0) {
        let b = 0;
        for (; k < toks.length; k += 1) {
          if (isP(toks[k], '{')) b += 1;
          if (isP(toks[k], '}')) {
            b -= 1;
            if (b === 0) {
              k += 1;
              break;
            }
          }
        }
        // item body, or a block-bodied match arm / struct variant: ends here (an optional `,` follows)
        return !itemMode && isP(toks[k], ',') ? k + 1 : k;
      } else depth += 1;
    } else if (x.v === '}') {
      if (depth === 0) return k; // enclosing closer
      depth -= 1;
    } else if (x.v === ';' && depth === 0) return k + 1;
    else if (x.v === ',' && depth === 0 && !itemMode) return k + 1;
  }
  return k;
}

/**
 * Drops every item (or field / variant / arm) whose attribute satisfies
 * `shouldStrip`; `#![...]` inner attributes drop the whole file.
 */
export function stripCfgItems(toks, shouldStrip) {
  const out = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (isP(t, '#')) {
      const inner = isP(toks[i + 1], '!');
      const open = inner ? i + 2 : i + 1;
      if (isP(toks[open], '[')) {
        const j = attrEnd(toks, open);
        const attr = toks.slice(open + 1, j);
        if (shouldStrip(attr)) {
          if (inner) return [];
          // skip following attributes, then the attributed thing
          let k = j + 1;
          while (isP(toks[k], '#') && isP(toks[k + 1], '[')) k = attrEnd(toks, k + 1) + 1;
          i = skipAttributed(toks, k);
          continue;
        }
        out.push(...toks.slice(i, j + 1));
        i = j + 1;
        continue;
      }
    }
    out.push(t);
    i += 1;
  }
  return out;
}

/** Drops `#[cfg(test)]` / `#[test]` items (and whole files with `#![cfg(test)]`). */
export function stripCfgTest(toks) {
  return stripCfgItems(toks, isCfgTestAttr);
}

/**
 * Adds synthetic `str` tokens for `concat!("a", "b")` (the joined value), so a
 * literal split by the macro is still matched as a whole.
 */
export function withConcatStrings(toks) {
  const extra = [];
  for (let i = 0; i + 2 < toks.length; i += 1) {
    if (!(toks[i].t === 'id' && toks[i].v === 'concat' && isP(toks[i + 1], '!') && isP(toks[i + 2], '('))) continue;
    let value = '';
    let depth = 1;
    let j = i + 3;
    for (; j < toks.length && depth > 0; j += 1) {
      if (toks[j].t === 'p' && toks[j].v === '(') depth += 1;
      else if (toks[j].t === 'p' && toks[j].v === ')') depth -= 1;
      else if (toks[j].t === 'str' && depth === 1) value += toks[j].v;
    }
    extra.push({ t: 'str', v: value, line: toks[i].line, synthetic: 'concat!' });
  }
  return extra.length ? [...toks, ...extra] : toks;
}

/** Production tokens: comments and test-only items removed, `concat!` joined. */
export function rustTokens(src) {
  return withConcatStrings(stripCfgTest(lexRust(src)));
}

/**
 * `#[tauri::command]` / `#[command]` function signatures: [{name, params:[{name, type}], line}].
 * Parameters are split on top-level commas of the parenthesised list.
 */
export function tauriCommands(src) {
  const toks = rustTokens(src);
  const out = [];
  for (let i = 0; i < toks.length; i += 1) {
    if (toks[i].v !== '#' || toks[i + 1]?.v !== '[') continue;
    let j = i + 2;
    const attr = [];
    for (let d = 1; j < toks.length && d > 0; j += 1) {
      if (toks[j].t === 'p' && toks[j].v === '[') d += 1;
      if (toks[j].t === 'p' && toks[j].v === ']') d -= 1;
      if (d > 0) attr.push(toks[j].v);
    }
    const qualified = attr[0] === 'tauri' && attr[1] === ':' && attr[2] === ':' && attr[3] === 'command';
    const bare = attr[0] === 'command' && (attr.length === 1 || attr[1] === '(');
    if (!qualified && !bare) continue;
    let k = j;
    while (k < toks.length && !(toks[k].v === 'fn' && toks[k].t === 'id')) k += 1;
    const name = toks[k + 1]?.v;
    let p = k + 2;
    while (p < toks.length && toks[p].v !== '(') p += 1;
    const params = [];
    let depth = 0;
    let cur = [];
    for (; p < toks.length; p += 1) {
      const x = toks[p];
      if (x.t === 'p' && '([{<'.includes(x.v)) depth += 1;
      if (x.t === 'p' && ')]}>'.includes(x.v)) {
        // `->` never occurs inside the parameter list; `>` closes generics
        depth -= 1;
        if (depth === 0) {
          if (cur.length) params.push(cur);
          break;
        }
      }
      if (x.t === 'p' && x.v === ',' && depth === 1) {
        params.push(cur);
        cur = [];
        continue;
      }
      if (depth >= 1 && !(depth === 1 && x.v === '(' && x.t === 'p')) cur.push(x);
    }
    out.push({
      name,
      line: toks[k].line,
      params: params
        .map((ts) => {
          const colon = ts.findIndex((x) => x.t === 'p' && x.v === ':');
          if (colon < 0) return null;
          const idTok = ts.slice(0, colon).filter((x) => x.t === 'id' && x.v !== 'mut');
          return { name: idTok.at(-1)?.v ?? '', type: ts.slice(colon + 1).map((x) => x.v).join('') };
        })
        .filter(Boolean),
    });
  }
  return out;
}
