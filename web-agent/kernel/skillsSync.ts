/**
 * kernel/skillsSync.ts —— 开源技能安装（skills-lock.json → 本机 data/skills/）
 *
 * 锁文件格式（与 Claude Code 的 skills-lock.json 对齐，向后兼容）：
 *   { version: 1, skills: { <name>: { source: "owner/repo", sourceType: "github",
 *                                     skillPath: "skills/<name>/SKILL.md", computedHash: "sha256hex",
 *                                     files?: { "SKILL.md": "sha256hex", "scripts/x.py": "sha256hex" } } } }
 *   · 只有 computedHash（现有全部锁文件）→ 旧语义可用，但会给出「未锚定文件」告警；
 *   · 给出 files（对象或 [{path,sha256}] 数组）→ **逐文件校验**，清单外文件拒绝落盘。
 *
 * A9 收口（技能同步完整性）——三条硬要求：
 *  1. **先落地临时目录、再原子替换**：复制 → 校验「即将发布的那些字节」→ 同卷 rename 换入。
 *     校验失败时目标目录一字未动（既不半成品，也不残留旧文件）；换入时旧目录整体让位，
 *     不再出现「新版本 + 上版本没删干净的文件」混合体（旧实现 copyTree 不清理目标目录）。
 *  2. **校验范围**：有 files 清单逐文件校验（缺失/哈希不符/清单外文件都算失败）；
 *     没有清单时至少把 scripts/** 与可执行扩展名文件全部哈希并记入结果 + 告警
 *     （把「哪些字节没有锚点」如实说出来，并给出可直接粘进锁文件的哈希）。
 *  3. **force 不再跳过完整性校验**：force 的语义是「覆盖已安装」，不是「放弃校验」。
 *     哈希不符即失败并回报 mismatch 与实际哈希；确要接受上游变更，请改锁文件，
 *     或显式设 MAHARNESS_ALLOW_SKILL_HASH_MISMATCH=1（会打 warn 并在结果里标 accepted）。
 *
 * 实现：git sparse-checkout 拉单目录（零新依赖，复用本机 git）→ 临时目录校验 → 原子换入。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, readdirSync, readFileSync,
  statSync, renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

export interface LockSkillEntry {
  source: string;
  sourceType?: string;
  skillPath: string;
  /** SKILL.md 的 sha256（历史唯一锚点；保留，向后兼容） */
  computedHash?: string;
  /**
   * A9-2 逐文件哈希清单（相对技能目录，'/' 分隔）。两种写法都接受：
   *   files: { "SKILL.md": "<sha256hex>", "scripts/x.py": "<sha256hex>" }
   *   files: [ { path: "scripts/x.py", sha256: "<sha256hex>" } ]
   * 给出即视为权威清单：清单外的文件**不落盘**（回报 skippedUnlisted）。
   */
  files?: Record<string, string> | Array<{ path: string; sha256?: string; hash?: string }>;
}

export interface LockFile { version?: number; skills: Record<string, LockSkillEntry> }

/** 一个文件的相对路径 + 实际 sha256 */
export interface SkillFileHash { path: string; sha256: string }

export interface SyncResult {
  name: string;
  ok: boolean;
  installed?: boolean;
  skipped?: 'already-present';
  mismatch?: boolean;
  error?: string;
  hash?: string;
  files?: number;
  /** 本次是否做了逐文件校验（锁文件给了 files 清单） */
  manifest?: boolean;
  /** 逐文件校验通过的文件数 */
  verifiedFiles?: number;
  /** 无清单时：落了盘但没有哈希锚点的文件（含 scripts/**），供运维补锁 */
  unverified?: SkillFileHash[];
  /** 有清单时：清单外、被拒绝落盘的文件 */
  skippedUnlisted?: string[];
  /** 人类可读告警（不阻断安装，但必须让人看见） */
  warnings?: string[];
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

/** 目录内全部文件的相对路径（posix，不做哈希——只为「清单外文件」的回报） */
function listTreeFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTreeFiles(full, base));
    else if (e.isFile()) out.push(full.slice(base.length + 1).split(sep).join('/'));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** 目录内全部文件（相对 base 的 posix 路径）+ 实际 sha256 */
