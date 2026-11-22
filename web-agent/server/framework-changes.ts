import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
interface FileState {
  path: string;
  hash: string | null;
}
export interface FrameworkChange {
  id: string;
  tenantId: string;
  workspace: string;
  source: string;
  createdAt: number;
  state: 'editing' | 'review' | 'adopted';
  baseline: FileState[];
  review?: { digest: string; files: FileState[]; diff: string };
  validation?: { ok: boolean; digest: string; commands: { command: string; ok: boolean; output: string }[] };
}
const forbidden = (path: string) =>
  path
    .split(/[\\/]/)
    .some(
      (part) =>
        ['.git', 'data', 'node_modules', '.env', '.npmrc', '.netrc', 'secret.key', 'config.json'].includes(part.toLowerCase()) ||
        /^\.env\./i.test(part) ||
        /\.(pem|key|p12|pfx)$/i.test(part),
    );
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');
function safeFile(root: string, path: string): string {
  root = resolve(root);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || forbidden(rel))
    throw new Error(`不允许的框架修改路径: ${path}`);
  let cursor = absolute;
  while (cursor !== root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`不允许修改符号链接: ${path}`);
    cursor = dirname(cursor);
  }
  return absolute;
}
function state(root: string, path: string): FileState {
  const file = safeFile(root, path);
  return { path, hash: existsSync(file) ? hash(readFileSync(file)) : null };
}

