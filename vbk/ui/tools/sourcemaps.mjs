import { SourceMap } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Strip embedding/extensions and give sources build-machine-independent identities. */
export function portableSourceMap(map, mapFile, jsFile, sourceRoot) {
  if (map.version !== 3 || map.file !== basename(jsFile) || typeof map.mappings !== 'string' || !Array.isArray(map.names) || map.names.some(n => typeof n !== 'string') || !Array.isArray(map.sources) || !map.sources.length || (map.sourceRoot !== undefined && map.sourceRoot !== '')) throw new Error(`invalid source map: ${basename(mapFile)}`);
  const sources = map.sources.map(source => {
    if (typeof source !== 'string' || isAbsolute(source) || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.includes('\\')) throw new Error(`nonportable source map source: ${basename(mapFile)}`);
    const original = resolve(dirname(mapFile), source), rel = relative(sourceRoot, original);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`source escapes source tree: ${basename(mapFile)}`);
    return `vbk:///ui/${rel.split(sep).join('/')}`;
  });
  return { version: 3, file: basename(jsFile), sourceRoot: '', sources, names: map.names, mappings: map.mappings };
}

/** Every retained UTF-16 code unit keeps its exact compiled-JS origin. */
export class TrackedSource {
  constructor(text, offsets = Array.from({ length: text.length }, (_, i) => i)) { this.text = text; this.offsets = offsets; }
  toString() { return this.text; }
  replace(pattern, callback) {
    const text = [], offsets = []; let end = 0;
    const append = (value, origin) => { text.push(value); for (const offset of origin) offsets.push(offset); };
    for (const match of this.text.matchAll(pattern)) {
      const start = match.index;
      append(this.text.slice(end, start), this.offsets.slice(end, start));
      const result = typeof callback === 'function' ? callback(...match) : callback;
      if (typeof result === 'string') {
        if (result !== '') throw new Error('tracked replacement needs explicit original positions');
      } else {
        append(result.text, result.indices.map(i => this.offsets[start + i]));
      }
      end = start + match[0].length;
    }
    append(this.text.slice(end), this.offsets.slice(end));
    return new TrackedSource(text.join(''), offsets);
  }
  trim() {
    const start = this.text.length - this.text.trimStart().length, end = this.text.trimEnd().length;
    return new TrackedSource(this.text.slice(start, end), this.offsets.slice(start, end));
  }
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(value) {
  let v = value < 0 ? -value * 2 + 1 : value * 2, out = '';
  do { let digit = v % 32; v = Math.floor(v / 32); if (v) digit += 32; out += alphabet[digit]; } while (v);
  return out;
}
function isLineTerminator(char) { return char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029'; }
function linesOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (!isLineTerminator(text[i])) continue;
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    starts.push(i + 1);
  }
  return starts;
}
function position(starts, offset) {
  let lo = 0, hi = starts.length;
  while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= offset) lo = mid; else hi = mid; }
  return [lo, offset - starts[lo]];
}

/** Compose exact retained-character origins with tsc's map. Generated wrappers
 * have no origin, hence no mappings; no guessed line/column offsets are used. */
export function composeBundleMap(code, chunks, file) {
  const outputLines = linesOf(code), segments = outputLines.map(() => [[0]]), sources = [], names = [];
  const intern = (list, value) => { let index = list.indexOf(value); if (index < 0) { index = list.length; list.push(value); } return index; };
  for (const chunk of chunks) {
    const map = new SourceMap(chunk.map), compiledLines = linesOf(chunk.original);
    let lastLine = -1, lastKey = null;
    for (let i = 0; i < chunk.source.text.length; i++) {
      if (isLineTerminator(chunk.source.text[i])) continue;
      const [line, column] = position(outputLines, chunk.start + i);
      const [compiledLine, compiledColumn] = position(compiledLines, chunk.source.offsets[i]);
      const entry = map.findEntry(compiledLine, compiledColumn);
      // SourceMap.findEntry can return an earlier generated line for an
      // unmapped wrapper/blank line: that never establishes a mapping here.
      const mapped = entry.generatedLine === compiledLine && typeof entry.originalSource === 'string' && Number.isInteger(entry.originalLine) && Number.isInteger(entry.originalColumn);
      const key = mapped ? JSON.stringify([entry.originalSource, entry.originalLine, entry.originalColumn, entry.name ?? null]) : null;
      if (line !== lastLine) { lastLine = line; lastKey = null; }
      if (key === lastKey) continue;
      lastKey = key;
      if (column === 0) segments[line] = [];
      if (!mapped) { segments[line].push([column]); continue; }
      const segment = [column, intern(sources, entry.originalSource), entry.originalLine, entry.originalColumn];
      if (typeof entry.name === 'string') segment.push(intern(names, entry.name));
      segments[line].push(segment);
    }
  }
  let previousSource = 0, previousLine = 0, previousColumn = 0, previousName = 0;
  const mappings = segments.map(line => {
    let generatedColumn = 0;
    return line.map(segment => {
      const deltas = [segment[0] - generatedColumn]; generatedColumn = segment[0];
      if (segment.length > 1) {
        deltas.push(segment[1] - previousSource, segment[2] - previousLine, segment[3] - previousColumn);
        [previousSource, previousLine, previousColumn] = segment.slice(1, 4);
        if (segment.length > 4) { deltas.push(segment[4] - previousName); previousName = segment[4]; }
      }
      return deltas.map(vlq).join('');
    }).join(',');
  }).join(';');
  return { version: 3, file, sourceRoot: '', sources, names, mappings };
}
