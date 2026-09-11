// ui/src/components/PluginModuleView.tsx —— 插件贡献的组件级页面（nav.mode='module'）
//
// 插件提供一个浏览器原生 ESM 模块，导出 mount(container, host)。宿主注入 React 实例
// 与能力接口后挂载，返回值作为卸载函数——插件因此能复用宿主的 React、主题、事件与 API，
// 而不必自带框架或复制一份运行时。
//
// 安全边界：模块与宿主同源同 realm，没有沙箱。适用于受信任插件（本地编写/用户自行安装）；
// 来源不可信的插件请用 iframe 模式（sandbox 属性会限制其权限）。
import { useEffect, useRef, useState } from 'react';
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { toast } from 'sonner';
import type { BusEvent, PluginNavItem } from '../types';
import { subscribeEvents } from '../api';

/** 宿主注入插件 UI 的接口：插件对外交互的唯一通道 */
export interface PluginHostApi {
  pluginId: string;
  /** 宿主 React 实例（插件据此渲染，避免双 React 各自持有状态） */
  React: typeof React;
  ReactDOM: typeof ReactDOM;
  /** 带插件前缀的请求客户端，基址 /api/plugins/<pluginId> */
  api: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
  };
  toast: { success(msg: string): void; error(msg: string): void };
  theme: { current: 'light' | 'dark'; onChange(cb: (theme: string) => void): () => void };
  /** 订阅后端事件（单一 EventSource 共享，返回退订函数） */
  subscribe(event: string, cb: (data: unknown) => void): () => void;
  openExternal(url: string): void;
}

interface PluginModule {
  mount(container: HTMLElement, host: PluginHostApi): (() => void) | void;
}

// ---- 事件总线：全部插件模块共享一个 EventSource（避免订阅数 = 连接数） ----
const busSubs = new Map<string, Set<(data: unknown) => void>>();
let busStop: (() => void) | null = null;

function ensureBus(): void {
  if (busStop) return;
  busStop = subscribeEvents((e: BusEvent) => {
    for (const cb of busSubs.get(e.type) ?? []) {
      try { cb(e.data); } catch { /* 订阅方异常不影响其它订阅 */ }
    }
  });
}

const apiBase = (pluginId: string, path: string): string =>
  `/api/plugins/${pluginId}${path.startsWith('/') ? path : `/${path}`}`;

async function request<T>(pluginId: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiBase(pluginId, path), init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function buildHost(item: PluginNavItem): PluginHostApi {
  return {
    pluginId: item.pluginId,
    React,
    ReactDOM,
    api: {
      get: <T,>(path: string) => request<T>(item.pluginId, path),
      post: <T,>(path: string, body?: unknown) => request<T>(item.pluginId, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    },
    toast: { success: (m) => toast.success(m), error: (m) => toast.error(m) },
    theme: {
      current: (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
      onChange: (cb) => {
        const observer = new MutationObserver(() => {
          cb(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
      },
    },
    subscribe: (event, cb) => {
      ensureBus();
      const set = busSubs.get(event) ?? new Set();
      set.add(cb);
      busSubs.set(event, set);
      return () => { set.delete(cb); };
    },
    openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
  };
}

export default function PluginModuleView({ item }: { item: PluginNavItem }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    const url = item.moduleUrl;
    setError(null);
    if (!el || !url) return;
    let unmount: (() => void) | void;
    let alive = true;
    void (async () => {
      try {
        const mod = (await import(/* @vite-ignore */ url)) as PluginModule;
        if (!alive) return;
        if (typeof mod.mount !== 'function') throw new Error('模块未导出 mount(container, host)');
        unmount = mod.mount(el, buildHost(item));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
      try { unmount?.(); } catch { /* 卸载异常不阻断标签页切换 */ }
    };
  }, [item.moduleUrl, item.pluginId, item]);

  if (!item.moduleUrl) return <div className="view-loading"><span>插件未声明模块入口（nav.module）</span></div>;
  if (error) return <div className="view-loading"><span>插件模块加载失败（{item.pluginId}）：{error}</span></div>;
  return (
    <div
      ref={ref}
      className="plugin-module"
      data-plugin-id={item.pluginId}
      style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}
    />
  );
}