/** Git worktrees isolate edits and test data; they do not provide OS isolation. */
export class FrameworkChanges {
  private root?: string;
  private management?: string;
  private adopting = false;
  private initialization?: Promise<void>;
  private busy = new Set<string>();
  constructor(private readonly project: string) {}
  private async init() {
    this.initialization ??= (async () => {
      const root = resolve((await this.git(this.project, ['rev-parse', '--show-toplevel'])).trim());
      const gitDir = (await this.git(root, ['rev-parse', '--git-common-dir'])).trim();
      const management = join(resolve(root, gitDir), 'maharness', 'framework-changes');
      mkdirSync(management, { recursive: true });
      this.root = root;
      this.management = management;
    })().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
  }
  isBusy(id: string) {
    return this.busy.has(id);
  }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new Error('该隔离副本正在检查或采纳');
    this.busy.add(id);
    try {
      return await action();
    } finally {
      this.busy.delete(id);
    }
  }
  private async git(cwd: string, args: string[]) {
    return (await execute('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;
  }
  private save(change: FrameworkChange) {
    writeFileSync(join(this.management!, change.id, 'record.json'), JSON.stringify(change), 'utf8');
  }
  async list(tenant: string) {
    await this.init();
    return readdirSync(this.management!).flatMap((id) => {
      try {
        const record = JSON.parse(readFileSync(join(this.management!, id, 'record.json'), 'utf8')) as FrameworkChange;
        return record.tenantId === tenant ? [record] : [];
      } catch {
        return [];
      }
    });
  }
  async get(id: string, tenant: string) {
    await this.init();
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error('修改记录不存在');
    const record = JSON.parse(readFileSync(join(this.management!, id, 'record.json'), 'utf8')) as FrameworkChange;
    if (record.tenantId !== tenant) throw new Error('修改记录不存在');
    return record;
  }
  async create(tenant: string): Promise<FrameworkChange> {
    await this.init();
    const id = randomUUID();
    const folder = join(this.management!, id);
    const copy = join(folder, 'worktree');
    mkdirSync(folder, { recursive: true });
    try {
      await this.git(this.root!, ['worktree', 'add', '--detach', copy, 'HEAD']);
      // A tracked credential must also be absent from the checked-out HEAD.
      for (const path of (await this.git(copy, ['ls-files', '-z'])).split('\0').filter((path) => path && forbidden(path))) {
        const target = resolve(copy, path);
        const rel = relative(copy, target);
        if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('Git 路径越界');
        if (existsSync(target) && !lstatSync(target).isDirectory()) unlinkSync(target);
      }
      const paths = [
        ...new Set(
          (await this.git(this.root!, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
            .split('\0')
            .filter((path) => path && !forbidden(path)),
        ),
      ];
      const baseline = paths.map((path) => state(this.root!, path));
      for (const item of baseline) {
        const target = safeFile(copy, item.path);
        if (item.hash === null) {
          if (existsSync(target)) unlinkSync(target);
        } else {
          const content = readFileSync(safeFile(this.root!, item.path));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
          const before = safeFile(join(folder, 'baseline'), item.path);
          mkdirSync(dirname(before), { recursive: true });
          writeFileSync(before, content);
        }
      }
      const record: FrameworkChange = {
        id,
        tenantId: tenant,
        source: this.root!,
        workspace: join(copy, relative(this.root!, this.project)),
        baseline,
        createdAt: Date.now(),
        state: 'editing',
      };
      this.save(record);
      return record;
    } catch (error) {
      await this.git(this.root!, ['worktree', 'remove', '--force', copy]).catch(() => undefined);
      throw error;
    }
  }
  async review(id: string, tenant: string): Promise<FrameworkChange> {
    return this.exclusive(id, () => this.reviewUnlocked(id, tenant));
  }
  private async reviewUnlocked(id: string, tenant: string): Promise<FrameworkChange> {
    const record = await this.get(id, tenant);
    if (record.state === 'adopted') return record;
    const copy = resolve(record.workspace, relative(this.project, this.root!));
    const paths = [
      ...new Set([
        ...record.baseline.map((file) => file.path),
        ...(await this.git(copy, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean),
      ]),
    ].filter((path) => !forbidden(path));
    const original = new Map(record.baseline.map((file) => [file.path, file.hash]));
    const files = paths.map((path) => state(copy, path)).filter((file) => file.hash !== (original.get(file.path) ?? null));
    const digest = hash(Buffer.from(JSON.stringify(files)));
    const snapshot = join(this.management!, id, 'review', digest);
    mkdirSync(snapshot, { recursive: true });
    const diff: string[] = [];
    for (const file of files) {
      if (file.hash !== null) {
        const target = safeFile(snapshot, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(safeFile(copy, file.path)));
      }
      // Diff against the recorded baseline, including pre-existing uncommitted edits.
      const empty = join(this.management!, id, 'empty');
      writeFileSync(empty, '');
      const before = original.get(file.path) ? safeFile(join(this.management!, id, 'baseline'), file.path) : empty;
      const after = file.hash !== null ? safeFile(snapshot, file.path) : empty;
      try {
        diff.push(await this.git(copy, ['diff', '--no-index', '--no-ext-diff', '--', before, after]));
      } catch (error) {
        const result = error as { code?: number; stdout?: string };
        if (result.code !== 1 || !result.stdout) throw error;
        diff.push(result.stdout);
      }
    }
    record.review = { digest, files, diff: diff.join('\n').slice(0, 500_000) };
    record.state = 'review';
    this.save(record);
    return record;
  }
  async validate(id: string, tenant: string) {
    return this.exclusive(id, async () => {
      const record = await this.reviewUnlocked(id, tenant);
      if (!record.review) throw new Error('没有待检查的修改');
      const results: { command: string; ok: boolean; output: string }[] = [];
      // Credentials and production data are deliberately absent from the test environment.
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key),
        ),
      );
      env.AGENT_DATA_DIR = join(this.management!, id, 'test-data');
      env.CI = '1';
      const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      const commands = [
        ...(existsSync(join(record.workspace, 'package-lock.json')) && !existsSync(join(record.workspace, 'node_modules'))
          ? [['ci', '--no-audit', '--no-fund']]
          : []),
        ...(existsSync(join(record.workspace, 'ui', 'package-lock.json')) && !existsSync(join(record.workspace, 'ui', 'node_modules'))
          ? [['ci', '--prefix', 'ui', '--no-audit', '--no-fund']]
          : []),
        ...['typecheck', 'test', 'build'].map((script) => ['run', script]),
      ];
      for (const args of commands) {
        const command = `npm ${args.join(' ')}`;
        try {
          const result = await execute(process.execPath, [npmCli, ...args], {
            cwd: record.workspace,
            env,
            windowsHide: true,
            timeout: 600_000,
            maxBuffer: 8 * 1024 * 1024,
          });
          results.push({ command, ok: true, output: (result.stdout + result.stderr).slice(-24000) });
        } catch (error) {
          const e = error as Error & { stdout?: string; stderr?: string };
          results.push({ command, ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`.slice(-24000) });
          break;
        }
      }
      const latest = await this.reviewUnlocked(id, tenant);
      latest.validation = {
        digest: record.review.digest,
        ok: results.length === commands.length && results.every((item) => item.ok) && latest.review?.digest === record.review.digest,
        commands: results,
      };
      this.save(latest);
      return latest;
    });
  }
  async adopt(id: string, tenant: string, digest: string) {
    return this.exclusive(id, async () => {
      if (this.adopting) throw new Error('已有框架修改正在采纳');
      this.adopting = true;
      try {
        const record = await this.get(id, tenant);
        if (record.state === 'adopted') return record;
        if (record.review?.digest !== digest || !record.validation?.ok || record.validation.digest !== digest)
          throw new Error('修改需要通过验证并重新审阅');
        const baseline = new Map(record.baseline.map((file) => [file.path, file.hash]));
        for (const file of record.baseline)
          if (state(record.source, file.path).hash !== file.hash) throw new Error(`原工作区已变化，停止采纳: ${file.path}`);
        const snapshot = join(this.management!, id, 'review', digest);
        for (const file of record.review.files) {
          if (state(record.source, file.path).hash !== (baseline.get(file.path) ?? null))
            throw new Error(`原工作区已变化，停止采纳: ${file.path}`);
          if (file.hash !== null && state(snapshot, file.path).hash !== file.hash) throw new Error('审阅快照已变化');
        }
        const backups = record.review.files.map((file) => ({
          path: file.path,
          content: existsSync(safeFile(record.source, file.path)) ? readFileSync(safeFile(record.source, file.path)) : null,
        }));
        try {
          for (const file of record.review.files) {
            const target = safeFile(record.source, file.path);
            if (file.hash === null) {
              if (existsSync(target)) unlinkSync(target);
            } else {
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(target, readFileSync(safeFile(snapshot, file.path)));
            }
          }
        } catch (error) {
          for (const file of backups) {
            const target = safeFile(record.source, file.path);
            if (file.content) writeFileSync(target, file.content);
            else if (existsSync(target)) unlinkSync(target);
          }
          throw error;
        }
        record.state = 'adopted';
        this.save(record);
        return record;
      } finally {
        this.adopting = false;
      }
    });
  }
}
