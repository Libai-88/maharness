/**
 * server/routes/workspaces.ts —— 工作区（切换热生效：沙箱边界、文件 API、Agent 工具立即跟随）
 *
 * A6-2 收口（危险工作区根）：沙箱根是可被一次 POST 改写的「边界定义者」——
 * 把 sandboxRoot 切到 `C:\` 之后，`kernel/sandbox.ts` 的保护区名单是按**新根**算相对路径的
 * （`C:\Windows\x` → `windows/x`），于是「项目 data/、.env 不可写」这类保护整体失效，
 * 文件写接口等于任意写。所以这里在**登记**与**切换**两个入口都拒绝：
 *   · 文件系统根 / 盘符根（`C:\`、`D:\`、`/`、UNC 根 `\\srv\share`）；
 *   · 家目录本身及其祖先（`os.homedir()`、`C:\Users`——切到这儿等于交出全部用户配置）；
 *   · 操作系统/程序目录（SystemRoot、ProgramFiles、ProgramData、LocalAppData 及其祖先）；
 *   · 层级过浅/过短的路径（末段目录名 <2 字符，如 `C:\a`；或整路径 <4 字符）。
 * 判定纯函数化（assessWorkspaceRoot）并导出：server/index.ts 的种子工作区、切换入口
 * 与测试共用同一口径，不出现「POST 拦住了但 DB 里的老数据仍能切过去」的缝隙——
 * /switch 会对**已登记**路径复检，正是为了兜住修复前就已入库的危险行。
 */
import type { Express } from 'express';
import { existsSync, statSync } from 'node:fs';
import { dirname, parse, relative, resolve, sep } from 'node:path';
import * as os from 'node:os';
import type { RouteDeps } from './shared';

/** 拒绝理由 + 中文提示（ok=false 时 message 必填，直接进 4xx body） */
export interface WorkspaceRootVerdict {
  ok: boolean;
  /** 中文错误信息（拒绝时）；通过时为 undefined */
  message?: string;
  /** 命中的规则标识（日志/测试断言用，不参与展示） */
  rule?: 'fs-root' | 'home' | 'home-ancestor' | 'system-dir' | 'too-shallow';
}

