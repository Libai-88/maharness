/**
 * kernel/sandbox.ts —— 沙箱安全基础设施（从 core/tools-fs 上提）
 * 纯路径操作 + 安全策略，零插件依赖。server 层和 core 插件共同使用。
 */
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { resolve, relative, join, sep } from 'node:path';

// ============ 路径沙箱 ============

/** 将相对路径解析到沙箱内；越界（含 .. 穿越、符号链接逃逸）一律拒绝。
 *  realpath 强化：校验通过后返回真实路径，消除 TOCTOU 窗口。 */
export function resolveInSandbox(sandboxRoot: string, relPath: string): string {
  const root = resolve(sandboxRoot);
  const target = resolve(root, relPath || '.');
  const rootLower = root.toLowerCase();
  const targetLower = target.toLowerCase();
  if (targetLower !== rootLower && !targetLower.startsWith(rootLower + sep)) {
    throw new Error(`路径越界（沙箱根目录: ${root}）: ${relPath}`);
  }
  let current = target;
  for (;;) {
    if (existsSync(current)) {
      const real = resolveSync(current);
      const realLower = real.toLowerCase();
      if (realLower !== rootLower && !realLower.startsWith(rootLower + sep)) {
        throw new Error(`路径指向沙箱外（符号链接）: ${relPath}`);
      }
      const tail = relative(current, target);
      return tail ? join(real, tail) : real;
    }
    // B10：向上找"最近存在的祖先"必须以沙箱根为界。旧写法一路 resolve('..') 走到根之上，
    // 于是当 sandboxRoot 本身不存在时（工作区目录被删、SANDBOX_ROOT 配错、克隆后尚未创建），
    // 第一个存在的祖先是根的父目录 → 命中上面的符号链接分支 → 报「指向沙箱外（符号链接）」，
    // 归因错误且**所有**文件操作都失败（连"在根下新建文件"这种合法动作也被拒）。
    const parent = resolve(current, '..');
    const parentLower = parent.toLowerCase();
    if (parent === current || parentLower !== rootLower && !parentLower.startsWith(rootLower + sep)) {
      // 走到沙箱根之外还没找到存在的祖先 → 说明沙箱根自己就不存在
      throw new Error(`沙箱根目录不存在: ${root}（请先创建该目录或在设置里切换到已存在的工作区）`);
    }
    current = parent;
  }
  return target;
}

