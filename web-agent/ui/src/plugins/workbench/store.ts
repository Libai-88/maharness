import { blank, day, mergeState, normalize, rollover, seed, type WorkbenchState } from '../../../../plugins/workbench/model';

export const KEY = 'pd_workbench_v1';
const FILE = 'workbench-data.json';
interface Directory extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: string }): Promise<PermissionState>;
  requestPermission(options: { mode: string }): Promise<PermissionState>;
  keys(): AsyncIterableIterator<string>;
}
interface Connection { supported: boolean; name: string; active: boolean; denied: boolean; busy: boolean; conflicts: string[]; error: string; stale: boolean }
const picker = () => (window as unknown as { showDirectoryPicker?: (options: { mode: string }) => Promise<Directory> }).showDirectoryPicker;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function readImport(raw: string) {
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || !['tasks', 'notes', 'projects'].every(key => Array.isArray(input[key]))) throw new Error('Invalid workbench data');
  return normalize(input);
}
function handleDb(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest) {
  return new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open('pd_wb_fs', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('handles')) request.result.createObjectStore('handles'); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('handles', mode);
      let result: IDBRequest;
      try { result = action(transaction.objectStore('handles')); } catch (error) { db.close(); reject(error); return; }
      transaction.oncomplete = () => { db.close(); resolve(result.result); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}
export class WorkbenchStore {
  private data: WorkbenchState;
  private listeners = new Set<() => void>();
  private directory: Directory | null = null;
  private connection: Connection = { supported: !!picker(), name: '', active: false, denied: false, busy: false, conflicts: [], error: '', stale: false };
  private snapshot: { data: WorkbenchState; connection: Connection };
  private lastSeen = '';
  private generation = 0;
  private writeTimer = 0;
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private history: { before: WorkbenchState; after: WorkbenchState }[] = [];
  constructor(english = false) {
    let data: WorkbenchState;
    try { const raw = localStorage.getItem(KEY); data = raw ? normalize(JSON.parse(raw)) : seed(english); }
    catch {
      try { const raw = localStorage.getItem(KEY); if (raw) localStorage.setItem(KEY + '_corrupt_' + Date.now(), raw); } catch {}
      data = blank(); this.connection.error = english ? 'Local data could not be read. Recover from a backup.' : '本地数据无法读取，请从备份恢复。';
    }
    if (data.meta.sample) for (const kind of ['tasks', 'notes', 'projects'] as const) for (const item of data[kind]) if (item._s === undefined) item._s = true;
    rollover(data); this.data = data; this.snapshot = { data, connection: this.connection };
    if (!this.connection.error) this.persist();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  private emit() { this.snapshot = { data: this.data, connection: { ...this.connection } }; this.listeners.forEach(listener => listener()); }
  private persist() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); }
    catch (error) { this.connection.error = String(error); this.emit(); }
  }
  commit = (recipe: (state: WorkbenchState) => void, undoable = true) => {
    const before = this.data, draft = structuredClone(before); recipe(draft);
    draft.meta.lastChange = Date.now(); this.data = normalize(draft);
    if (undoable) { this.history.push({ before, after: this.data }); this.history = this.history.slice(-20); }
    this.persist(); this.emit(); window.clearTimeout(this.writeTimer); this.writeTimer = window.setTimeout(() => { void this.sync(); }, 220);
  };
  undo = () => {
    const entry = this.history.pop(); if (!entry) return false;
    this.commit(draft => {
      for (const kind of ['tasks', 'notes', 'projects'] as const) {
        const before = new Map(entry.before[kind].map(item => [item.id, item]));
        const after = new Map(entry.after[kind].map(item => [item.id, item]));
        for (const id of new Set([...before.keys(), ...after.keys()])) {
          if (same(before.get(id), after.get(id))) continue;
          const index = draft[kind].findIndex(item => item.id === id), current = draft[kind][index];
          if (!same(current, after.get(id))) continue;
          const previous = before.get(id);
          if (previous) {
            const restored = { ...previous, updatedAt: Math.max(Date.now(), (draft.tomb[id] || 0) + 1) };
            if (index < 0) (draft[kind] as typeof restored[]).splice(entry.before[kind].findIndex(item => item.id === id), 0, restored); else (draft[kind] as typeof restored[])[index] = restored;
            delete draft.tomb[id]; draft.bin = draft.bin.filter(item => item.id !== id);
          } else { draft[kind].splice(index, 1); draft.tomb[id] = Date.now(); }
        }
      }
    }, false); return true;
  };
  importData(input: WorkbenchState, replace: boolean) {
    if (replace) { this.history = []; this.commit(draft => { Object.assign(draft, input); }, false); return; }
    this.commit(draft => {
      for (const kind of ['tasks', 'notes', 'projects'] as const) {
        const ids = new Set(draft[kind].map(item => item.id));
        (draft[kind] as unknown[]).push(...input[kind].filter(item => !ids.has(item.id) && !(draft.tomb[item.id] >= item.updatedAt)));
      }
      Object.assign(draft.diary, input.diary); Object.assign(draft.diaryTs, input.diaryTs);
    });
  }
  private async serialize(action: () => Promise<void>) {
    const next = this.queue.then(action); this.queue = next.catch(() => {}); return next;
  }
  private async absorb(directory: Directory) {
    let file: File;
    try { file = await (await directory.getFileHandle(FILE)).getFile(); }
    catch (error) { if ((error as DOMException).name === 'NotFoundError') return; throw error; }
    const raw = await file.text(), remote = readImport(raw), version = String(remote.savedAt || raw);
    if (version === this.lastSeen) return;
    this.data = mergeState(this.data, remote); this.lastSeen = version;
    const saved = new Date(String(remote.savedAt || '')).getTime();
    this.connection.stale = !!saved && Date.now() - saved > 24 * 36e5 && Number(this.data.meta.lastChange || 0) - saved > 36e5;
    this.persist(); this.emit();
  }
  private async scan(directory: Directory) {
    const conflicts: string[] = [];
    for await (const name of directory.keys()) if (/\.json$/i.test(name) && name !== FILE && /conflict|conflicted|conflicts|冲突|副本|copy|\(1\)|\(2\)/i.test(name)) conflicts.push(name);
    this.connection.conflicts = conflicts; this.emit();
  }
  private failed(error: unknown) { this.connection = { ...this.connection, active: false, denied: true, error: String(error), busy: false }; this.emit(); }
  async sync() {
    const directory = this.directory, generation = this.generation; if (!directory || !this.connection.active) return;
    await this.serialize(async () => {
      if (generation !== this.generation || !this.connection.active) return;
      this.connection.busy = true; this.emit();
      try {
        await this.absorb(directory);
        if (generation !== this.generation) return;
        const payload = { ...this.data, v: 1, app: 'workbench', savedAt: new Date().toISOString() };
        const writable = await (await directory.getFileHandle(FILE, { create: true })).createWritable();
        await writable.write(JSON.stringify(payload, null, 2)); await writable.close(); this.lastSeen = payload.savedAt; this.connection.stale = false;
        if (this.data.meta.autoBackup !== day()) {
          const backups = await directory.getDirectoryHandle('backups', { create: true }) as Directory;
          const backup = await (await backups.getFileHandle(`workbench-${day()}.json`, { create: true })).createWritable();
          await backup.write(JSON.stringify(payload, null, 2)); await backup.close();
          const names: string[] = []; for await (const name of backups.keys()) if (/^workbench-\d{4}-\d{2}-\d{2}\.json$/.test(name)) names.push(name);
          for (const name of names.sort().slice(0, Math.max(0, names.length - 7))) await backups.removeEntry(name);
          this.data = { ...this.data, meta: { ...this.data.meta, autoBackup: day() } }; this.persist();
        }
        await this.scan(directory);
      } catch (error) { this.failed(error); }
      finally { this.connection.busy = false; this.emit(); }
    });
  }
  async start() {
    if (this.started) return; this.started = true;
    window.addEventListener('storage', event => { if (event.key === KEY && event.newValue) { try { this.data = mergeState(this.data, readImport(event.newValue)); this.emit(); } catch (error) { this.connection.error = String(error); this.emit(); } } });
    window.setInterval(() => {
      if (document.hidden) return;
      if (this.data.meta.lastOpen !== day()) this.commit(draft => rollover(draft), false);
      const directory = this.directory; if (!directory || !this.connection.active) return;
      void this.serialize(async () => { try { await this.absorb(directory); } catch (error) { this.failed(error); } });
    }, 4000);
    if (!picker()) { this.emit(); return; }
    try {
      const handle = await handleDb('readonly', store => store.get('dir')) as Directory | undefined; if (!handle) { this.emit(); return; }
      this.directory = handle; this.connection.name = handle.name;
      this.connection.active = await handle.queryPermission({ mode: 'readwrite' }) === 'granted'; this.connection.denied = !this.connection.active; this.emit();
      if (this.connection.active) await this.sync();
    } catch (error) { this.failed(error); }
  }
  async connect() {
    const choose = picker(); if (!choose) return;
    try {
      const handle = await choose({ mode: 'readwrite' }); await this.queue; this.generation++; this.lastSeen = ''; this.directory = handle;
      this.connection = { ...this.connection, name: handle.name, active: true, denied: false, error: '', conflicts: [] }; this.emit();
      try { await handleDb('readwrite', store => store.put(handle, 'dir')); } catch { }
      await this.sync();
    } catch (error) { if ((error as DOMException).name !== 'AbortError') this.failed(error); }
  }
  async reconnect() {
    if (!this.directory) return;
    try {
      if (await this.directory.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Permission denied');
      this.connection.active = true; this.connection.denied = false; this.connection.error = ''; this.emit(); await this.sync();
    } catch (error) { this.failed(error); }
  }
  async disconnect() {
    this.generation++; window.clearTimeout(this.writeTimer); await this.queue; this.directory = null; this.lastSeen = '';
    this.connection = { ...this.connection, name: '', active: false, denied: false, busy: false, conflicts: [], error: '', stale: false }; this.emit();
    await handleDb('readwrite', store => store.delete('dir'));
  }
  async mergeConflict(name: string) {
    const directory = this.directory; if (!directory || !this.connection.conflicts.includes(name)) return;
    await this.serialize(async () => {
      const input = readImport(await (await (await directory.getFileHandle(name)).getFile()).text()); this.data = mergeState(this.data, input); this.persist(); this.emit();
    });
    await this.sync();
  }
}
