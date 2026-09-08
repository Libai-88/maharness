/**
 * kernel/skillsSync.ts —— 开源技能安装（skills-lock.json → 本机 data/skills/）
 * 锁文件格式（与 Claude Code 的 skills-lock.json 对齐）：
 *   { version: 1, skills: { <name>: { source: "owner/repo", sourceType: "github",
 *                                     skillPath: "skills/<name>/SKILL.md", computedHash: "sha256hex" } } }
 * 实现：git sparse-checkout 拉单目录（零新依赖，复用本机 git）→ 校验 SKILL.md 哈希 → 整目录落盘。
 * 哈希不符默认拒绝（防止上游静默变更），force 时放行并在结果里标记 mismatch。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, copyFileSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface LockSkillEntry {
  source: string;
  sourceType?: string;
  skillPath: string;
  computedHash?: string;
}

export interface LockFile { version?: number; skills: Record<string, LockSkillEntry> }

export interface SyncResult {
  name: string;
  ok: boolean;
  installed?: boolean;
  skipped?: 'already-present';
  mismatch?: boolean;
  error?: string;
  hash?: string;
  files?: number;
}

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (err) {
      rejectP(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      rejectP(new Error(`${cmd} 超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); rejectP(err); });
    child.on('close', (code) => { clearTimeout(timer); resolveP({ code: code ?? -1, stdout, stderr }); });
  });
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 解析锁文件（根目录或其父目录各找一次）；找不到返回 null 而非报错 */
export function readLockFile(rootDir: string): { file: string | null; data: LockFile | null; error?: string } {
  const candidates = [join(rootDir, 'skills-lock.json'), join(dirname(rootDir), 'skills-lock.json')];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    try {
      const parsed = JSON.parse(readFileSync(f, 'utf-8')) as LockFile;
      if (!parsed || typeof parsed.skills !== 'object' || parsed.skills === null) {
        return { file: f, data: null, error: '锁文件缺少 skills 字段' };
      }
      return { file: f, data: parsed };
    } catch (err) {
      return { file: f, data: null, error: `锁文件解析失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { file: null, data: null };
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(join(dir, e.name));
    else if (e.isFile()) n++;
  }
  return n;
}

function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

/** 单个技能安装：sparse-checkout 取子目录 → 校验哈希 → 落盘 */
export async function installSkill(
  name: string,
  entry: LockSkillEntry,
  destSkillsDir: string,
  opts: { force?: boolean; gitCmd?: string } = {},
): Promise<SyncResult> {
  const safeName = String(name).replace(/[^\w.-]/g, '');
  if (!safeName) return { name, ok: false, error: '技能名不合法' };
  if (!entry.source || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(entry.source)) {
    return { name, ok: false, error: `仅支持 owner/repo 形式的 github 源（当前 ${entry.source || '空'}）` };
  }
  const rel = String(entry.skillPath ?? '').replace(/\\/g, '/');
  if (!rel.endsWith('SKILL.md')) return { name, ok: false, error: `skillPath 须指向 SKILL.md（当前 ${rel}）` };
  const destDir = join(destSkillsDir, safeName);
  if (existsSync(join(destDir, 'SKILL.md')) && !opts.force) {
    return { name: safeName, ok: true, installed: false, skipped: 'already-present' };
  }
  const git = opts.gitCmd ?? 'git';
  let tmp = '';
  try {
    tmp = mkdtempSync(join(tmpdir(), 'mh-skill-'));
    const clone = await run(git, ['clone', '--depth', '1', '--filter=blob:none', '--sparse',
      `https://github.com/${entry.source}.git`, tmp], undefined, 180_000);
    if (clone.code !== 0) return { name: safeName, ok: false, error: `git clone 失败: ${(clone.stderr || clone.stdout).slice(0, 300)}` };
    const sparse = await run(git, ['-C', tmp, 'sparse-checkout', 'set', dirname(rel)], tmp, 60_000);
    if (sparse.code !== 0) return { name: safeName, ok: false, error: `sparse-checkout 失败: ${sparse.stderr.slice(0, 300)}` };
    const srcMd = join(tmp, rel);
    if (!existsSync(srcMd)) return { name: safeName, ok: false, error: `仓库中不存在 ${rel}` };
    const hash = sha256File(srcMd);
    if (entry.computedHash && hash !== entry.computedHash && !opts.force) {
      return { name: safeName, ok: false, mismatch: true, hash, error: `哈希与锁文件不符（锁 ${entry.computedHash.slice(0, 12)}… 实际 ${hash.slice(0, 12)}…），确认上游变更后用 force 安装` };
    }
    const srcSkillDir = dirname(srcMd);
    copyTree(srcSkillDir, destDir);
    return { name: safeName, ok: true, installed: true, hash, mismatch: !!(entry.computedHash && hash !== entry.computedHash), files: countFiles(destDir) };
  } catch (err) {
    return { name: safeName, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败无害 */ } }
  }
}

/** 目录是否存在且可读为目录（供路由层做参数校验） */
export function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
