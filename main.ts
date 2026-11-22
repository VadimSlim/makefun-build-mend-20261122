// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; target: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

type LinePiece = { lines: string[]; br: string; final: boolean };
function splitFile(text: string): LinePiece {
  const at = text.indexOf('\n');
  const br = at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(p: LinePiece): string {
  return p.lines.length === 0 ? '' : p.lines.join(p.br) + (p.final ? p.br : '');
}
function findMatches(hay: string[], needle: string[], strict: boolean, start = 0): { tier: number; positions: number[] } | null {
  const norm = (s: string, tier: number): string => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/g, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const positions: number[] = [];
    for (let i = start; i + needle.length <= hay.length; i++) {
      if (needle.every((v, j) => norm(v, tier) === norm(hay[i + j]!, tier))) positions.push(i);
    }
    if (positions.length) return { tier, positions };
  }
  return null;
}
function replaceLines(file: LinePiece, oldLines: string[], newLines: string[], strict: boolean, path: string, choose: (positions: number[]) => number): number {
  const m = findMatches(file.lines, oldLines, strict);
  if (m === null) throw new Fail('no-match', path);
  const at = choose(m.positions);
  const original = file.lines.slice(at, at + oldLines.length);
  const prefix = (s: string): string => /^[ \t]*/.exec(s)![0];
  const from = prefix(oldLines[0] ?? '');
  const to = prefix(original[0] ?? '');
  const written = newLines.map((line) => m.tier === 2 && line.trim() !== '' && line.startsWith(from) ? to + line.slice(from.length) : line);
  file.lines.splice(at, oldLines.length, ...written);
  return at;
}
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | null = null;
  let previousEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const marker = i;
    let path: string | null = null;
    for (let j = previousEnd; j < i; j++) {
      const candidate = lines[j]!.trim();
      if (candidate !== '' && !candidate.startsWith('```')) path = candidate;
    }
    path = path ?? previousPath;
    if (path === null) throw new Exit2(`error: parse ${marker + 1}`);
    let middle = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { middle = j; break; }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (middle >= 0) {
      for (let j = middle + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
      }
    }
    if (middle < 0 || end < 0) throw new Exit2(`error: parse ${marker + 1}`);
    const p = path;
    const oldLines = lines.slice(i + 1, middle);
    const newLines = lines.slice(middle + 1, end);
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (oldLines.length === 0) {
        if (before !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length ? newLines.join('\n') + '\n' : '');
        return;
      }
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      replaceLines(f, oldLines, newLines, strict, p, (positions) => {
        if (positions.length !== 1) throw new Fail('ambiguous', p);
        return positions[0]!;
      });
      tree.now.set(p, joinFile(f));
    });
    previousPath = p;
    previousEnd = end + 1;
    i = end;
  }
  return edits;
}