export function listTreeWithHashes(dir: string, base = dir): SkillFileHash[] {
  const out: SkillFileHash[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTreeWithHashes(full, base));
    else if (e.isFile()) {
      out.push({ path: full.slice(base.length + 1).split(sep).join('/'), sha256: sha256File(full) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
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

/** 只复制清单内的文件（保持相对目录结构）；非法/越界路径直接跳过，返回复制条数 */
export function copyListedFiles(srcRoot: string, destRoot: string, paths: string[]): number {
  let n = 0;
  for (const rel of paths) {
    const s = safeJoin(srcRoot, rel);
    const d = safeJoin(destRoot, rel);
    if (!s || !d || !existsSync(s)) continue;
    mkdirSync(dirname(d), { recursive: true });
    copyFileSync(s, d);
    n++;
  }
  return n;
}

/** 相对路径安全拼接（拒绝越界与绝对路径）；非法返回 null */
function safeJoin(root: string, rel: string): string | null {
  const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) return null;
  const abs = resolve(root, clean);
  const r = resolve(root);
  if (abs !== r && !abs.startsWith(r + sep)) return null;
  return abs;
}

/** 可执行/脚本类扩展名：无锚点时必须显式告警（技能指示执行脚本就是执行面） */
const EXEC_EXT = /\.(sh|ps1|psm1|cmd|bat|py|rb|pl|js|mjs|cjs|ts|exe|dll|so|dylib|bin)$/i;

/**
 * 归一化锁文件里的 files 清单。
 * 返回 map=null 表示「锁文件没给清单」（走旧的单点哈希语义，仍向后兼容）。
 */
export function normalizeManifest(entry: LockSkillEntry): { map: Map<string, string> | null; error?: string } {
  const raw = (entry as { files?: unknown }).files;
  if (raw === undefined || raw === null) return { map: null };
  const map = new Map<string, string>();
  const add = (p: unknown, h: unknown) => {
    const rel = String(p ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    const hash = String(h ?? '').trim().toLowerCase();
    if (!rel || !/^[0-9a-f]{64}$/.test(hash)) { map.set(rel || String(p ?? ''), hash || '__invalid__'); return; }
    map.set(rel, hash);
  };
  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (!it || typeof it !== 'object') return { map: null, error: 'files 数组元素须为 {path, sha256}' };
      const o = it as { path?: string; sha256?: string; hash?: string };
      add(o.path, o.sha256 ?? o.hash);
    }
    return { map };
  }
  if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) add(k, v);
    return { map };
  }
  return { map: null, error: 'files 须为 {路径: sha256} 对象或 [{path, sha256}] 数组' };
}

export interface VerifyReport {
  ok: boolean;
  /** SKILL.md 实际哈希（无 SKILL.md 时 undefined） */
  hash?: string;
  /** 逐文件校验通过的文件数（清单模式） */
  verifiedFiles: number;
  manifest: boolean;
  /** 哈希不符（锁与实际不一致） */
  mismatch: boolean;
  errors: string[];
  warnings: string[];
  /** 无锚点落盘文件（清单缺失时） */
  unverified: SkillFileHash[];
  /** 清单外被拒绝的文件（清单存在时） */
  skippedUnlisted: string[];
}

/**
 * 校验**已经落在临时目录里**的技能目录（A9-1：校验对象就是即将发布的那批字节）。
 * @param stagedSkillDir 临时目录里的技能根（含 SKILL.md）
 */
