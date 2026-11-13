import { ExecutionPool } from './execution-pool';

const queues = new Map<string, { pool: ExecutionPool; references: number }>();
/** Effectful handlers sharing a workspace serialize; approvals never hold this lock. */
export async function acquireWriteLock(workspace: string, rootId: string, signal?: AbortSignal): Promise<() => void> {
  const key = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
  const queue = queues.get(key) ?? { pool: new ExecutionPool(1), references: 0 };
  queues.set(key, queue); queue.references++;
  const cleanup = () => { queue.references--; if (!queue.references) queues.delete(key); };
  try { const release = await queue.pool.acquire(rootId, signal); let released = false; return () => { if (released) return; released = true; release(); cleanup(); }; }
  catch (error) { cleanup(); throw error; }
}