function resolveSync(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

// ============ 内核硬保护与敏感清单（A2：双基座判定） ============

/** 项目根（内核、core/、data/ 实际所在）与沙箱根（Agent 文件工具的边界）是两个不同的目录：
 *  `SANDBOX_ROOT` 可以指到别处（当前部署即如此：沙箱根 = D:\DEEPSEEK，项目根 = …\maharness\web-agent）。
 *  旧实现只按 sandboxRoot 算相对路径，于是 `<项目根>/data/secret.key` 的相对路径是
 *  `maharness/web-agent/data/secret.key`——既不等于 'data' 也不以 'data/' 开头，
 *  连「kernel/、core/chat/ 写保护」都能被长路径绕过。所有安全判定必须同时按两个基座算。 */
export interface SandboxBases {
  sandboxRoot: string;
  projectRoot?: string;
}

function relUnder(absPath: string, base: string): string | null {
  const bAbs = resolve(base);
  const aAbs = resolve(absPath);
  const b = bAbs.toLowerCase();
  const a = aAbs.toLowerCase();
  if (a !== b && !a.startsWith(b + sep)) return null;
  return relative(bAbs, aAbs).split(sep).join('/');
}

/** 敏感路径全清单（读写两侧共用同一份，消除"读有名单、写无名单"的结构性不对称）。
 *  返回命中的原因，调用方决定是硬拒（保护区）还是走审批（密钥/数据）。 */
export function sensitiveTarget(absPath: string, bases: SandboxBases): { hit: boolean; reason: string } {
  const roots = [bases.sandboxRoot];
  if (bases.projectRoot && resolve(bases.projectRoot) !== resolve(bases.sandboxRoot)) roots.push(bases.projectRoot);
  for (const base of roots) {
    const rel = relUnder(absPath, base);
    if (rel === null) continue;
    const norm = rel.toLowerCase();
    const leaf = norm.split('/').pop() ?? '';
    if (norm === '.env' || leaf === '.env') return { hit: true, reason: '环境配置与密钥文件 .env' };
    if (norm === 'data' || norm.startsWith('data/')) return { hit: true, reason: '内部数据目录 data/（会话库、主密钥、记忆与规则）' };
    if (norm === 'kernel' || norm.startsWith('kernel/')) return { hit: true, reason: 'agent 运行时核心 kernel/' };
    if (norm === 'core/chat' || norm.startsWith('core/chat/')) return { hit: true, reason: '对话执行循环 core/chat/' };
  }
  return { hit: false, reason: '' };
}

let allowCoreEditCache: boolean | null = null;

/** kernel/ 与 core/chat/ 为 agent 运行时核心：写/删一律拒绝（自我接管防护）。
 *  双基座判定见 `SandboxBases` 注释。 */
export function isProtectedWritePath(absPath: string, sandboxRoot: string, projectRoot?: string): boolean {
  if (allowCoreEditCache === null) allowCoreEditCache = process.env.AGENT_ALLOW_CORE_EDIT === '1';
  if (allowCoreEditCache) return false;
  for (const base of projectRoot ? [sandboxRoot, projectRoot] : [sandboxRoot]) {
    const norm = relUnder(absPath, base)?.toLowerCase();
    if (!norm) continue;
    if (norm === 'kernel' || norm.startsWith('kernel/')
      || norm === 'core/chat' || norm.startsWith('core/chat/')) return true;
  }
  return false;
}

/** 高危写目标（可写但必须用户批准）：`.env` 与 `data/**`。
 *  A2 修复：读侧早有黑名单、写侧什么都没有，于是 `write_file('…/.env')` 默认免审批
 *  就能改写密钥文件与策略规则文件（后者可注入 allow 规则旁路审批门）。 */
export function isApprovalRequiredWritePath(absPath: string, bases: SandboxBases): boolean {
  for (const base of bases.projectRoot ? [bases.sandboxRoot, bases.projectRoot] : [bases.sandboxRoot]) {
    const norm = relUnder(absPath, base)?.toLowerCase();
    if (!norm) continue;
    const leaf = norm.split('/').pop() ?? '';
    if (norm === '.env' || leaf === '.env') return true;
    if (norm === 'data' || norm.startsWith('data/')) return true;
  }
  return false;
}

/** 重置 `AGENT_ALLOW_CORE_EDIT` 的一次性缓存（B10：该开关在进程首次判定后即固化，
 *  测试与 selftest 需要在改变 env 后重置，否则同一进程内的多次断言互相污染）。 */
export function resetCoreEditGuard(): void {
  allowCoreEditCache = null;
}

// ============ 密钥黑名单（C-S4/H10） ============

/** .env 与 data/ 不可读（密钥不进上下文）。双基座判定见 `SandboxBases` 注释。 */
export function isDeniedReadPath(absPath: string, sandboxRoot: string, projectRoot?: string): boolean {
  for (const base of projectRoot ? [sandboxRoot, projectRoot] : [sandboxRoot]) {
    const norm = relUnder(absPath, base)?.toLowerCase();
    if (!norm) continue;
    const leaf = norm.split('/').pop() ?? '';
    if (norm === '.env' || leaf === '.env') return true;
    if (norm === 'data' || norm.startsWith('data/')) return true;
  }
  return false;
}

// ============ 智能读取（编码识别） ============

export interface ReadResult {
  text: string;
  encoding: string;
  isBinary: boolean;
  size: number;
  path: string;
  truncated?: boolean;
  /** 分段读取元信息（read_file）：文件总行数、本次起始/结束行、续读游标 */
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  nextOffset?: number;
}

/** 读取文本文件，自动识别编码（UTF-8/UTF-16/GBK/二进制） */
export function readTextSmart(filePath: string): { text: string; encoding: string; isBinary: boolean } {
  const buf = readFileSync(filePath);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8(BOM)', isBinary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le', isBinary: false };
  }
  if (buf.includes(0)) return { text: '', encoding: 'binary', isBinary: true };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8', isBinary: false };
  } catch {
    try {
      return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk', isBinary: false };
    } catch {
      return { text: buf.toString('utf8'), encoding: 'utf-8(宽松)', isBinary: false };
    }
  }
}
