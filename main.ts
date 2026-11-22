// mend: the four-format, transactional patch CLI described by SPEC.md (MIT).
// Node 22 and its standard library alone; run as node main.ts [options] [PATCH].
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
  readonly moves: [string, string][] = [];
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

type Body = { kind: string; text: string };
type Chunk = { body: Body[]; a?: number; anchor?: string; eof?: boolean };
function fileLines(text: string) {
  const i = text.indexOf('\n');
  const br = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}
const serialize = (f: ReturnType<typeof fileLines>) => f.lines.length ? f.lines.join(f.br) + (f.final ? f.br : '') : '';
const parseFault = (i: number): never => { throw new Exit2(`error: parse ${i + 1}`); };
function occurrences(lines: string[], old: string[], strict: boolean, from = 0, eof = false): { positions: number[]; tier: number } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const norm = (s: string) => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');
    const positions: number[] = [];
    for (let i = from; i + old.length <= lines.length; i++) {
      if (eof && i + old.length !== lines.length) continue;
      if (old.every((s, k) => norm(s) === norm(lines[i + k]!))) positions.push(i);
    }
    if (positions.length) return { positions, tier };
  }
  return { positions: [], tier: 0 };
}
function replacement(body: Body[], matched: string[], tier: number): string[] {
  const old = body.filter(b => b.kind === ' ' || b.kind === '-');
  const p = old[0]?.text.match(/^[ \t]*/)?.[0] ?? '';
  const f = matched[0]?.match(/^[ \t]*/)?.[0] ?? '';
  let k = 0;
  const out: string[] = [];
  for (const b of body) {
    if (b.kind === ' ') out.push(matched[k++]!);
    else if (b.kind === '-') k++;
    else if (b.kind === '+') out.push(tier === 2 && !blank(b.text) && b.text.startsWith(p) ? f + b.text.slice(p.length) : b.text);
  }
  return out;
}
function requirePath(tree: Tree, p: string): string {
  const text = tree.get(p);
  if (text === null) throw new Fail('missing', p);
  return text;
}
function pathsSafe(...paths: string[]) {
  for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
}
function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previous = '', end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let p = previous;
    for (let j = i - 1; j > end; j--) {
      if (!blank(lines[j]!) && !lines[j]!.trim().startsWith('```')) { p = lines[j]!.trim(); break; }
    }
    if (!p) parseFault(i);
    let mid = i + 1;
    while (mid < lines.length && lines[mid]!.trimEnd() !== '=======') mid++;
    let last = mid + 1;
    while (last < lines.length && lines[last]!.trimEnd() !== '>>>>>>> REPLACE') last++;
    if (last >= lines.length) parseFault(i);
    const old = lines.slice(i + 1, mid), add = lines.slice(mid + 1, last);
    edits.push(tree => {
      pathsSafe(p);
      if (!old.length) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, add.length ? add.join('\n') + '\n' : '');
        return;
      }
      const f = fileLines(requirePath(tree, p));
      const m = occurrences(f.lines, old, strict);
      if (!m.positions.length) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const at = m.positions[0]!;
      const body = [...old.map(text => ({kind: '-', text})), ...add.map(text => ({kind: '+', text}))];
      f.lines.splice(at, old.length, ...replacement(body, f.lines.slice(at, at + old.length), m.tier));
      tree.now.set(p, serialize(f));
    });
    previous = p; end = last; i = last;
  }
  return edits;
}