export function verifyStagedSkill(stagedSkillDir: string, entry: LockSkillEntry): VerifyReport {
  const base: VerifyReport = {
    ok: false, verifiedFiles: 0, manifest: false, mismatch: false,
    errors: [], warnings: [], unverified: [], skippedUnlisted: [],
  };
  const mdPath = join(stagedSkillDir, 'SKILL.md');
  if (!existsSync(mdPath)) return { ...base, errors: ['技能目录缺少 SKILL.md'] };
  const hash = sha256File(mdPath);
  const report: VerifyReport = { ...base, hash };
  const actual = listTreeWithHashes(stagedSkillDir);

  const { map, error } = normalizeManifest(entry);
  if (error) { report.errors.push(error); return report; }

  if (map) {
    report.manifest = true;
    // 1) 清单里每条都必须存在且哈希一致
    for (const [rel, want] of map) {
      if (!safeJoin(stagedSkillDir, rel)) { report.errors.push(`清单路径非法: ${rel}`); continue; }
      if (want === '__invalid__' || !/^[0-9a-f]{64}$/.test(want)) {
        report.errors.push(`清单哈希非法（须 64 位 sha256hex）: ${rel}`);
        continue;
      }
      const abs = safeJoin(stagedSkillDir, rel);
      if (!abs || !existsSync(abs)) { report.errors.push(`清单要求的文件不存在: ${rel}`); continue; }
      const got = sha256File(abs);
      if (got !== want) {
        report.mismatch = true;
        report.errors.push(`哈希与锁文件不符: ${rel}（锁 ${want.slice(0, 12)}… 实际 ${got.slice(0, 12)}…）`);
        continue;
      }
      report.verifiedFiles++;
    }
    // 2) SKILL.md 必须在清单里，否则 computedHash 之外的锚点没兜住主文件
    if (!map.has('SKILL.md')) {
      report.warnings.push('files 清单未覆盖 SKILL.md：主文件仅由 computedHash（若有）锚定');
    }
    // 3) 清单外文件不落盘（复制阶段已过滤，这里只如实回报）
    const listed = new Set(map.keys());
    report.skippedUnlisted = actual.filter((f) => !listed.has(f.path)).map((f) => f.path);
    if (report.skippedUnlisted.length) {
      report.warnings.push(`锁清单外的文件已拒绝落盘（${report.skippedUnlisted.length} 个）: ${report.skippedUnlisted.join(', ')}`);
    }
    // 4) 与历史字段的一致性自检（两份锚点互相矛盾要说明，但以 files 清单为准）
    if (entry.computedHash && map.has('SKILL.md') && map.get('SKILL.md') !== entry.computedHash.toLowerCase()) {
      report.warnings.push('锁文件 computedHash 与 files["SKILL.md"] 不一致：本次按 files 清单判定');
    }
    report.ok = report.errors.length === 0;
    return report;
  }

  // ---- 无清单（向后兼容路径）：只有 SKILL.md 一个锚点 ----
  if (entry.computedHash) {
    const want = String(entry.computedHash).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want)) {
      report.errors.push(`锁文件 computedHash 非法（须 64 位 sha256hex）: ${entry.computedHash}`);
      return report;
    }
    if (hash !== want) {
      report.mismatch = true;
      report.errors.push(`哈希与锁文件不符（锁 ${want.slice(0, 12)}… 实际 ${hash.slice(0, 12)}…）`);
      return report;
    }
    report.verifiedFiles = 1;
  }
  report.unverified = actual.filter((f) => f.path !== 'SKILL.md');
  if (report.unverified.length) {
    const risky = report.unverified.filter((f) => /^scripts\//i.test(f.path) || EXEC_EXT.test(f.path));
    const hint = report.unverified.map((f) => `"${f.path}": "${f.sha256}"`).join(', ');
    report.warnings.push(
      `锁文件没有 files 清单：${report.unverified.length} 个文件随 SKILL.md 一起落盘但**没有哈希锚点**`
      + (risky.length ? `，其中 ${risky.length} 个属脚本/可执行文件（${risky.map((f) => f.path).join(', ')}）——技能执行脚本即构成执行面` : '')
      + `。建议把它们钉进锁文件：{ ${hint} }`,
    );
  }
  report.ok = report.errors.length === 0;
  return report;
}

