// site-generator-speed-01-run-20261122: a fast drop-in for makefun-site 1.0.0.
//
// makefun anchor 52b1002a0cd73cb2148cbdc4e4f8c913c2020c3a round 34208261
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input, byte for byte. Everything here is written
// fresh in this session, from the makefun-site README and its behaviour:
// its own front matter, template dialect, Markdown subset, slug rule and
// build report. No dependencies, no network, no files, no clock.
//
// Speed comes from doing the same work with less of it: front matter and
// Markdown are read in one pass with no token objects, inline rendering
// escapes whole plain runs at once instead of one character at a time,
// slugs are memoised, templates are parsed once into flat node arrays and
// rendered into a chunk list, and each page's card is built once and reused
// for its layout, its lists and its neighbours.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const ESCAPABLE = "\\`*_[]()#+-.!>";
const WS_RE = /\s/;
const ANY_SPECIAL_RE = /[\\`*\[&<>"']/;
const MD_SPECIAL_RE = /[\\`*[]/;
const ESC_RE = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function escapeHtml(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// ---------------------------------------------------------------- slugs

function computeSlug(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      // A combining mark left over from a non-ASCII run is dropped by the
      // NFKD step above; any other non-kept code unit is a word break.
      if (!ascii && plain.codePointAt(i) > 0xffff) {
        // Astral code points are two UTF-16 units; the second unit must
        // not start a second gap. It is a non-kept unit either way, so
        // treat the pair as one break.
        if (plain.charCodeAt(i) >= 0xd800 && plain.charCodeAt(i) <= 0xdbff) i++;
      }
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out[e - 1] === '-') e--;
    out = out.slice(0, e);
  }
  return out === '' ? 'untitled' : out;
}

function slugify(text, st) {
  const hit = st.slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = computeSlug(text);
  st.slugCache.set(text, out);
  return out;
}

/** First of slug, slug-2, slug-3, ... not in `taken` (and added to it). */
function uniqueSlug(slug, taken, counters) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = counters.get(slug) || 2;
  let out = `${slug}-${n}`;
  while (taken.has(out)) { n++; out = `${slug}-${n}`; }
  counters.set(slug, n + 1);
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
        if (!ok) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // a leading '-' is not a slug
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // The closing '---' line: the first '\n---\n', or a trailing '\n---'.
  let closeLine = -1;
  let bodyStart = -1;
  const ci = text.indexOf('\n---\n', 1);
  if (ci !== -1) { closeLine = ci + 1; bodyStart = ci + 5; }
  else if (text.endsWith('\n---')) { closeLine = text.length - 3; bodyStart = text.length; }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const fm = text.slice(nl0 + 1, closeLine);
  const lines = fm === '' ? [] : fm.split('\n');
  const data = {};
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    // Blank (spaces/tabs only) or a comment.
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue; // '#'
    // key: value — key of a-z and '_', a colon, one space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
      return { error: `line ${j + 2} is not "key: value"` };
    }
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    // Trailing spaces and tabs dropped.
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    raw = raw.slice(0, e);
    if (key !== 'title' && key !== 'date' && key !== 'tags' && key !== 'draft' && key !== 'layout' && key !== 'slug' && key !== 'summary') {
      return { error: `unknown key "${key}"` };
    }
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

function isLangChar(c) {
  const code = c.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || c === '_' || c === '+' || c === '-';
}