type PatchChunk = { anchor: string | null; old: string[]; next: string[]; common: boolean[]; eof: boolean };
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((s) => !blank(s));
  const last = lines.findLastIndex((s) => !blank(s));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const section = (s: string): boolean => /^(\*\*\* Add File: |\*\*\* Delete File: |\*\*\* Update File: )/.test(s);
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const heading = lines[i]!;
    const startLine = i + 1;
    if (!section(heading)) throw new Exit2(`error: parse ${startLine}`);
    const mode = heading.startsWith('*** Add File: ') ? 'add' : heading.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const p = heading.slice(mode === 'add' ? 14 : mode === 'delete' ? 17 : 17).trim();
    i++;
    const body: { text: string; line: number }[] = [];
    while (i < last && !section(lines[i]!)) { body.push({ text: lines[i]!, line: i + 1 }); i++; }
    while (body.length && blank(body[body.length - 1]!.text)) body.pop();
    if (mode === 'delete') {
      if (body.length) throw new Exit2(`error: parse ${body[0]!.line}`);
      edits.push((tree) => { if (!safe(p)) throw new Fail('unsafe', p); if (tree.get(p) === null) throw new Fail('missing', p); tree.now.set(p, null); });
      continue;
    }
    if (mode === 'add') {
      const created: string[] = [];
      for (const item of body) {
        if (item.text.startsWith('+')) created.push(item.text.slice(1));
        else if (item.text === '') created.push('');
        else throw new Exit2(`error: parse ${item.line}`);
      }
      edits.push((tree) => { if (!safe(p)) throw new Fail('unsafe', p); if (tree.get(p) !== null) throw new Fail('exists', p); tree.now.set(p, created.length ? created.join('\n') + '\n' : ''); });
      continue;
    }
    let destination: string | null = null;
    let j = 0;
    if (body.length && body[0]!.text.startsWith('*** Move to: ')) { destination = body[0]!.text.slice(13).trim(); j++; }
    const chunks: PatchChunk[] = [];
    let chunk: PatchChunk | null = null;
    for (; j < body.length; j++) {
      const item = body[j]!;
      const s = item.text;
      if (s.startsWith('@@')) {
        if (chunk) chunks.push(chunk);
        chunk = { anchor: s.slice(2).trim() || null, old: [], next: [], common: [], eof: false };
        continue;
      }
      if (s === '*** End of File') {
        if (!chunk) throw new Exit2(`error: parse ${item.line}`);
        chunk.eof = true;
        chunks.push(chunk);
        chunk = null;
        continue;
      }
      if (!(s === '' || s.startsWith(' ') || s.startsWith('-') || s.startsWith('+'))) throw new Exit2(`error: parse ${item.line}`);
      if (!chunk) chunk = { anchor: null, old: [], next: [], common: [], eof: false };
      const value = s === '' ? '' : s.slice(1);
      if (s === '' || s.startsWith(' ')) { chunk.old.push(value); chunk.next.push(value); chunk.common.push(true); }
      else if (s.startsWith('-')) chunk.old.push(value);
      else { chunk.next.push(value); chunk.common.push(false); }
    }
    if (chunk) chunks.push(chunk);
    if (chunks.length === 0 && destination === null) throw new Exit2(`error: parse ${startLine}`);
    const to = destination;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (to !== null && !safe(to)) throw new Fail('unsafe', to);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
      const f = splitFile(before);
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== null) {
          const anchor = findMatches(f.lines, [c.anchor], strict, cursor);
          if (!anchor) throw new Fail('no-match', p);
          cursor = anchor.positions[0]! + 1;
        }
        let at: number;
        let tier = 0;
        if (c.old.length === 0) at = c.eof ? f.lines.length : cursor;
        else {
          const found = findMatches(f.lines, c.old, strict, cursor);
          if (!found) throw new Fail('no-match', p);
          const positions = c.eof ? found.positions.filter((pos) => pos + c.old.length === f.lines.length) : found.positions;
          if (!positions.length) throw new Fail('no-match', p);
          at = positions[0]!;
          tier = found.tier;
        }
        const matched = f.lines.slice(at, at + c.old.length);
        const indent = (s: string): string => /^[ \t]*/.exec(s)![0];
        const from = indent(c.old[0] ?? '');
        const destIndent = indent(matched[0] ?? '');
        let oldIndex = 0;
        let newIndex = 0;
        const written: string[] = [];
        for (let z = 0; z < c.next.length; z++) {
          const value = c.next[z]!;
          if (c.common[z]) {
            const contextIndex = c.old.indexOf(value, oldIndex);
            if (contextIndex < 0) throw new Fail('no-match', p);
            written.push(matched[contextIndex] ?? value);
            oldIndex = contextIndex + 1;
          } else {
            written.push(tier === 2 && value.trim() !== '' && value.startsWith(from) ? destIndent + value.slice(from.length) : value);
          }
          newIndex++;
        }
        f.lines.splice(at, c.old.length, ...written);
        cursor = at + written.length;
      }
      if (to !== null) {
        tree.now.set(p, null);
        tree.now.set(to, joinFile(f));
        tree.moves.push({ old: p, target: to });
      } else tree.now.set(p, joinFile(f));
    });
  }
  return edits;
}