/**
 * 临时目录与让位目录的安放处：skills 根的**父目录**（即 data/），加点前缀名。
 * 为什么不用 skills 根里面：技能加载器会扫 data/skills/* 的每个子目录，
 * 窗口期里的半成品/旧目录会被当成技能读进索引。同卷（必须，否则 Windows 上
 * rename 直接 EXDEV）+ 不在扫描路径上，两者兼得。
 */
function workRootOf(destSkillsDir: string): string {
  return dirname(resolve(destSkillsDir));
}

/**
 * 原子换入（A9-1）：临时目录（与目标同卷）→ 目标目录。
 * 已存在目标时先整体让位（不是逐项覆盖），因此不会留下上一版没被覆盖的残文件；
 * 换入失败则把旧目录放回原位，绝不让技能目录消失。
 */
function atomicSwap(stagingDir: string, destDir: string, destSkillsDir: string): void {
  const workRoot = workRootOf(destSkillsDir);
  mkdirSync(workRoot, { recursive: true });
  const tag = `${basename(destDir)}-${Date.now().toString(36)}-${process.pid}`;
  if (!existsSync(destDir)) {
    renameSync(stagingDir, destDir);
    return;
  }
  const backup = join(workRoot, `.skill-old-${tag}`);
  renameSync(destDir, backup); // 整体让位（同卷 rename，不逐项删）
  try {
    renameSync(stagingDir, destDir);
  } catch (err) {
    try { renameSync(backup, destDir); } catch { /* 放回也失败：下面重抛原始错误，现场保持可查 */ }
    throw err;
  }
  try { rmSync(backup, { recursive: true, force: true }); }
  catch (err) { console.warn('[skills] 旧技能目录清理失败（无害，残留可手删）:', err instanceof Error ? err.message : String(err)); }
}

/**
 * 从**已在本地的技能源目录**安装（A9-1/2/3 的完整链路：复制→校验→原子换入）。
 * installSkill() git 拉取后调它；测试与离线镜像场景也直接调它（无网络、无 git）。
 * 校验失败时目标目录一定保持原样：任何半成品都死在临时目录里。
 */
