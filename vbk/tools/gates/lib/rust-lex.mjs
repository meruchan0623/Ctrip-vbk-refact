// Lexical scan of Rust sources (I-02; no AST dependency available offline).
// Comments are dropped, string literals become `str` tokens (never identifiers),
// and `#[cfg(test)]` items are removed by brace matching.

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
      // raw / byte / raw-byte strings: r"..", r#".."#, b"..", br#".."#
      (c === 'r' || c === 'b') && /^(?:b?r#*"|b")/.test(src.slice(i, i + 12)) && !(i > 0 && isIdPart(src[i - 1]))
    ) {
      const m = /^(b?)(r?)(#*)"/.exec(src.slice(i, i + 12));
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
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\') {
            value += src[i + 1] ?? '';
            adv(2);
          } else {
            value += src[i];
            adv();
          }
        }
        adv();
      }
      toks.push({ t: 'str', v: value, line: startLine });
    } else if (c === '"') {
      const startLine = line;
      adv();
      let value = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') {
          value += src[i + 1] ?? '';
          adv(2);
        } else {
          value += src[i];
          adv();
        }
      }
      adv();
      toks.push({ t: 'str', v: value, line: startLine });
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

function isCfgTestAttr(attr) {
  // attr tokens between `[` and `]`: cfg ( ... test ... ), without `not`
  if (attr[0]?.v !== 'cfg' && attr[0]?.v !== 'cfg_attr') return false;
  const ids = attr.filter((t) => t.t === 'id').map((t) => t.v);
  return ids.includes('test') && !ids.includes('not');
}

/** Drops `#[cfg(test)]` items (and whole files with `#![cfg(test)]`). */
export function stripCfgTest(toks) {
  const out = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.v === '#' && t.t === 'p') {
      const inner = toks[i + 1]?.v === '!';
      const open = inner ? i + 2 : i + 1;
      if (toks[open]?.v === '[') {
        let depth = 0;
        let j = open;
        for (; j < toks.length; j += 1) {
          if (toks[j].t === 'p' && toks[j].v === '[') depth += 1;
          if (toks[j].t === 'p' && toks[j].v === ']') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const attr = toks.slice(open + 1, j);
        if (isCfgTestAttr(attr)) {
          if (inner) return [];
          // skip following attributes, then the item
          let k = j + 1;
          while (toks[k]?.v === '#' && toks[k + 1]?.v === '[') {
            let d = 0;
            for (; k < toks.length; k += 1) {
              if (toks[k].v === '[' && toks[k].t === 'p') d += 1;
              if (toks[k].v === ']' && toks[k].t === 'p') {
                d -= 1;
                if (d === 0) {
                  k += 1;
                  break;
                }
              }
            }
          }
          let paren = 0;
          for (; k < toks.length; k += 1) {
            const x = toks[k];
            if (x.t !== 'p') continue;
            if (x.v === '(' || x.v === '[') paren += 1;
            else if (x.v === ')' || x.v === ']') paren -= 1;
            else if (x.v === ';' && paren === 0) {
              k += 1;
              break;
            } else if (x.v === '{' && paren === 0) {
              let b = 0;
              for (; k < toks.length; k += 1) {
                if (toks[k].t === 'p' && toks[k].v === '{') b += 1;
                if (toks[k].t === 'p' && toks[k].v === '}') {
                  b -= 1;
                  if (b === 0) {
                    k += 1;
                    break;
                  }
                }
              }
              break;
            }
          }
          i = k;
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

export function rustTokens(src) {
  return stripCfgTest(lexRust(src));
}

/**
 * `#[tauri::command]` function signatures: [{name, params:[{name, type}], line}].
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
    if (!(attr[0] === 'tauri' && attr[1] === ':' && attr[2] === ':' && attr[3] === 'command')) continue;
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