/** 归一化比对形式：Windows 大小写不敏感 + 去掉尾部分隔符（根除外） */
function canonical(p: string): string {
  const abs = resolve(p);
  const trimmed = abs.length > 1 ? abs.replace(/[\\/]+$/, '') : abs;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** 文件系统根/盘符根/UNC 根：dirname(自身) === 自身，或解析后就是该路径的 root 段 */
function isFileSystemRoot(abs: string): boolean {
  return dirname(abs) === abs || parse(abs).root === abs;
}

/** a 是否为 b 的严格祖先目录（a !== b 且 b 落在 a 之下） */
function isStrictAncestor(a: string, b: string): boolean {
  const ca = canonical(a);
  const cb = canonical(b);
  if (ca === cb) return false;
  return cb.startsWith(ca.endsWith(sep) ? ca : ca + sep);
}

/** 受保护的「系统级目录」：SystemRoot / ProgramFiles / ProgramData（POSIX 用经典系统目录） */
function systemDirs(): string[] {
  const keys = ['SystemRoot', 'WINDIR', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA'];
  const out = keys.map((k) => process.env[k]).filter((v): v is string => !!v && !!v.trim());
  if (process.platform !== 'win32') out.push('/usr', '/etc', '/var', '/bin', '/sbin', '/lib');
  return out;
}

/**
 * 判定一个候选工作区根是否可用（纯函数，无 I/O）。
 * 通过返回 {ok:true}；拒绝返回中文理由。规则顺序即优先级（先命中先报）。
 */
export function assessWorkspaceRoot(rawPath: string): WorkspaceRootVerdict {
  const abs = resolve(String(rawPath ?? '').trim());
  const home = (() => { try { return os.homedir(); } catch { return ''; } })();

  if (isFileSystemRoot(abs)) {
    return {
      ok: false, rule: 'fs-root',
      message: `拒绝：不能把文件系统根目录（${abs}）设为工作区。沙箱保护区名单按工作区根算相对路径，`
        + '根目录一旦成为沙箱根，.env / data/ 等写保护就会整体失效（等于任意写）。'
        + '请改选具体项目目录。',
    };
  }
  if (home && canonical(abs) === canonical(home)) {
    return {
      ok: false, rule: 'home',
      message: `拒绝：不能把家目录本身（${home}）设为工作区——那会把浏览器配置、SSH 密钥、`
        + '各类凭据文件全部纳入 Agent 的可读写范围。请在其下选一个具体项目目录。',
    };
  }
  if (home && isStrictAncestor(abs, home)) {
    return {
      ok: false, rule: 'home-ancestor',
      message: `拒绝：路径（${abs}）是家目录（${home}）的上层目录，等价于交出全部用户配置目录，`
        + '不能作为工作区。',
    };
  }
  // 系统/程序目录：本身、它的祖先、以及它下面的任何一层都拒（这条链上任一节点都不该是工作区根）
  const hitSystem = systemDirs().find((d) => {
    const c = canonical(d);
    const a = canonical(abs);
    return a === c || isStrictAncestor(a, c) || isStrictAncestor(c, a);
  });
  if (hitSystem) {
    return {
      ok: false, rule: 'system-dir',
      message: `拒绝：路径（${abs}）落在操作系统/程序目录内或其上层（${hitSystem}），不能作为工作区根。`,
    };
  }
  // 层级过浅/过短：末段不足 2 字符（`C:\a`、`D:\b`），或整路径短于 4 字符（POSIX `/ab`）。
  // 这类名字与盘符根只差一个字符、且几乎没有「项目边界」可言，误点的代价极高。
  // 注意不过滤「根下只有一层」——`D:\DEEPSEEK`、`C:\Work` 是合法的个人项目位置。
  const rel = relative(parse(abs).root, abs);
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  if (!segs.length || last.length < 2 || abs.length < 4) {
    return {
      ok: false, rule: 'too-shallow',
      message: `拒绝：工作区路径过浅或过短（${abs}）——目录名至少 2 个字符，`
        + '且不能只是盘符根/根目录下的一层单字符名。请选一个具体的项目目录。',
    };
  }
  return { ok: true };
}

/** 供 index.ts 种子逻辑与路由共用的判定（true = 可作为工作区根） */
export function isSafeWorkspaceRoot(p: string): boolean {
  return assessWorkspaceRoot(p).ok;
}

export function registerWorkspaceRoutes(app: Express, deps: RouteDeps): void {
  const { kernel, store } = deps;

  app.get('/api/workspaces', (_req, res) => {
    const current = resolve(kernel.config.get<string>('sandboxRoot', kernel.rootDir));
    res.json(store.listWorkspaces().map((w) => ({
      id: w.id, path: w.path, current: resolve(w.path) === current,
      // A6-2：修复前就可能登记过盘符根/家目录；这里如实标出，前端可禁用切换并提示删除
      dangerous: !isSafeWorkspaceRoot(w.path),
    })));
  });

  app.post('/api/workspaces', (req, res) => {
    const path = String(req.body?.path ?? '').trim();
    if (!path) return res.status(400).json({ error: '缺少路径' });
    const abs = resolve(path);
    // A6-2 登记入口拒绝危险根（错误信息中文，见文件头规则清单）
    const verdict = assessWorkspaceRoot(abs);
    if (!verdict.ok) return res.status(400).json({ error: verdict.message, rule: verdict.rule });
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return res.status(400).json({ error: '目录不存在或不是目录' });
    const row = store.addWorkspace(abs);
    res.json({ id: row.id, path: row.path });
  });

  app.delete('/api/workspaces/:id', (req, res) => {
    if (!store.removeWorkspace(req.params.id)) return res.status(404).json({ error: '工作区不存在' });
    res.json({ ok: true });
  });

  app.post('/api/workspaces/switch', (req, res) => {
    const path = String(req.body?.path ?? '').trim();
    if (!path) return res.status(400).json({ error: '缺少路径' });
    const abs = resolve(path);
    // C-S3 白名单：仅接受 workspaces 表已登记的路径——沙箱根不可被一次 POST 任意
    // 改到 C:\ 等任意目录（新增工作区须走 POST /api/workspaces 显式登记）。
    // Windows 大小写不敏感路径语义：resolve 后小写比对。
    const registered = store.listWorkspaces().map((w) => resolve(w.path));
    const match = registered.find((p) => p.toLowerCase() === abs.toLowerCase());
    if (!match) {
      return res.status(400).json({ error: '该路径未登记为工作区（请先在工作区列表中添加）', available: registered });
    }
    // A6-2 切换入口复检：兜住「修复前已入库的危险路径」——登记过也不给切。
    const verdict = assessWorkspaceRoot(match);
    if (!verdict.ok) return res.status(400).json({ error: verdict.message, rule: verdict.rule });
    if (!existsSync(match) || !statSync(match).isDirectory()) return res.status(400).json({ error: '目录不存在或不是目录' });
    kernel.config.set('sandboxRoot', match); // 运行时热切换（文件工具/文件 API 下一轮生效）
    res.json({ ok: true, current: match });
  });
}