export function installFromSourceTree(
  name: string,
  entry: LockSkillEntry,
  srcSkillDir: string,
  destSkillsDir: string,
  opts: { force?: boolean; acceptMismatch?: boolean } = {},
): SyncResult {
  const safeName = String(name).replace(/[^\w.-]/g, '');
  if (!safeName) return { name, ok: false, error: '技能名不合法' };
  if (!existsSync(join(srcSkillDir, 'SKILL.md'))) {
    return { name: safeName, ok: false, error: `源目录里没有 SKILL.md: ${srcSkillDir}` };
  }
  const destDir = join(destSkillsDir, safeName);
  if (existsSync(join(destDir, 'SKILL.md')) && !opts.force) {
    return { name: safeName, ok: true, installed: false, skipped: 'already-present' };
  }

  // 临时目录与目标同卷（data/ 下），否则 Windows 上 rename 会 EXDEV
  const workRoot = workRootOf(destSkillsDir);
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(destSkillsDir, { recursive: true });
  const stagingParent = mkdtempSync(join(workRoot, `.skill-staging-${safeName}-`));
  const stagingDir = join(stagingParent, safeName);
  try {
    // 1) 先落地临时目录：有清单只按清单复制（清单外不落盘），没清单整目录复制
    const { map, error } = normalizeManifest(entry);
    if (error) return { name: safeName, ok: false, error };
    let unlisted: string[] = [];
    if (map) {
      const wanted = [...map.keys()];
      const present = wanted.filter((p) => {
        const abs = safeJoin(srcSkillDir, p);
        return !!abs && existsSync(abs);
      });
      // 清单外的源文件：不复制（它们没有锚点，落盘即未经校验的内容）——如实回报名单
      unlisted = listTreeFiles(srcSkillDir).filter((p) => !new Set(wanted).has(p));
      copyListedFiles(srcSkillDir, stagingDir, present);
      if (!present.includes('SKILL.md')) {
        const missing = wanted.filter((p) => !present.includes(p));
        return {
          name: safeName, ok: false,
          error: `锁清单里定位不到 SKILL.md（清单缺项: ${missing.join(', ') || '无'}；`
            + '注意 files 的路径是相对技能目录的，例如 "SKILL.md"、"scripts/run.py"）',
        };
      }
    } else {
      copyTree(srcSkillDir, stagingDir);
    }

    // 2) 校验临时目录里的字节（= 即将发布的那批字节）
    const report = verifyStagedSkill(stagingDir, entry);
    const warnings = [...report.warnings];
    if (unlisted.length) {
      warnings.push(`锁清单未覆盖的源文件已拒绝落盘（${unlisted.length} 个）: ${unlisted.join(', ')}`);
    }
    if (!report.ok) {
      // 唯一的放行出口：显式环境开关（force 不算放弃校验）
      const allowMismatch = opts.acceptMismatch === true || process.env.MAHARNESS_ALLOW_SKILL_HASH_MISMATCH === '1';
      if (!(report.mismatch && allowMismatch)) {
        return {
          name: safeName, ok: false,
          mismatch: report.mismatch || undefined,
          hash: report.hash, manifest: report.manifest,
          error: report.errors.join('; ')
            + (report.mismatch
              ? '——请更新 skills-lock.json 的 computedHash/files 后重装（force 只覆盖已安装，不豁免校验）'
              : ''),
          warnings,
        };
      }
      warnings.push('已按 MAHARNESS_ALLOW_SKILL_HASH_MISMATCH=1 接受与锁文件不符的内容（上游变更未回写锁文件）');
      console.warn(`[skills] ${safeName}: 接受哈希不符的内容（不建议；应把新哈希写回 skills-lock.json）`);
    }

    // 3) 原子换入（失败即目标目录维持原样）
    atomicSwap(stagingDir, destDir, destSkillsDir);
    const files = countFiles(destDir);
    return {
      name: safeName, ok: true, installed: true,
      hash: report.hash, files,
      manifest: report.manifest, verifiedFiles: report.verifiedFiles,
      unverified: report.unverified.length ? report.unverified : undefined,
      skippedUnlisted: unlisted.length ? unlisted : (report.skippedUnlisted.length ? report.skippedUnlisted : undefined),
      warnings: warnings.length ? warnings : undefined,
    };
  } catch (err) {
    return { name: safeName, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // 临时父目录无论成败都清掉：校验失败绝不留半成品（destDir 也未被动过）
    try { rmSync(stagingParent, { recursive: true, force: true }); } catch { /* 临时目录清理失败无害 */ }
  }
}

/** 单个技能安装：sparse-checkout 取子目录 → 临时目录校验 → 原子换入 */
export async function installSkill(
  name: string,
  entry: LockSkillEntry,
  destSkillsDir: string,
  opts: { force?: boolean; gitCmd?: string; srcDir?: string; acceptMismatch?: boolean } = {},
): Promise<SyncResult> {
  const safeName = String(name).replace(/[^\w.-]/g, '');
  if (!safeName) return { name, ok: false, error: '技能名不合法' };
  const rel = String(entry.skillPath ?? '').replace(/\\/g, '/');
  if (!rel.endsWith('SKILL.md')) return { name, ok: false, error: `skillPath 须指向 SKILL.md（当前 ${rel}）` };
  // srcDir：已经在本地的检出根（测试/离线镜像场景），跳过 git
  if (opts.srcDir) {
    return installFromSourceTree(safeName, entry, dirname(join(opts.srcDir, rel)), destSkillsDir, opts);
  }
  if (!entry.source || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(entry.source)) {
    return { name, ok: false, error: `仅支持 owner/repo 形式的 github 源（当前 ${entry.source || '空'}）` };
  }
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
    return installFromSourceTree(safeName, entry, dirname(srcMd), destSkillsDir, opts);
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
