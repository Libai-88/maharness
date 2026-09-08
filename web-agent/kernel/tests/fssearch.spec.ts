import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globToRegex, matchesGlob, walkFiles, grepFiles, sliceLines, applyEdits, countOccurrences, detectEol, convertEol, toRel } from '../fssearch';

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mh-fssearch-'));
  mkdirSync(join(root, 'src', 'nested'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'line1\nline2 target\nline3\nline2 target again\n');
  writeFileSync(join(root, 'src', 'b.md'), '# 标题\ntarget 中文行\n');
  writeFileSync(join(root, 'src', 'nested', 'c.ts'), 'const x = 1;\n');
  writeFileSync(join(root, 'node_modules', 'pkg', 'shadow.ts'), 'target in node_modules\n');
});

after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });

describe('glob 匹配', () => {
  it('**/*.ts 递归命中且不进 node_modules', () => {
    const { hits } = walkFiles(root, { accept: rel => matchesGlob(rel, '**/*.ts') });
    assert.deepEqual(hits.map(h => h.rel).sort(), ['src/a.ts', 'src/nested/c.ts']);
  });

  it('无斜杠模式按文件名匹配', () => {
    assert.ok(matchesGlob('src/nested/c.ts', '*.ts'));
    assert.ok(!matchesGlob('src/b.md', '*.ts'));
  });

  it('{a,b} 交替与显式 ignore', () => {
    assert.ok(matchesGlob('src/a.ts', 'src/*.{ts,md}'));
    const all = walkFiles(root, { ignore: [] });
    assert.ok(all.hits.some(h => h.rel.startsWith('node_modules')));
  });

  it('globToRegex 转义点号', () => {
    assert.ok(!globToRegex('a.ts').test('Xats'));
    assert.ok(globToRegex('a.ts').test('a.ts'));
  });
});

describe('grepFiles', () => {
  it('正则模式返回文件/行号/文本', () => {
    const r = grepFiles(root, { pattern: 'target', limit: 10 });
    assert.equal(r.error, undefined);
    assert.equal(r.matches.length, 3);
    assert.equal(r.matches[0].file, 'src/a.ts');
    assert.equal(r.matches[0].line, 2);
    assert.ok(!r.files.includes('node_modules/pkg/shadow.ts'));
  });

  it('literal 模式不解释正则元字符', () => {
    const r = grepFiles(root, { pattern: 'const x = 1;', literal: true });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].file, 'src/nested/c.ts');
  });

  it('glob 过滤 + ignoreCase + 上下文行', () => {
    const r = grepFiles(root, { pattern: 'TARGET', ignoreCase: true, glob: '*.ts', contextLines: 1 });
    assert.ok(r.matches.length >= 1);
    assert.ok(r.matches[0].before?.length === 1 || r.matches[0].line === 1);
  });

  it('非法正则返回 error 而非抛出', () => {
    const r = grepFiles(root, { pattern: '([' });
    assert.ok(r.error?.includes('非法正则'));
  });
});

describe('sliceLines 分段读', () => {
  const text = 'l1\nl2\nl3\nl4\nl5';
  it('offset/limit 给出行区间与续读游标', () => {
    const s = sliceLines(text, 2, 2, 10_000);
    assert.equal(s.text, 'l2\nl3');
    assert.deepEqual([s.startLine, s.endLine, s.totalLines, s.nextOffset], [2, 3, 5, 4]);
  });
  it('读到末尾 nextOffset 为空', () => {
    assert.equal(sliceLines(text, 4, 10, 10_000).nextOffset, undefined);
  });
  it('字符预算优先于行数', () => {
    const wide = `${'a'.repeat(50)}\n${'b'.repeat(50)}\nc`;
    const s = sliceLines(wide, 1, 100, 60);
    assert.equal(s.endLine, 1);
    assert.equal(s.truncatedByChars, true);
    assert.equal(s.nextOffset, 2);
  });
  it('越界 offset 返回空段', () => {
    const s = sliceLines(text, 99, 10, 10_000);
    assert.equal(s.text, '');
    assert.equal(s.startLine, 0);
  });
});

describe('applyEdits 精确替换', () => {
  const src = 'const a = 1;\nconst b = 2;\nconst a = 1;\n';
  it('唯一匹配才允许替换', () => {
    const r = applyEdits(src, [{ oldText: 'const b = 2;', newText: 'const b = 20;' }]);
    assert.ok(r.ok);
    assert.ok(r.text.includes('const b = 20;'));
  });
  it('匹配不唯一时报错并指出出现次数', () => {
    const r = applyEdits(src, [{ oldText: 'const a = 1;', newText: 'x' }]);
    assert.ok(!r.ok);
    assert.match(r.error, /匹配到 2 处/);
    assert.equal(r.failedIndex, 0);
  });
  it('replaceAll 替换全部', () => {
    const r = applyEdits(src, [{ oldText: 'const a = 1;', newText: 'const a = 3;', replaceAll: true }]);
    assert.ok(r.ok && r.applied[0].replaced === 2);
    assert.equal(countOccurrences(r.text, 'const a = 3;'), 2);
  });
  it('任一编辑失败则整体不产出（无半成品）', () => {
    const r = applyEdits(src, [
      { oldText: 'const b = 2;', newText: 'const b = 9;' },
      { oldText: 'NOT_PRESENT', newText: 'x' },
    ]);
    assert.ok(!r.ok);
    assert.equal(r.failedIndex, 1);
  });
  it('newText 含 $ 符号按字面处理', () => {
    const r = applyEdits('a', [{ oldText: 'a', newText: '$&$1' }]);
    assert.ok(r.ok && r.text === '$&$1');
  });
  it('oldText 为空 / 与 newText 相同均拒绝', () => {
    assert.ok(!applyEdits('a', [{ oldText: '', newText: 'b' }]).ok);
    assert.ok(!applyEdits('a', [{ oldText: 'a', newText: 'a' }]).ok);
  });
});

describe('换行风格与路径工具', () => {
  it('detectEol 识别 CRLF', () => {
    assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
    assert.equal(detectEol('a\nb\n'), '\n');
    assert.equal(detectEol('only-one-line'), '\n');
  });
  it('convertEol 双向转换幂等', () => {
    assert.equal(convertEol('a\nb', '\r\n'), 'a\r\nb');
    assert.equal(convertEol('a\r\nb', '\r\n'), 'a\r\nb');
    assert.equal(convertEol('a\r\nb', '\n'), 'a\nb');
  });
  it('toRel 输出正斜杠相对路径', () => {
    assert.equal(toRel(root, join(root, 'src', 'a.ts')).replace(/\\/g, '/'), 'src/a.ts');
  });
});
