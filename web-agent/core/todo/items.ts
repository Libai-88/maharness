import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { blank, mergeState, normalize, nextDue, taskDefaults, type Task, type WorkbenchState } from '../../plugins/workbench/model';
import type { MaterialRef } from '../../kernel/material';

export class ItemError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'ItemError'; }
}
export function isItemError(error: unknown): error is ItemError {
  const value = error as Partial<ItemError> | null;
  return !!value && value.name === 'ItemError' && Number.isInteger(value.status) && value.status! >= 400 && value.status! < 600 && typeof value.code === 'string' && typeof value.message === 'string';
}
export interface PersonalItem extends Task {
  revision: number; lifecycle: 'todo' | 'review' | 'done' | 'archived';
  dueTime?: string; timeZone: string; sourceSessionId?: string; executionSessionId?: string;
  materials: MaterialRef[]; archivedFrom?: string;
}
export interface ItemAttempt { itemId: string; runId: string; itemRevision: number; createdAt: number }
export interface WorkbenchSnapshot { revision: number; data: WorkbenchState }
const fail = (code: string, message: string, status = 400): never => { throw new ItemError(status, code, message); };
function bounded(value: unknown, max: number, label: string) {
  if (typeof value !== 'string' || value.length > max) return fail('INVALID_ITEM', `${label}格式或长度无效`);
  return value.trim();
}
function validDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value; }