/** Fence-open language, or null. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 35) j++; // '#'
  if (j < 1 || j > 6) return null;
  if (j >= line.length) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let k = j;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  const text = trimST(line.slice(k));
  return text === '' ? null : { depth: j, text };
}

function isHR(line) {
  const head = line.slice(0, 3);
  if (head !== '---' && head !== '***') return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 45 || c === 42) return isHR(line);
  return false;
}

function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { rest: line.slice(2) }; // '- ' / '* '
  return null;
}

function orderedOf(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j < 1 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null; // '. '
  return { start: Number(line.slice(0, j)), rest: line.slice(j + 2) };
}

function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !WS_RE.test(line[j]);
}

/** Whether the character at `j` is backslash-escaped: an odd run of `\` just before it. */
function isEscaped(s, j) {
  let b = 0;
  let p = j - 1;
  while (p >= 0 && s[p] === '\\') { b++; p--; }
  return (b & 1) === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1 && isEscaped(s, j)) j = s.indexOf(what, j + 1);
  return j;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, j)) { j = s.indexOf('*', j + 1); continue; }
    if (s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

function inlineStr(s, link, st) {
  if (!ANY_SPECIAL_RE.test(s)) return s;
  if (!MD_SPECIAL_RE.test(s)) return escapeHtml(s);
  const out = [];
  let i = 0;
  const n = s.length;
  let plain = 0;
  const flush = (to) => { if (to > plain) out.push(escapeHtml(s.slice(plain, to))); };
  while (i < n) {
    // The next markdown special at or after i (native scans, no per-char loop).
    let j = n;
    let k = s.indexOf('\\', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i); if (k !== -1 && k < j) j = k;
    if (j === n) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
        flush(j);
        const nc = s[j + 1];
        out.push(nc === '>' ? '&gt;' : nc);
        i = j + 2;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (c === '`') {
      const m = s.indexOf('`', j + 1);
      if (m > j + 1) {
        flush(j);
        out.push('<code>', escapeHtml(s.slice(j + 1, m)), '</code>');
        i = m + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const m = findUnescaped(s, '**', j + 2);
        if (m > j + 2) {
          flush(j);
          out.push('<strong>', inlineStr(s.slice(j + 2, m), link, st), '</strong>');
          i = m + 2;
          plain = i;
        } else i = j + 2;
        continue;
      }
      const m = findSingleStar(s, j + 1);
      if (m > j + 1) {
        flush(j);
        out.push('<em>', inlineStr(s.slice(j + 1, m), link, st), '</em>');
        i = m + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    // '['
    const kk = findUnescaped(s, ']', j + 1);
    const m = kk !== -1 && s[kk + 1] === '(' ? s.indexOf(')', kk + 2) : -1;
    const target = m === -1 ? '' : s.slice(kk + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      flush(j);
      out.push('<a href="', escapeHtml(link(target)), '">', inlineStr(s.slice(j + 1, kk), link, st), '</a>');
      i = m + 1;
      plain = i;
    } else i = j + 1;
  }
  flush(n);
  return out.join('');
}

function renderMarkdown(src, link, st) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  const idCounters = new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.length === 0) { i++; continue; }
    const c0 = line.charCodeAt(0);
    // Dispatch on the first character: most lines are plain paragraph text,
    // and only a few first characters can open another block at all.
    if (c0 === 96) { // '`' — a fence, or paragraph text
      const fence = fenceOpen(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        out.push(`<pre><code${fence === '' ? '' : ` class="language-${escapeHtml(fence)}"`}>${body.length ? escapeHtml(`${body.join('\n')}\n`) : ''}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) { // '#' — a heading, or paragraph text
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text, st), ids, idCounters);
        const html = inlineStr(hd.text, link, st);
        out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' / '*' — a break, a bullet, or paragraph text
      if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
      const bl = bulletOf(line);
      if (bl !== null) {
        const items = [];
        while (i < lines.length) {
          const cur = lines[i];
          const m = bulletOf(cur);
          if (m !== null) { items.push([trimST(m.rest)]); i++; }
          else if (isContinued(cur)) { items[items.length - 1].push(trimST(cur)); i++; }
          else break;
        }
        let s = '<ul>\n';
        for (const it of items) s += `<li>${inlineStr(it.join('\n'), link, st)}</li>\n`;
        s += '</ul>\n';
        out.push(s);
        continue;
      }
    } else if (c0 === 62) { // '>' — a blockquote
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const ls = [];
      for (const l of body) {
        const t = trimST(l);
        if (t !== '') ls.push(t);
      }
      out.push(ls.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineStr(ls.join('\n'), link, st)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // a digit — an ordered list, or paragraph text
      const od = orderedOf(line);
      if (od !== null) {
        const items = [];
        while (i < lines.length) {
          const cur = lines[i];
          const m = orderedOf(cur);
          if (m !== null) { items.push([trimST(m.rest)]); i++; }
          else if (isContinued(cur)) { items[items.length - 1].push(trimST(cur)); i++; }
          else break;
        }
        const open = od.start !== 1 ? `<ol start="${od.start}">` : '<ol>';
        let s = `${open}\n`;
        for (const it of items) s += `<li>${inlineStr(it.join('\n'), link, st)}</li>\n`;
        s += '</ol>\n';
        out.push(s);
        continue;
      }
    } else if (c0 === 32 || c0 === 9) { // spaces/tabs — a blank line, or paragraph text
      if (isBlank(line)) { i++; continue; }
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimST(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inlineStr(body.join('\n'), link, st);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}
// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

// Node kinds: 0 text, 1 var (escaped), 2 raw, 3 if, 4 for, 5 include.
// text: [0, text]  var/raw: [1|2, path[]]  if: [3, not, path[], then[], else[]|null]
// for: [4, name, path[], body[]]  include: [5, name]

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push([0, tok.text]);
    else if (tok.t === 'var') body.push([1, tok.path]);
    else if (tok.t === 'raw') body.push([2, tok.path]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [4, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push({ kind: 'for', body: node[3], node });
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [3, m[1] !== undefined, pathOf(name, m[2]), [], null];
        body.push(node);
        stack.push({ kind: 'if', body: node[3], node });
        body = node[3];
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.node[4] = [];
        top.body = top.node[4];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.node[3] : (parent.node[4] ?? parent.node[3]);
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push([5, m[1]]);
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node[0]) {
      case 0:
        out.push(node[1]);
        break;
      case 1:
        out.push(escapeHtml(textOf(lookup(scope, node[1]))));
        break;
      case 2:
        out.push(textOf(lookup(scope, node[1])));
        break;
      case 3: {
        const v = truthy(lookup(scope, node[2]));
        const branch = v !== node[1] ? node[3] : node[4];
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(scope, node[2]);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [node[1]]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(node[3], { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 5: {
        const t = ctx.templates.get(node[1]);
        if (t === undefined || depth >= 8) break;
        const info = ctx.constInfo.get(node[1]);
        if (info !== undefined && info.constant && !shadows(scope, info.refs)) {
          const key = `${node[1]}:${depth + 1}`;
          let s = ctx.cache.get(key);
          if (s === undefined) {
            const tmp = [];
            renderNodes(t, scope, ctx, depth + 1, tmp);
            s = tmp.join('');
            ctx.cache.set(key, s);
          }
          out.push(s);
        } else renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/** Whether any loop frame above the root frame binds a name in `refs`. */
function shadows(scope, refs) {
  let s = scope;
  while (s !== null && s.parent !== null) {
    for (const k in s.vars) if (refs.has(k)) return true;
    s = s.parent;
  }
  return false;
}

// A template is root-constant when everything it renders comes from the
// case's root values alone (site, tags, recent, and loop variables drawn
// from those): its output is then the same wherever it is rendered, so it
// is rendered once per case (per include depth) and cached. Anything that
// reads page, posts, pager, tag, or a caller's loop variable is not.
function analyzeTemplate(name, ctx) {
  let info = ctx.constInfo.get(name);
  if (info !== undefined) return info;
  if (ctx.analyzing.has(name)) return { constant: false, refs: new Set() };
  const nodes = ctx.templates.get(name);
  if (nodes === undefined) return { constant: true, refs: new Set() };
  ctx.analyzing.add(name);
  const env = new Map([['site', true], ['tags', true], ['recent', true], ['page', false], ['posts', false], ['pager', false], ['tag', false]]);
  const refs = new Set();
  const ok = walkNodes(nodes, env, ctx, refs);
  ctx.analyzing.delete(name);
  info = { constant: ok, refs };
  ctx.constInfo.set(name, info);
  return info;
}

function walkNodes(nodes, env, ctx, refs) {
  for (const node of nodes) {
    switch (node[0]) {
      case 0:
        break;
      case 1:
      case 2: {
        const first = node[1][0];
        if (!env.has(first) || !env.get(first)) return false;
        if (first === 'site' || first === 'tags' || first === 'recent') refs.add(first);
        break;
      }
      case 3: {
        const first = node[2][0];
        if (!env.has(first) || !env.get(first)) return false;
        if (first === 'site' || first === 'tags' || first === 'recent') refs.add(first);
        if (!walkNodes(node[3], env, ctx, refs)) return false;
        if (node[4] !== null && !walkNodes(node[4], env, ctx, refs)) return false;
        break;
      }
      case 4: {
        const first = node[2][0];
        if (!env.has(first) || !env.get(first)) return false;
        if (first === 'site' || first === 'tags' || first === 'recent') refs.add(first);
        const env2 = new Map(env);
        env2.set(node[1], env.get(first));
        env2.set('loop', true);
        if (!walkNodes(node[3], env2, ctx, refs)) return false;
        break;
      }
      case 5: {
        const sub = analyzeTemplate(node[1], ctx);
        if (!sub.constant) return false;
        for (const r of sub.refs) refs.add(r);
        break;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------- the build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const st = { slugCache: new Map() };
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of path; line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = { set: new Set(dir === '' ? RESERVED : []), counters: new Map() };
      takenByDir.set(dir, taken);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, st), taken.set, taken.counters);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if ((target.charCodeAt(0) >= 65 && target.charCodeAt(0) <= 90) || (target.charCodeAt(0) >= 97 && target.charCodeAt(0) <= 122)) {
        // Possible scheme: letters, then alphanumerics / '+' / '-' / '.', then ':'.
        let j = 1;
        while (j < target.length) {
          const c = target.charCodeAt(j);
          if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) j++;
          else break;
        }
        if (j < target.length && target.charCodeAt(j) === 58) return target;
      }
      if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target; // '/' or '#'
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, st);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, st);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, st);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, st);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, built once per source and reused.
  const cardCache = new Map();
  const cardOf = (s) => {
    let card = cardCache.get(s);
    if (card !== undefined) return card;
    card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, card);
    return card;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  // 7. Layouts.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, constInfo: new Map(), cache: new Map(), analyzing: new Set() };
  for (const name of templates.keys()) analyzeTemplate(name, ctx);
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) {
    const card = cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
