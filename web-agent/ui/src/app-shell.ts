/**
 * ui/src/app-shell.ts —— 应用外壳的纯函数与视图状态（从 App.tsx 拆出）
 *
 * 这里只放与 React 无关的东西：URL 视图映射、主题/品牌持久化、模型 id 解析、
 * 提示音、次要视图预取。App.tsx 只保留状态协调与流式处理，两者互不反向依赖。
 */
import type { MainTab } from './components/Sidebar';

/** 切到后台时的消息提醒：标题角标 + 一声轻响（像微信的消息音） */
let audioCtxRef: AudioContext | null = null;

export function dingOnce() {
  try {
    const AC = window.AudioContext;
    if (!AC) return;
    if (!audioCtxRef) audioCtxRef = new AC();
    const ctx = audioCtxRef;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.35);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.start();
    o.stop(ctx.currentTime + 0.5);
  } catch {
    /* 音频不可用时静默 */
  }
}

// 次要视图路由级代码分割：首屏只需 Chat 视图，文件/插件/统计/设置
// 按需加载（首屏 JS 体积显著下降），挂载后 idle 时预取保证首次点击无感。
// 注意：插件页面【不在】此列表——它们由插件在 plugin.json 声明 nav，
// 前端遍历 /api/nav 生成标签页，内容由 PluginTabView 通用渲染（前端不认识任何插件）。
export function preloadSecondaryViews() {
  void import('./components/FilesView');
  void import('./components/WorkbenchView');
  void import('./components/SocietyView');
  void import('./components/AutomationsView');
  void import('./components/PluginsView');
  void import('./components/StatsView');
  void import('./components/SettingsView');
}

export function viewFromLocation(): { tab: MainTab; settings: boolean; session?: string } {
  const params = new URLSearchParams(location.search);
  const view = params.get('view') ?? 'chat';
  return {
    tab: view === 'settings' ? 'chat' : view,
    settings: view === 'settings',
    session: params.get('session') ?? undefined,
  };
}

export function writeViewLocation(view: string, sessionId?: string | null, replace = false): void {
  const params = new URLSearchParams(location.search);
  params.set('view', view);
  if (sessionId) params.set('session', sessionId);
  else if (view === 'chat') params.delete('session');
  const next = `${location.pathname}?${params.toString()}${location.hash}`;
  history[replace ? 'replaceState' : 'pushState'](null, '', next);
}

/** 模型条目 id = provider@model（服务端 /api/models 约定） */
export function splitModelId(id: string): { provider: string; model: string } {
  const i = id.lastIndexOf('@');
  return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : { provider: id, model: '' };
}

export type Theme = 'dark' | 'light';
export type Brand = 'doodle' | 'ink' | 'moss';

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem('maharness-theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    /* 隐私模式等场景读不到 */
  }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readBrand(): Brand {
  try {
    const b = localStorage.getItem('maharness-brand');
    if (b === 'ink' || b === 'moss' || b === 'doodle') return b;
  } catch {
    /* 忽略 */
  }
  return 'doodle';
}