/** Plugin-owned database; every call closes its connection, including failed migrations. */
export class PersonalItems {
  readonly file: string;
  constructor(readonly dataDir: string, private changed: (tenant: string, id?: string) => void = () => {}, private quota?: { assertWritable(tenant: string, bytes: number): void; invalidate(tenant: string): void }) {
    mkdirSync(dataDir, { recursive: true }); this.file = join(dataDir, 'personal-items.sqlite');
    this.db(db => db.exec(`CREATE TABLE IF NOT EXISTS workspaces (tenant TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (tenant TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(tenant,key));
      CREATE TABLE IF NOT EXISTS execution_intents (tenant TEXT NOT NULL, item_id TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(tenant,item_id,key));
      CREATE TABLE IF NOT EXISTS imports (tenant TEXT NOT NULL, source TEXT NOT NULL, item_id TEXT, PRIMARY KEY(tenant,source));
      CREATE TABLE IF NOT EXISTS attempts (tenant TEXT NOT NULL, item_id TEXT NOT NULL, run_id TEXT NOT NULL, item_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(tenant,run_id));`));
  }
  private db<T>(fn: (db: Database.Database) => T): T { const db = new Database(this.file); db.pragma('busy_timeout = 5000'); try { return fn(db); } finally { db.close(); } }
  private snapshot(db: Database.Database, tenant: string): WorkbenchSnapshot {
    const row = db.prepare('SELECT revision,data FROM workspaces WHERE tenant=?').get(tenant) as { revision: number; data: string } | undefined;
    return row ? { revision: row.revision, data: JSON.parse(row.data) } : { revision: 0, data: blank() };
  }
  private write(db: Database.Database, tenant: string, data: WorkbenchState, revision: number) {
    const raw = JSON.stringify(data);
    if (Buffer.byteLength(raw) > 5 * 1024 * 1024 || data.tasks.length > 2000 || data.notes.length > 1000 || data.projects.length > 1000) fail('ITEM_LIMIT', '事项或工作台数据超限');
    const old = this.snapshot(db, tenant);
    this.quota?.assertWritable(tenant, Math.max(0, Buffer.byteLength(raw) - Buffer.byteLength(JSON.stringify(old.data))));
    db.prepare('INSERT INTO workspaces VALUES(?,?,?) ON CONFLICT(tenant) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(tenant, revision, raw);
    this.quota?.invalidate(tenant);
  }
  private decorate(task: Task): PersonalItem {
    return { ...task, revision: Number(task.revision) || 1, lifecycle: task.lifecycle === 'archived' || task.status === 'cancel' ? 'archived' : task.done ? 'done' : task.lifecycle === 'review' ? 'review' : 'todo', timeZone: typeof task.timeZone === 'string' ? task.timeZone : 'Asia/Shanghai', materials: Array.isArray(task.materials) ? task.materials as MaterialRef[] : [] };
  }
  private migrate(tenant: string) {
    if (tenant !== 'default') return;
    this.db(db => db.transaction(() => {
      if (db.prepare('SELECT 1 FROM imports WHERE tenant=? AND source=?').get(tenant, 'server-workbench-v1')) return;
      let state = blank();
      for (const file of [join(this.dataDir, 'workbench.json'), join(process.env.WORKBENCH_BRIDGE_DIR || join(this.dataDir, 'workbench-bridge'), 'workbench-data.json')]) {
        if (!existsSync(file)) continue;
        let input: unknown;
        try { const raw = readFileSync(file); if (raw.length > 5 * 1024 * 1024) throw new Error('文件超过 5 MB'); input = JSON.parse(raw.toString('utf8')); }
        catch { fail('MIGRATION_FAILED', '旧工作台数据无法读取，原文件保留', 503); }
        if (!input || typeof input !== 'object' || !['tasks','notes','projects'].some(key => Array.isArray((input as any)[key])) || ['tasks','notes','projects'].some(key => (input as any)[key] !== undefined && !Array.isArray((input as any)[key]))) fail('MIGRATION_FAILED', '旧工作台格式无效，原文件保留', 503);
        if (!existsSync(file + '.before-items')) copyFileSync(file, file + '.before-items', 1);
        const legacy = input as any;
        if (file.endsWith('workbench.json')) {
          legacy.tasks = (legacy.tasks ?? []).map((task: any) => ({ ...task, due: task.due ?? task.date ?? '', dueTime: task.dueTime ?? task.time, note: task.note ?? task.notes ?? '', pid: task.pid ?? task.projectId ?? '' }));
          legacy.projects = (legacy.projects ?? []).map((project: any) => ({ ...project, stage: project.stage ?? project.desc ?? '', status: project.status === 'paused' ? 'blocked' : project.status }));
        }
        state = mergeState(state, normalize(legacy));
      }
      for (const kind of ['tasks', 'notes', 'projects'] as const) state[kind] = state[kind].filter(item => !item._s) as never;
      const current = this.snapshot(db, tenant); state = mergeState(state, current.data);
      state.tasks = state.tasks.map(task => this.decorate(task));
      this.write(db, tenant, state, current.revision + 1);
      db.prepare('INSERT INTO imports VALUES(?,?,NULL)').run(tenant, 'server-workbench-v1');
    })());
  }
  workspace(tenant: string) { this.migrate(tenant); return this.db(db => this.snapshot(db, tenant)); }
  list(tenant: string) { return this.workspace(tenant).data.tasks.map(task => this.decorate(task)); }
  get(tenant: string, id: string) { return this.list(tenant).find(item => item.id === id) ?? fail('ITEM_NOT_FOUND', '事项不存在', 404); }
  private mutate<T>(tenant: string, fn: (state: WorkbenchState, db: Database.Database) => T): T {
    this.migrate(tenant);
    const result = this.db(db => db.transaction(() => { const current = this.snapshot(db, tenant); const result = fn(current.data, db); this.write(db, tenant, current.data, current.revision + 1); return result; })());
    this.changed(tenant); return result;
  }
  saveWorkspace(tenant: string, input: unknown, revision: number, importing = false) {
    if (!input || typeof input !== 'object' || !['tasks', 'notes', 'projects'].every(key => Array.isArray((input as any)[key]))) fail('INVALID_WORKBENCH', '工作台格式无效');
    this.migrate(tenant);
    this.db(db => db.transaction(() => {
      const current = this.snapshot(db, tenant);
      if (current.revision !== revision) fail('VERSION_CONFLICT', '工作台已变化，请刷新后重试；未提交内容保留', 409);
      const rawTasks = (input as WorkbenchState).tasks;
      if (rawTasks.some(task => !task || typeof task.id !== 'string' || !task.id || typeof task.title !== 'string' || !task.title.trim()) || new Set(rawTasks.map(task => task.id)).size !== rawTasks.length) fail('INVALID_WORKBENCH', '事项需要唯一 ID 和非空标题');
      const next = normalize(input);
      for (const kind of ['tasks', 'notes', 'projects'] as const) next[kind] = next[kind].filter(item => !item._s) as never;
      const merged = importing ? mergeState(current.data, next) : next;
      merged.tasks = merged.tasks.map(task => {
        const old = current.data.tasks.find(item => item.id === task.id);
        const item = this.decorate(task);
        const protectedFields = old ? this.decorate(old) : undefined;
        Object.assign(item, { materials: protectedFields?.materials ?? [], sourceSessionId: protectedFields?.sourceSessionId, executionSessionId: protectedFields?.executionSessionId });
        if (old?.lifecycle === 'archived' && task.status !== 'cancel' && !task.done) item.lifecycle = 'todo';
        if (item.lifecycle === 'archived') item.status = 'cancel';
        item.lifecycle = task.done ? 'done' : item.lifecycle === 'done' ? 'todo' : item.lifecycle;
        item.revision = old ? (Number(old.revision) || 1) + (JSON.stringify(old) === JSON.stringify(task) ? 0 : 1) : 1;
        this.validate(item); return item;
      });
      for (const old of current.data.tasks) if (!merged.tasks.some(task => task.id === old.id)) merged.tasks.push({ ...this.decorate(old), lifecycle: 'archived', status: 'cancel', revision: (Number(old.revision) || 1) + 1, updatedAt: Date.now() });
      this.write(db, tenant, merged, revision + 1);
    })()); this.changed(tenant); return this.workspace(tenant);
  }
  private validate(item: PersonalItem) {
    item.title = bounded(item.title, 200, '标题'); if (!item.title) fail('INVALID_ITEM', '标题不能为空');
    item.note = bounded(item.note, 2000, '说明');
    if (typeof item.due !== 'string' || (item.due && !validDate(item.due))) fail('INVALID_DATE', '日期无效');
    if (typeof item.pid !== 'string' || item.pid.length > 200) fail('INVALID_ITEM', '项目格式无效');
    if (item.dueTime !== undefined && typeof item.dueTime !== 'string') fail('INVALID_TIME', '时间格式无效');
    if (item.dueTime && (!item.due || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.dueTime))) fail('INVALID_TIME', '具体时间需要日期，格式为 HH:mm');
    if (typeof item.timeZone !== 'string' || !item.timeZone) fail('INVALID_TIMEZONE', '时区无效');
    try { new Intl.DateTimeFormat('en', { timeZone: item.timeZone }).format(); } catch { fail('INVALID_TIMEZONE', '时区无效'); }
    if (!['todo','doing','wait','cancel'].includes(item.status)) fail('INVALID_ITEM', '事项状态无效');
    if (!['todo', 'review', 'done', 'archived'].includes(item.lifecycle) || ![1,2,3,4].includes(item.prio) || !['', 'daily','weekdays','weekly','monthly'].includes(item.repeat)) fail('INVALID_ITEM', '状态、优先级或重复规则无效');
    if (!Array.isArray(item.materials) || item.materials.length > 10 || item.materials.some(ref => !ref || typeof ref.id !== 'string' || !ref.id || ref.id.length > 200 || typeof ref.version !== 'string' || !/^[a-f0-9]{64}$/.test(ref.version))) fail('INVALID_MATERIALS', '资料引用无效');
    if (new Set(item.materials.map(ref => ref.id)).size !== item.materials.length) fail('INVALID_MATERIALS', '不能重复关联相同文件');
  }
  create(tenant: string, args: Record<string, any>, sourceSessionId?: string) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('INVALID_ITEM', '事项格式无效');
    return this.mutate(tenant, (state, db) => {
      const fingerprint = createHash('sha256').update(JSON.stringify([args.title, args.note ?? '', args.due ?? '', args.dueTime ?? '', args.timeZone ?? 'Asia/Shanghai', args.prio ?? 3, args.projectId ?? '', args.repeat ?? '', args.materials ?? [], sourceSessionId ?? ''])).digest('hex');
      const key = args.operationId;
      if (key !== undefined && (typeof key !== 'string' || key.length > 100 || !key)) fail('INVALID_OPERATION', '操作标识无效');
      if (key) { const prior = db.prepare('SELECT item_id FROM imports WHERE tenant=? AND source=?').get(tenant, `create:${key}`) as { item_id: string } | undefined; if (prior) {
        const operation = db.prepare('SELECT fingerprint FROM operations WHERE tenant=? AND key=?').get(tenant,key) as { fingerprint: string } | undefined;
        if (operation && operation.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '同一操作标识对应不同内容', 409);
        return this.decorate(state.tasks.find(task => task.id === prior.item_id)!);
      } }
      const item = this.decorate(taskDefaults({ id: randomUUID(), title: args.title, note: args.note ?? '', due: args.due ?? '', prio: args.prio ?? 3, pid: args.projectId ?? '', repeat: args.repeat ?? '', status: args.status ?? 'todo' }));
      Object.assign(item, { timeZone: args.timeZone ?? 'Asia/Shanghai', dueTime: args.dueTime, materials: args.materials ?? [], sourceSessionId });
      this.validate(item); state.tasks.unshift(item);
      if (key) { db.prepare('INSERT INTO imports VALUES(?,?,?)').run(tenant, `create:${key}`, item.id); db.prepare('INSERT INTO operations VALUES(?,?,?)').run(tenant,key,fingerprint); }
      return item;
    });
  }
  update(tenant: string, id: string, revision: number, patch: Record<string, any>) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('INVALID_ITEM', '修改格式无效');
    return this.mutate(tenant, state => {
      const index = state.tasks.findIndex(task => task.id === id); if (index < 0) return fail('ITEM_NOT_FOUND', '事项不存在', 404);
      const old = this.decorate(state.tasks[index]!);
      if (old.revision !== revision) fail('VERSION_CONFLICT', '事项已变化，请重新读取后修改', 409);
      const allowed = ['title','note','prio','due','dueTime','timeZone','repeat','pid','materials','lifecycle','executionSessionId','status'];
      const item = { ...old, ...Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key))), revision: old.revision + 1, updatedAt: Date.now() } as PersonalItem;
      if (item.lifecycle === 'archived') item.status = 'cancel'; else if (old.lifecycle === 'archived') item.status = patch.status ?? 'todo';
      this.validate(item); item.done = item.lifecycle === 'done'; item.doneAt = item.done ? Date.now() : null;
      state.tasks[index] = item;
      if (item.done && !old.done && item.repeat && item.due) state.tasks.push({ ...item, id: randomUUID(), lifecycle: 'todo', done: false, doneAt: null, revision: 1, due: nextDue(item.due, item.repeat), executionSessionId: undefined, createdAt: Date.now() });
      return item;
    });
  }
  executionIntent(tenant: string, id: string, key: string, revision?: number): number | undefined {
    return this.db(db => {
      if (revision !== undefined) db.prepare('INSERT OR IGNORE INTO execution_intents VALUES(?,?,?,?)').run(tenant,id,key,revision);
      return (db.prepare('SELECT revision FROM execution_intents WHERE tenant=? AND item_id=? AND key=?').get(tenant,id,key) as {revision:number} | undefined)?.revision;
    });
  }
  allAttempts(tenant: string): ItemAttempt[] { return this.db(db => db.prepare('SELECT item_id AS itemId,run_id AS runId,item_revision AS itemRevision,created_at AS createdAt FROM attempts WHERE tenant=? ORDER BY created_at DESC').all(tenant) as ItemAttempt[]); }
  attempts(tenant: string, id: string): ItemAttempt[] { this.get(tenant, id); return this.db(db => db.prepare('SELECT item_id AS itemId,run_id AS runId,item_revision AS itemRevision,created_at AS createdAt FROM attempts WHERE tenant=? AND item_id=? ORDER BY created_at DESC').all(tenant,id) as ItemAttempt[]); }
  attach(tenant: string, id: string, runId: string, revision: number) { this.db(db => db.prepare('INSERT OR IGNORE INTO attempts VALUES(?,?,?,?,?)').run(tenant,id,runId,revision,Date.now())); this.changed(tenant,id); }
  review(tenant: string, id: string, revision: number) { const item = this.get(tenant,id); if (item.revision === revision && item.lifecycle === 'todo') return this.update(tenant,id,revision,{ lifecycle: 'review' }); return item; }
  importLegacy(tenant: string, card: { id: string; title: string; desc?: string; priority: string; status: string; sessionId?: string }) {
    const item = this.create(tenant, { operationId: `legacy:${card.id}`, title: card.title, note: card.desc ?? '', status: card.status === 'doing' ? 'doing' : card.status === 'blocked' ? 'wait' : 'todo', prio: ({ urgent:1,high:2,medium:3,low:4 } as Record<string,number>)[card.priority] ?? 3 }, card.sessionId);
    if (card.status === 'done' && item.lifecycle === 'todo') return this.update(tenant,item.id,item.revision,{ lifecycle:'done' });
    return item;
  }
}
