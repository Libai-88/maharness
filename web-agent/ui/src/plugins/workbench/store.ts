import { blank, mergeState, normalize, type WorkbenchState } from '../../../../plugins/workbench/model';
import { api } from '../../api';
export const KEY = 'pd_workbench_v1';
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function readImport(raw: string) {
  const input = JSON.parse(raw);
  if (!input || !['tasks', 'notes', 'projects'].every((key) => Array.isArray(input[key]))) throw new Error('工作台数据无效');
  return normalize(input);
}
interface Connection {
  active: boolean;
  busy: boolean;
  error: string;
  name: string;
}
export class WorkbenchStore {
  private data = blank();
  private revision = 0;
  private dirty = false;
  private started = false;
  private loaded = false;
  private timer = 0;
  private listeners = new Set<() => void>();
  private connection: Connection = { active: false, busy: false, error: '', name: '应用存储' };
  private snapshot = { data: this.data, connection: this.connection };
  private history: { before: WorkbenchState; after: WorkbenchState }[] = [];
  constructor(_english = false) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  private emit() {
    this.snapshot = { data: this.data, connection: { ...this.connection } };
    this.listeners.forEach((listener) => {
      listener();
    });
  }
  commit = (recipe: (state: WorkbenchState) => void, undoable = true) => {
    if (!this.loaded) {
      this.connection.error = '请先连接应用存储';
      this.emit();
      return;
    }
    const before = this.data,
      draft = structuredClone(before);
    recipe(draft);
    draft.meta.lastChange = Date.now();
    this.data = normalize(draft);
    this.dirty = true;
    if (undoable) {
      this.history.push({ before, after: this.data });
      this.history = this.history.slice(-20);
    }
    this.emit();
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.sync(), 220);
  };
  undo = () => {
    const entry = this.history.pop();
    if (!entry) return false;
    this.commit((draft) => {
      for (const kind of ['tasks', 'notes', 'projects'] as const) {
        const before = new Map(entry.before[kind].map((item) => [item.id, item]));
        const after = new Map(entry.after[kind].map((item) => [item.id, item]));
        for (const id of new Set([...before.keys(), ...after.keys()])) {
          if (same(before.get(id), after.get(id))) continue;
          const index = draft[kind].findIndex((item) => item.id === id),
            current = draft[kind][index];
          if (!same(current, after.get(id))) continue;
          const previous = before.get(id);
          if (previous) {
            const restored = { ...previous, updatedAt: Math.max(Date.now(), (draft.tomb[id] || 0) + 1) };
            if (index < 0)
              (draft[kind] as (typeof restored)[]).splice(
                entry.before[kind].findIndex((item) => item.id === id),
                0,
                restored,
              );
            else (draft[kind] as (typeof restored)[])[index] = restored;
            delete draft.tomb[id];
            draft.bin = draft.bin.filter((item) => item.id !== id);
          } else {
            draft[kind].splice(index, 1);
            draft.tomb[id] = Date.now();
          }
        }
      }
    }, false);
    return true;
  };
  async importData(input: WorkbenchState, replace: boolean) {
    if (replace) {
      this.history = [];
      this.commit((draft) => {
        Object.assign(draft, input);
      }, false);
    } else this.commit((draft) => Object.assign(draft, mergeState(draft, input)));
    await this.sync();
    if (this.connection.error || this.dirty) throw new Error(this.connection.error || '内容尚未保存，请稍后重试');
  }

  async refresh(discard = false) {
    if (this.connection.busy || (this.dirty && !discard)) return;
    try {
      const result = await api<{ revision: number; data: WorkbenchState }>('/api/plugins/workbench/wb/data');
      if ((this.dirty && !discard) || result.revision < this.revision) return;
      this.data = normalize(result.data);
      this.revision = result.revision;
      this.loaded = true;
      this.dirty = false;
      this.connection.active = true;
      this.connection.error = '';
    } catch (error) {
      this.connection.active = false;
      this.connection.error = String(error);
    }
    this.emit();
  }
  async sync() {
    if (this.connection.busy || !this.dirty) {
      if (!this.dirty) await this.refresh();
      return;
    }
    const submitted = this.data;
    this.connection.busy = true;
    this.emit();
    try {
      const result = await api<{ revision: number; data: WorkbenchState }>('/api/plugins/workbench/wb/data', {
        method: 'PUT',
        body: JSON.stringify({ revision: this.revision, data: submitted }),
      });
      this.revision = result.revision;
      const canonical = normalize(result.data);
      this.history = this.history.map((entry) => (entry.after === submitted ? { ...entry, after: canonical } : entry));
      if (this.data === submitted) {
        this.data = canonical;
        this.dirty = false;
      }
      this.connection.error = '';
      this.connection.active = true;
    } catch (error) {
      this.connection.error = String(error);
    } finally {
      this.connection.busy = false;
      this.emit();
    }
    if (this.dirty && !this.connection.error) await this.sync();
  }
  async start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener('beforeunload', (event) => {
      if (this.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    await this.refresh();
    window.setInterval(() => {
      if (!document.hidden) void this.refresh();
    }, 4000);
  }
  legacyData() {
    const raw = localStorage.getItem(KEY);
    return raw ? readImport(raw) : null;
  }
  async importLegacy() {
    const data = this.legacyData();
    if (!data) return;
    await this.importData(data, false);
  }
}