type UnifiedOp = { kind: ' ' | '-' | '+'; value: string };
type UnifiedHunk = { oldLine: number; ops: UnifiedOp[]; noFinal: boolean };
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const gitHeader = (s: string): boolean => s.startsWith('diff --git ');
  const oldHeader = (s: string): boolean => s.startsWith('--- ');
  const cleanPath = (s: string, prefix: string): string | null => {
    const raw = s.split('\t')[0]!.trim();
    if (raw === '/dev/null') return null;
    return raw.startsWith(prefix) ? raw.slice(2) : raw;
  };
  while (i < lines.length) {
    while (i < lines.length && !gitHeader(lines[i]!) && !(oldHeader(lines[i]!) && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ '))) {
      if (lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
    }
    if (i >= lines.length) break;
    let source: string | null = null;
    let target: string | null = null;
    let renameSource: string | null = null;
    let renameTarget: string | null = null;
    const sectionStart = i + 1;
    if (gitHeader(lines[i]!)) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(lines[i]!);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      source = m[1]!;
      target = m[2]!;
      i++;
    } else if (!oldHeader(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
    let headersSeen = false;
    const hunks: UnifiedHunk[] = [];
    while (i < lines.length) {
      const s = lines[i]!;
      if (gitHeader(s) || (hunks.length > 0 && oldHeader(s) && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ '))) break;
      if (s.startsWith('rename from ')) { renameSource = s.slice(12); i++; continue; }
      if (s.startsWith('rename to ')) { renameTarget = s.slice(10); i++; continue; }
      if (s.startsWith('new file mode ') || s.startsWith('deleted file mode ') || s.startsWith('index ') || s.startsWith('similarity index ') || s.startsWith('old mode ') || s.startsWith('new mode ')) { i++; continue; }
      if (oldHeader(s) && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
        source = cleanPath(s.slice(4), 'a/');
        target = cleanPath(lines[i + 1]!.slice(4), 'b/');
        headersSeen = true;
        i += 2;
        continue;
      }
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(s);
      if (match) {
        const h: UnifiedHunk = { oldLine: Number(match[1]), ops: [], noFinal: false };
        i++;
        while (i < lines.length) {
          const line = lines[i]!;
          if (line.startsWith('@@ ') || gitHeader(line) || (oldHeader(line) && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ '))) break;
          if (line.startsWith('\\ No newline at end of file')) {
            const prev = h.ops[h.ops.length - 1];
            if (!prev) throw new Exit2(`error: parse ${i + 1}`);
            if (prev.kind === '+' || prev.kind === ' ') h.noFinal = true;
            i++;
            continue;
          }
          if (line.length === 0) { h.ops.push({ kind: ' ', value: '' }); i++; continue; }
          if (![' ', '-', '+'].includes(line[0]!)) break;
          h.ops.push({ kind: line[0] as UnifiedOp['kind'], value: line.slice(1) });
          i++;
        }
        while (h.ops.length > 0 && h.ops[h.ops.length - 1]!.kind === ' ' && h.ops[h.ops.length - 1]!.value === '') h.ops.pop();
        hunks.push(h);
        continue;
      }
      if (s.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (oldHeader(s) && hunks.length === 0 && i + 1 < lines.length && !lines[i + 1]!.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      i++;
    }
    source = renameSource ?? source;
    target = renameTarget ?? target;
    if (source === null && target === null) throw new Exit2(`error: parse ${sectionStart}`);
    if (!headersSeen && hunks.length === 0 && renameSource === null && renameTarget === null) throw new Exit2(`error: parse ${sectionStart}`);
    const from = source;
    const to = target;
    edits.push((tree) => {
      if (from !== null && !safe(from)) throw new Fail('unsafe', from);
      if (to !== null && !safe(to)) throw new Fail('unsafe', to);
      const path = from ?? to!;
      const original = from === null ? null : tree.get(from);
      if (from === null && tree.get(to!) !== null) throw new Fail('exists', to!);
      if (from !== null && original === null) throw new Fail('missing', from);
      if (from !== null && to !== null && from !== to && tree.get(to) !== null) throw new Fail('exists', to);
      const file = splitFile(original ?? '');
      let delta = 0;
      for (const h of hunks) {
        const oldLines = h.ops.filter((o) => o.kind !== '+').map((o) => o.value);
        const preferred = Math.max(0, h.oldLine - (h.oldLine === 0 ? 0 : 1) + delta);
        let at = Math.max(0, Math.min(h.oldLine + delta, file.lines.length));
        let tier = 0;
        if (oldLines.length > 0) {
          const found = findMatches(file.lines, oldLines, strict);
          if (!found) throw new Fail('no-match', path);
          at = [...found.positions].sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b)[0]!;
          tier = found.tier;
        }
        const matched = file.lines.slice(at, at + oldLines.length);
        const indent = (s: string): string => /^[ \t]*/.exec(s)![0];
        const fromIndent = indent(oldLines[0] ?? '');
        const toIndent = indent(matched[0] ?? '');
        const written: string[] = [];
        let oldIndex = 0;
        for (const op of h.ops) {
          if (op.kind === '-') { oldIndex++; continue; }
          if (op.kind === ' ') { written.push(matched[oldIndex] ?? op.value); oldIndex++; continue; }
          const value = op.value;
          written.push(tier === 2 && value.trim() !== '' && value.startsWith(fromIndent) ? toIndent + value.slice(fromIndent.length) : value);
        }
        file.lines.splice(at, oldLines.length, ...written);
        delta += written.length - oldLines.length;
        if (h.noFinal) file.final = false;
        else if (from === null) file.final = true;
      }
      if (from === null) tree.now.set(to!, joinFile(file));
      else if (to === null) tree.now.set(from, null);
      else if (from === to) tree.now.set(from, joinFile(file));
      else { tree.now.set(from, null); tree.now.set(to, joinFile(file)); tree.moves.push({ old: from, target: to }); }
    });
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : kind === 'unified' ? unifiedEdits(lines, strict) : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const covered = new Set<string>();
  const namedRows: { key: string; line: string }[] = [];
  for (const move of tree.moves) {
    if (!changed.includes(move.old) || !changed.includes(move.target)) continue;
    if (covered.has(move.old) || covered.has(move.target)) continue;
    if (tree.original(move.old) === null || tree.now.get(move.old) !== null) continue;
    if (tree.original(move.target) !== null || tree.now.get(move.target) === null) continue;
    covered.add(move.old);
    covered.add(move.target);
    namedRows.push({ key: move.old, line: `R ${move.old} -> ${move.target}` });
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    namedRows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  namedRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows = namedRows.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
