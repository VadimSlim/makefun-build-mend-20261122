// Independent specification edge cases. All fixtures stay inside this project.
import { deepStrictEqual, strictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name: string, files: Record<string, string>, patch: string, out: string, after = files, args: string[] = [], code = 0) {
  const dir = mkdtempSync(join(root, '.edge-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), {recursive: true}); writeFileSync(join(dir, p), text);
    }
    const env = {...process.env}; delete env.MAKEFUN_ENV_URL;
    const r = spawnSync(process.execPath, [join(root, 'main.ts'), ...args], {cwd: dir, input: patch, encoding: 'utf8', env, timeout: 10000});
    strictEqual(r.status, code, name + ': exit ' + r.stderr);
    strictEqual(r.stdout, out, name + ': stdout');
    const got: Record<string, string> = {};
    function walk(path: string, prefix = '') {
      for (const ent of readdirSync(path, {withFileTypes: true})) {
        const p = prefix + ent.name;
        if (ent.isDirectory()) walk(join(path, ent.name), p + '/');
        else got[p] = readFileSync(join(path, ent.name), 'utf8');
      }
    }
    walk(dir); deepStrictEqual(got, after, name + ': files'); passed++;
  } finally {
    if (!resolve(dir).startsWith(resolve(root) + '\\') && !resolve(dir).startsWith(resolve(root) + '/')) throw new Error('Fixture escaped project');
    rmSync(dir, {recursive: true, force: true});
  }
}
const u = (body: string) => '--- a/f\n+++ b/f\n' + body;
const s = (old: string, add: string) => `f\n<<<<<<< SEARCH\n${old}=======\n${add}>>>>>>> REPLACE\n`;
const v = (body: string) => '*** Begin Patch\n*** Update File: f\n' + body + '*** End Patch\n';
test('overlapping search matches', {f: 'x\nx\nx\n'}, s('x\nx\n', 'y\n'), 'error: ambiguous f\nfailed: 1 of 1 edits\n', undefined, [], 1);
test('exact tier beats nearby fuzzy', {f: 'x \nx\n'}, u('@@ -1 +1 @@\n-x\n+y\n'), 'M f\nok: 1 file\n', {f: 'x \ny\n'});
test('nearest tie selects earlier', {f: 'x\nm\nx\n'}, u('@@ -2 +2 @@\n-x\n+y\n'), 'M f\nok: 1 file\n', {f: 'y\nm\nx\n'});
test('context preserved and additions indented', {f: '\tcall  \n\told\n'}, u('@@ -1 +1 @@\n    call\n-   old\n+   new\n'), 'M f\nok: 1 file\n', {f: '\tcall  \n\tnew\n'});
test('nonterminal newline marker ignored', {f: 'x\nz\n'}, u('@@ -1 +1 @@\n-x\n+y\n\\ No newline\n'), 'M f\nok: 1 file\n', {f: 'y\nz\n'});
test('terminal old marker does not mark new', {f: 'x'}, u('@@ -1 +1 @@\n-x\n\\ No newline\n+y\n'), 'M f\nok: 1 file\n', {f: 'y\n'});
test('terminal context marker', {f: 'x\nz\n'}, u('@@ -1 +1 @@\n-x\n+y\n z\n\\ No newline\n'), 'M f\nok: 1 file\n', {f: 'y\nz'});
test('creation marker', {}, '--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+x\n\\ No newline\n', 'A f\nok: 1 file\n', {f: 'x'});
test('insertion clamps after end', {f: 'x'}, u('@@ -99,0 +1 @@\n+y\n'), 'M f\nok: 1 file\n', {f: 'x\ny\n'});
test('empty file stays empty', {f: 'x\n'}, s('x\n', ''), 'M f\nok: 1 file\n', {f: ''});
test('search inherits previous path', {f: 'a\nb'}, s('a\n', 'x\n') + '```\n<<<<<<< SEARCH\nb\n=======\ny\n>>>>>>> REPLACE\n', 'M f\nok: 1 file\n', {f: 'x\ny'});
test('section rollback seen by next edit', {f: 'a\n'}, u('@@ -1 +1 @@\n-a\n+b\n@@ -2 +2 @@\n-missing\n+c\n') + u('@@ -1 +1 @@\n-a\n+z\n'), 'error: no-match f\nfailed: 1 of 2 edits\n', undefined, [], 1);
test('multiple failures and no writes', {f: 'a\n'}, s('z\n', 'b\n') + 'g\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n', 'error: no-match f\nerror: missing g\nfailed: 2 of 2 edits\n', undefined, [], 1);
test('v4a cursor excludes earlier exact match', {f: 'x\na\nx \n'}, v('@@ a\n-x\n+y\n'), 'M f\nok: 1 file\n', {f: 'x\na\ny\n'});
test('eof filter before tier choice', {f: 'x\na\nx \n'}, v('@@\n-x\n+y\n*** End of File\n'), 'M f\nok: 1 file\n', {f: 'x\na\ny\n'});
test('v4a eof insertion preserves missing break', {f: 'a'}, v('@@\n+b\n*** End of File\n'), 'M f\nok: 1 file\n', {f: 'a\nb'});
test('pure move', {f: 'a\r\n'}, v('*** Move to: nested/g\n'), 'R f -> nested/g\nok: 1 file\n', {'nested/g': 'a\r\n'});
test('explicit move to self already exists', {f: 'a\n'}, v('*** Move to: f\n'), 'error: exists f\nfailed: 1 of 1 edits\n', undefined, [], 1);
test('unsafe destination wins over missing source', {}, v('*** Move to: ../g\n'), 'error: unsafe ../g\nfailed: 1 of 1 edits\n', undefined, [], 1);
test('parse precedes file errors', {}, v('-a\n+b\n') + 'trailer\n', 'error: parse 7\n', undefined, [], 2);
test('check mode move', {f: 'a\n'}, v('*** Move to: g\n'), 'R f -> g\nok: 1 file\n', undefined, ['--check']);
test('strict rejects indentation', {f: '  a\n'}, s('a\n', 'b\n'), 'error: no-match f\nfailed: 1 of 1 edits\n', undefined, ['--strict'], 1);
test('json overlapping occurrences', {f: 'aaa'}, '{"command":"str_replace","path":"f","old_str":"aa","new_str":"b"}', 'error: ambiguous f\nfailed: 1 of 1 edits\n', undefined, [], 1);
console.log(`${passed} edge cases passed`);
