import type { Express } from 'express';
import { existsSync, statfsSync } from 'node:fs';
import type { Kernel } from '../../kernel';
import type { Store } from '../db';
import type { ClientTracker } from '../client-tracker';
import pkg from '../../package.json';
import { getChatService } from './shared';
import { activeWarmupCount } from './warmup';

export interface ReadinessChecks {
  kernel: boolean;
  database: boolean;
  providers: boolean;
  plugins: boolean;
  storage: boolean;
}
export interface ReadinessSnapshot {
  schemaVersion: 1;
  ok: boolean;
  checks: ReadinessChecks;
}

export const STORAGE_CAPACITY_THRESHOLDS = { warningFreePercent: 10, criticalFreePercent: 5 } as const;
export type StorageStatus = 'ok' | 'warning' | 'critical' | 'unknown';
export interface StorageSnapshot {
  schemaVersion: 1;
  ok: boolean;
  status: StorageStatus;
  totalBytes: number | null;
  freeBytes: number | null;
  freePercent: number | null;
  thresholds: typeof STORAGE_CAPACITY_THRESHOLDS;
}

export function buildReadinessSnapshot(input: {
  providerCount: number;
  pluginErrors: number;
  database: boolean;
  storage?: boolean;
}): ReadinessSnapshot {
  const checks: ReadinessChecks = {
    kernel: true,
    database: input.database,
    providers: input.providerCount > 0,
    plugins: input.pluginErrors === 0,
    storage: input.storage ?? true,
  };
  return { schemaVersion: 1, ok: Object.values(checks).every(Boolean), checks };
}

export function buildStorageSnapshot(totalBytes: number, freeBytes: number): StorageSnapshot {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(freeBytes) || freeBytes < 0 || freeBytes > totalBytes) {
    return {
      schemaVersion: 1,
      ok: false,
      status: 'unknown',
      totalBytes: null,
      freeBytes: null,
      freePercent: null,
      thresholds: STORAGE_CAPACITY_THRESHOLDS,
    };
  }
  const freePercent = Math.round((freeBytes / totalBytes) * 10_000) / 100;
  const status: StorageStatus =
    freePercent <= STORAGE_CAPACITY_THRESHOLDS.criticalFreePercent
      ? 'critical'
      : freePercent <= STORAGE_CAPACITY_THRESHOLDS.warningFreePercent
        ? 'warning'
        : 'ok';
  return {
    schemaVersion: 1,
    ok: status !== 'critical',
    status,
    totalBytes,
    freeBytes,
    freePercent,
    thresholds: STORAGE_CAPACITY_THRESHOLDS,
  };
}

export function readStorageSnapshot(dataDir: string): StorageSnapshot {
  try {
    if (!existsSync(dataDir))
      return {
        schemaVersion: 1,
        ok: false,
        status: 'unknown',
        totalBytes: null,
        freeBytes: null,
        freePercent: null,
        thresholds: STORAGE_CAPACITY_THRESHOLDS,
      };
    const stats = statfsSync(dataDir);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return buildStorageSnapshot(totalBytes, freeBytes);
  } catch {
    return {
      schemaVersion: 1,
      ok: false,
      status: 'unknown',
      totalBytes: null,
      freeBytes: null,
      freePercent: null,
      thresholds: STORAGE_CAPACITY_THRESHOLDS,
    };
  }
}

export function registerHealthRoutes(
  app: Express,
  ctx: { kernel: Kernel; store: Store; dataDir: string; tracker?: ClientTracker; activeRuns: () => number; sseSize: () => number },
): void {
  const { kernel, store, dataDir, tracker } = ctx;
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: pkg.version, pid: process.pid });
  });

  app.get('/api/ready', (_req, res) => {
    const storage = readStorageSnapshot(dataDir);
    const snapshot = buildReadinessSnapshot({
      providerCount: store.listProviders().length,
      pluginErrors: kernel.plugins.list().filter((plugin) => plugin.state === 'error').length,
      database: true,
      storage: storage.status !== 'critical' && storage.status !== 'unknown',
    });
    const chat = getChatService(kernel);
    res.status(snapshot.ok ? 200 : 503).json({
      ...snapshot,
      resources: {
        activeRuns: ctx.activeRuns(),
        sseConnections: ctx.sseSize(),
        pageConnections: tracker?.size ?? 0,
        pendingApprovals: chat?.listApprovals().length ?? 0,
        activeWarmups: activeWarmupCount(),
        activeSubagentSlots: kernel.budget.activeSubagentCount(),
      },
    });
  });

  app.get('/api/storage', (_req, res) => res.json(readStorageSnapshot(dataDir)));
}
