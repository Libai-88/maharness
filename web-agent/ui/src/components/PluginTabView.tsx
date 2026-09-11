// ui/src/components/PluginTabView.tsx —— 插件贡献的顶层标签页（通用容器）
//
// 第一性原理：前端不应该知道任何插件的存在。插件在 plugin.json 声明 nav，
// 前端遍历声明生成导航；页面内容由插件自己提供（完整 HTML 或 HTML 片段）。
// 本组件是这条通道的**唯一**渲染实现——新增插件页面无需改动前端一行代码。
//
// 两种形态：
//  - iframe：插件提供完整页面（脚本/交互保真，看板、工作台这类应用）；
//  - panel ：插件返回 { title, html } 片段，净化后内联渲染（展示/轻交互）。
//
// 可选页头状态：nav.status 指向一个返回 { text, detail?, connected? } 的端点，
// 本组件通用轮询并展示——插件不需要为了"在页头显示状态"而让前端为它写组件。
import { Component, useCallback, useEffect, useState } from 'react';
import type { PluginNavItem } from '../types';
import { navApi } from '../api';
import DOMPurify from 'dompurify';
import PluginModuleView from './PluginModuleView';
import { IconExternal, IconRefresh } from './Icon';

interface Props {
  item: PluginNavItem;
}

/** 插件页面的错误边界：插件提供的页面/片段出问题时只坏这一页，不连累整个界面 */
class PluginPageBoundary extends Component<{ children: React.ReactNode; pluginId: string }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="view-loading">
          <span>插件页面渲染失败（{this.props.pluginId}）：{this.state.error}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

interface StatusPayload {
  text?: string;
  detail?: string;
  connected?: boolean;
}

export default function PluginTabView({ item }: Props) {
  return (
    <PluginPageBoundary pluginId={item.pluginId}>
      <PluginTabBody item={item} />
    </PluginPageBoundary>
  );
}

function PluginTabBody({ item }: Props) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [panel, setPanel] = useState<{ title: string; html: string } | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // ---- panel 模式：取回 HTML 片段（iframe 模式无需请求，浏览器自己加载） ----
  useEffect(() => {
    if (item.mode !== 'panel') return;
    let alive = true;
    setPanel(null);
    setPanelError(null);
    navApi.panel(item.url)
      .then((p) => { if (alive) setPanel(p); })
      .catch((err: unknown) => {
        if (alive) setPanelError(err instanceof Error ? err.message : String(err));
      });
    return () => { alive = false; };
  }, [item.mode, item.url, reloadKey]);

  // ---- 页头状态轮询（插件声明才启用） ----
  const fetchStatus = useCallback(async () => {
    if (!item.statusUrl) return;
    try {
      const res = await fetch(item.statusUrl);
      if (!res.ok) throw new Error(String(res.status));
      setStatus(await res.json() as StatusPayload);
    } catch {
      setStatus(null); // 端点不可用（插件停机中）：不展示状态，不报错打断页面
    }
  }, [item.statusUrl]);

  useEffect(() => {
    if (!item.statusUrl || item.statusIntervalMs <= 0) return;
    void fetchStatus();
    const t = setInterval(() => void fetchStatus(), item.statusIntervalMs);
    return () => clearInterval(t);
  }, [fetchStatus, item.statusUrl, item.statusIntervalMs]);

  const hasHeader = !!item.statusUrl || item.mode === 'iframe';
  const src = item.mode === 'iframe' ? `${item.url}${item.url.includes('?') ? '&' : '?'}_t=${reloadKey}` : '';

  return (
    <div
      className="plugin-tab"
      data-plugin-id={item.pluginId}
      data-plugin-mode={item.mode}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {hasHeader && (
        <div className="plugin-tab-bar">
          <div className="plugin-tab-status">
            {item.statusUrl && (
              <>
                <span className={`plugin-tab-dot ${status?.connected ? 'on' : ''}`} />
                <span className="plugin-tab-text">{status?.text ?? `${item.pluginName}`}</span>
                {status?.detail && <span className="plugin-tab-detail">{status.detail}</span>}
              </>
            )}
            {!item.statusUrl && <span className="plugin-tab-text">{item.pluginName}</span>}
          </div>
          <div className="plugin-tab-actions">
            {item.url && (
              <button
                className="plugin-tab-btn"
                onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
                title="在独立窗口打开"
              >
                <IconExternal size={13} /> 独立窗口
              </button>
            )}
            {item.mode === 'iframe' && (
              <button className="plugin-tab-btn" onClick={() => setReloadKey((k) => k + 1)} title="刷新">
                <IconRefresh size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {item.mode === 'module' ? (
        <PluginModuleView item={item} />
      ) : item.mode === 'iframe' ? (
        <iframe
          key={reloadKey}
          src={src}
          title={item.label}
          className="plugin-tab-iframe"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
          style={{ flex: 1, border: 'none', width: '100%' }}
        />
      ) : panelError ? (
        <div className="view-loading"><span>插件面板加载失败：{panelError}</span></div>
      ) : !panel ? (
        <div className="view-loading" aria-busy="true">
          <span className="spin" style={{ color: 'var(--accent)' }} />
          <span>加载插件页面…</span>
        </div>
      ) : (
        <div className="plugin-tab-panel">
          <div className="pm-title">PLUGIN PANEL · {panel.title}</div>
          <div className="plugin-panel-body" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(panel.html) }} />
        </div>
      )}
    </div>
  );
}