function sectionEdit(p: string, dest: string, mode: string, chunks: Chunk[], unified: boolean, strict: boolean, explicitMove = false): Edit {
  return tree => {
    pathsSafe(...(mode === 'add' ? [...(p ? [p] : []), dest] : mode === 'delete' ? [p, ...(dest ? [dest] : [])] : [p, dest]));
    if (mode === 'add') {
      if (tree.get(dest) !== null) throw new Fail('exists', dest);
      const body = chunks.flatMap(c => c.body);
      const add = body.filter(b => b.kind === '+').map(b => b.text);
      const last = body.map(b => b.kind).lastIndexOf('+');
      tree.now.set(dest, add.length ? add.join('\n') + (unified && body[last + 1]?.kind === '\\' ? '' : '\n') : '');
      return;
    }
    const f = fileLines(requirePath(tree, p));
    if (mode === 'delete') { tree.now.set(p, null); return; }
    if ((dest !== p || explicitMove) && tree.get(dest) !== null) throw new Fail('exists', dest);
    let cursor = 0, delta = 0;
    for (const c of chunks) {
      if (!unified && c.anchor) {
        const m = occurrences(f.lines, [c.anchor], strict, cursor);
        if (!m.positions.length) throw new Fail('no-match', p);
        cursor = m.positions[0]! + 1;
      }
      const old = c.body.filter(b => b.kind === ' ' || b.kind === '-').map(b => b.text);
      let at: number, tier = 0;
      if (!old.length) at = unified ? Math.max(0, Math.min(f.lines.length, c.a! + delta)) : c.eof ? f.lines.length : cursor;
      else {
        const m = occurrences(f.lines, old, strict, unified ? 0 : cursor, !unified && c.eof);
        if (!m.positions.length) throw new Fail('no-match', p);
        tier = m.tier;
        at = unified ? m.positions.reduce((best, x) => Math.abs(x - (c.a! - 1 + delta)) < Math.abs(best - (c.a! - 1 + delta)) ? x : best) : m.positions[0]!;
      }
      const add = replacement(c.body, f.lines.slice(at, at + old.length), tier);
      if (unified && at + old.length === f.lines.length) {
        let last = -1;
        c.body.forEach((b, i) => { if (b.kind === ' ' || b.kind === '+') last = i; });
        f.final = !(last >= 0 && c.body[last + 1]?.kind === '\\');
      }
      f.lines.splice(at, old.length, ...add);
      delta += add.length - old.length;
      cursor = at + add.length;
    }
    tree.now.set(dest, serialize(f));
    if (dest !== p) { tree.now.set(p, null); tree.moves.push([p, dest]); }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: { p: string; dest: string; mode: string; chunks: Chunk[]; pair: boolean } | null = null;
  const flush = () => {
    if (section) edits.push(sectionEdit(section.p, section.dest, section.mode, section.chunks, true, strict));
  };
  const path = (s: string) => s.split('\t')[0]!.trim().replace(/^[ab]\//, '');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) parseFault(i);
      flush(); section = {p: m![1]!, dest: m![2]!, mode: '', chunks: [], pair: false};
    } else if (l.startsWith('--- ')) {
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) { if (section && !section.chunks.length) parseFault(i + 1); continue; }
      if (!section || section.chunks.length || section.pair) {
        flush(); section = {p: '', dest: '', mode: '', chunks: [], pair: false};
      }
      const old = l.slice(4).split('\t')[0]!.trim(), next = lines[++i]!.slice(4).split('\t')[0]!.trim();
      section.p = old === '/dev/null' ? '' : path(old);
      section.dest = next === '/dev/null' ? '' : path(next);
      section.pair = true;
      if (old === '/dev/null') section.mode = 'add';
      else if (next === '/dev/null') section.mode = 'delete';
    } else if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/.exec(l);
      if (!m || !section) parseFault(i);
      const body: Body[] = [];
      while (i + 1 < lines.length) {
        const s = lines[i + 1]!;
        if (s.startsWith('diff --git ') || (s.startsWith('--- ') && (lines[i + 2] ?? '').startsWith('+++ '))) break;
        if (s !== '' && !' +-\\'.includes(s[0]!)) break;
        i++; body.push({kind: s === '' ? ' ' : s[0]!, text: s === '' ? '' : s.slice(1)});
      }
      // Only physically empty trailing body lines are excluded, not explicit context lines.
      while (body.length && lines[i] === '') { body.pop(); i--; }
      section!.chunks.push({a: Number(m![1]), body});
    } else if (section && !section.chunks.length) {
      if (l.startsWith('new file mode')) section.mode = 'add';
      else if (l.startsWith('deleted file mode')) section.mode = 'delete';
      else if (!section.pair && l.startsWith('rename from ')) section.p = l.slice(12).trim();
      else if (!section.pair && l.startsWith('rename to ')) section.dest = l.slice(10).trim();
    }
  }
  flush(); return edits;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex(l => !blank(l));
  if (first < 0) parseFault(0);
  if (lines[first]!.trim() !== '*** Begin Patch') parseFault(first);
  let end = lines.length - 1;
  while (end >= 0 && blank(lines[end]!)) end--;
  if (lines[end]?.trim() !== '*** End Patch') parseFault(lines.length);
  const edits: Edit[] = [];
  for (let i = first + 1; i < end;) {
    if (blank(lines[i]!)) { i++; continue; }
    const start = i, m = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(lines[i]!);
    if (!m) parseFault(i);
    const mode = m![1] === 'Add' ? 'add' : m![1] === 'Delete' ? 'delete' : '';
    const p = m![2]!.trim(); let dest = p, moved = false;
    let stop = i + 1;
    while (stop < end && !/^\*\*\* (?:Add|Delete|Update) File: /.test(lines[stop]!)) stop++;
    let tail = stop;
    while (tail > i + 1 && blank(lines[tail - 1]!)) tail--;
    i++;
    const chunks: Chunk[] = [];
    if (mode === 'add') {
      const body: Body[] = [];
      for (; i < tail; i++) {
        if (lines[i] !== '' && !lines[i]!.startsWith('+')) parseFault(i);
        body.push({kind: '+', text: lines[i]!.slice(1)});
      }
      chunks.push({body});
    } else if (mode === 'delete') { if (i < tail) parseFault(i); }
    else {
      let current: Chunk | null = null;
      if (i < tail && lines[i]!.startsWith('*** Move to: ')) { dest = lines[i++]!.slice(13).trim(); moved = true; }
      for (; i < tail; i++) {
        const s = lines[i]!;
        if (s.startsWith('@@')) { current = {body: [], anchor: s.slice(2).trim()}; chunks.push(current); }
        else if (s === '*** End of File') {
          if (!current) parseFault(i);
          current!.eof = true; current = null;
        } else if (s === '' || ' +-'.includes(s[0]!)) {
          if (!current) {
            if (chunks.length) parseFault(i);
            current = {body: []}; chunks.push(current);
          }
          current.body.push({kind: s === '' ? ' ' : s[0]!, text: s.slice(1)});
        } else parseFault(i);
      }
      if (!chunks.length && !moved) parseFault(start);
    }
    edits.push(sectionEdit(p, dest, mode, chunks, false, strict, moved)); i = stop;
  }
  return edits;
}

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : searchEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      tree.moves.length = moveCount;
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const renames = new Map<string, string>();
  const consumed = new Set<string>();
  for (const [old, dest] of tree.moves) {
    if (!consumed.has(old) && !consumed.has(dest) && tree.original(old) !== null && tree.get(old) === null && tree.original(dest) === null && tree.get(dest) !== null) {
      renames.set(dest, old); consumed.add(old); consumed.add(dest);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renames.has(p)) rows.push(`R ${renames.get(p)} -> ${p}`);
    else if (!consumed.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
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
