import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter, fmString, fmList, fmMap } from '../frontmatter';

describe('parseFrontMatter（skills 生态兼容）', () => {
  it('普通单行与引号值', () => {
    const r = parseFrontMatter('---\nname: demo\ndescription: "带冒号: 的描述"\n---\n正文');
    assert.equal(fmString(r.data, 'name'), 'demo');
    assert.equal(fmString(r.data, 'description'), '带冒号: 的描述');
    assert.equal(r.body.trim(), '正文');
    assert.deepEqual(r.warnings, []);
  });

  it('折叠块 > 与字面块 |', () => {
    const folded = parseFrontMatter('---\ndescription: >\n  第一行\n  第二行\n---\n');
    assert.equal(fmString(folded.data, 'description'), '第一行 第二行');
    const literal = parseFrontMatter('---\ndescription: |\n  保留\n  换行\n---\n');
    assert.equal(fmString(literal.data, 'description'), '保留\n换行');
  });

  it('allowed-tools 逗号与 YAML 列表两种写法', () => {
    const comma = parseFrontMatter('---\nallowed-tools: Bash, Read, Write\n---\n');
    assert.deepEqual(fmList(comma.data, 'allowed-tools'), ['Bash', 'Read', 'Write']);
    const listYaml = parseFrontMatter('---\nallowed-tools:\n  - Bash\n  - Read\n---\n');
    assert.deepEqual(fmList(listYaml.data, 'allowed-tools'), ['Bash', 'Read']);
  });

  it('metadata 嵌套映射', () => {
    const r = parseFrontMatter('---\nname: x\nmetadata:\n  version: 3.21.1\n  task_type: research\n---\n');
    assert.deepEqual(fmMap(r.data, 'metadata'), { version: '3.21.1', task_type: 'research' });
  });

  it('无 frontmatter / 未闭合 均降级为正文', () => {
    assert.equal(parseFrontMatter('# 直接是正文').body, '# 直接是正文');
    const broken = parseFrontMatter('---\nname: x\n没有结束线');
    assert.ok(broken.warnings.length > 0);
    assert.ok(broken.body.includes('name: x'));
  });

  it('BOM 与 CRLF 不影响解析', () => {
    const r = parseFrontMatter('\uFEFF---\r\nname: win\r\ndescription: ok\r\n---\r\nbody');
    assert.equal(fmString(r.data, 'name'), 'win');
    assert.equal(fmString(r.data, 'description'), 'ok');
  });

  it('注释行与空行忽略', () => {
    const r = parseFrontMatter('---\n# 注释\n\nname: n\n---\n');
    assert.equal(fmString(r.data, 'name'), 'n');
    assert.deepEqual(r.warnings, []);
  });

  it('游离缩进行记警告但不崩', () => {
    const r = parseFrontMatter('---\nname: n\n  意外缩进\n---\n');
    assert.equal(fmString(r.data, 'name'), 'n');
    assert.equal(r.warnings.length, 1);
  });
});
