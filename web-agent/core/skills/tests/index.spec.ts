import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import skillsPlugin from '../index';

describe('技能契约索引', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

  it('读取并公开触发、适用、拒绝及输入输出契约', () => {
    root = mkdtempSync(join(tmpdir(), 'mh-skill-index-'));
    const dir = join(root, '.maharness', 'skills', 'contract-demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), [
      '---', 'name: contract-demo', 'description: 契约测试技能',
      'triggers:', '  - 契约测试', '  - skill contract',
      'applies_when:', '  - 需要验证技能元数据',
      'reject-when:', '  - 仅修改普通代码',
      'input: {task, constraints}', 'output: {ok, report}', '---', '正文',
    ].join('\n'));

    let service: { list: () => Array<Record<string, unknown>> } | undefined;
    const ctx = {
      config: { get: (key: string, fallback: unknown) => key === 'sandboxRoot' ? root : fallback },
      paths: { data: join(root, 'data') },
      register(value: { kind: string; service?: { id: string; instance: unknown } }) {
        if (value.kind === 'service' && value.service?.id === 'skills') service = value.service.instance as typeof service;
      },
      logger: { info() {} },
    };
    skillsPlugin.onLoad(ctx as never);
    const found = service?.list().find((s) => s.name === 'contract-demo');
    assert.ok(found);
    assert.deepEqual(found.triggers, ['契约测试', 'skill contract']);
    assert.deepEqual(found.appliesWhen, ['需要验证技能元数据']);
    assert.deepEqual(found.rejectWhen, ['仅修改普通代码']);
    assert.equal(found.input, '{task, constraints}');
    assert.equal(found.output, '{ok, report}');
    skillsPlugin.onStop?.();
  });

  it('缺少契约字段时保留技能并返回结构化告警', () => {
    root = mkdtempSync(join(tmpdir(), 'mh-skill-index-invalid-'));
    const dir = join(root, '.maharness', 'skills', 'legacy-demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: legacy-demo\ndescription: 旧技能\n---\n正文\n');

    let service: { list: () => Array<Record<string, unknown>> } | undefined;
    const ctx = {
      config: { get: (key: string, fallback: unknown) => key === 'sandboxRoot' ? root : fallback },
      paths: { data: join(root, 'data') },
      register(value: { kind: string; service?: { id: string; instance: unknown } }) {
        if (value.kind === 'service' && value.service?.id === 'skills') service = value.service.instance as typeof service;
      },
      logger: { info() {} },
    };
    skillsPlugin.onLoad(ctx as never);
    const found = service?.list().find((s) => s.name === 'legacy-demo');
    assert.ok(found);
    assert.deepEqual(found.contractWarnings, [
      '缺少 triggers（至少一个触发场景）',
      '缺少 applies-when（至少一个适用条件）',
      '缺少 reject-when（至少一个拒绝条件）',
      '缺少 input（输入契约）',
      '缺少 output（输出契约）',
    ]);
    skillsPlugin.onStop?.();
  });

  it('内置技能全部满足契约 schema', () => {
    root = mkdtempSync(join(tmpdir(), 'mh-skill-index-builtin-'));
    let service: { list: () => Array<Record<string, unknown>> } | undefined;
    const ctx = {
      config: { get: (_key: string, fallback: unknown) => fallback },
      paths: { data: join(root, 'data') },
      register(value: { kind: string; service?: { id: string; instance: unknown } }) {
        if (value.kind === 'service' && value.service?.id === 'skills') service = value.service.instance as typeof service;
      },
      logger: { info() {} },
    };
    skillsPlugin.onLoad(ctx as never);
    const builtin = service?.list().filter((s) => s.source === 'builtin') ?? [];
    assert.equal(builtin.length, 5);
    assert.ok(builtin.every((s) => !s.contractWarnings), JSON.stringify(builtin));
    skillsPlugin.onStop?.();
  });

  it('vendor 技能更新后经缓存失效重新索引，且不进入插件目录', () => {
    root = mkdtempSync(join(tmpdir(), 'mh-skill-index-vendor-'));
    const vendor = join(root, 'vendor');
    const skillDir = join(vendor, 'demo-pack', 'skills', 'vendor-demo');
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, 'SKILL.md');
    const v1 = '---\nname: vendor-demo\ndescription: vendor v1\ntriggers:\n  - v1\napplies-when:\n  - vendor\nreject-when:\n  - none\ninput: task\noutput: result\n---\nv1\n';
    const v2 = v1.replace('vendor v1', 'vendor v2').replace('  - v1', '  - v2').replace('\nv1\n', '\nv2\n');
    writeFileSync(file, v1, 'utf-8');
    let service: { list: () => Array<Record<string, unknown>>; invalidateCache: () => void; packDir: string } | undefined;
    const ctx = {
      config: { get: (key: string, fallback: unknown) => key === 'sandboxRoot' ? root : key === 'skills.vendorDir' ? vendor : fallback },
      paths: { data: join(root, 'data') },
      register(value: { kind: string; service?: { id: string; instance: unknown } }) {
        if (value.kind === 'service' && value.service?.id === 'skills') service = value.service.instance as typeof service;
      },
      logger: { info() {} },
    };
    skillsPlugin.onLoad(ctx as never);
    assert.equal(service?.packDir, vendor);
    assert.equal(service?.list().find((s) => s.name === 'vendor-demo')?.description, 'vendor v1');
    writeFileSync(file, v2, 'utf-8');
    service?.invalidateCache();
    const updated = service?.list().find((s) => s.name === 'vendor-demo');
    assert.equal(updated?.description, 'vendor v2');
    assert.deepEqual(updated?.triggers, ['v2']);
    assert.equal(readFileSync(file, 'utf-8'), v2);
    skillsPlugin.onStop?.();
  });
});
