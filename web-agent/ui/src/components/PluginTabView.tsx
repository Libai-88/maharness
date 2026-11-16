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
import { Component, useCallback, useEffect, useRef, useState } from 'react';
import type { PluginNavItem } from '../types';
import { getMutationToken, navApi } from '../api';
import DOMPurify from 'dompurify';
import PluginModuleView from './PluginModuleView';
import { ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';

interface Props {
  item: PluginNavItem;
  onSelectSession?: (id: string) => void;
}

/** 信任等级明示（SEC-05）：三种渲染形态的隔离语义直接展示在页头，不依赖用户记忆 */
const TRUST_LABEL: Record<PluginNavItem['mode'], { text: string; title: string }> = {
  module: {
    text: '受信任模块 · 宿主权限',
    title: '与宿主同源同 realm 运行，可访问宿主 API 与凭据头。仅适用于本地编写或自行安装的插件。',
  },
  iframe: {
    text: 'iframe 沙箱',
    title: '在 sandbox iframe 中运行：无宿主 DOM/存储访问，不含 allow-top-navigation，无法接管宿主页面。',
  },
  panel: {
    text: '净化片段',
    title: 'HTML 片段经 DOMPurify 净化后内联渲染，脚本与事件属性被移除。',
  },
};

/** 插件页面的错误边界：插件提供的页面/片段出问题时只坏这一页，不连累整个界面 */
class PluginPageBoundary extends Component<{ children: React.ReactNode; pluginId: string }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  render() {
    if (this.state.error) {
      return (
        <Alert variant="destructive" className="m-4 w-auto"><ShieldAlert /><AlertTitle>插件页面渲染失败</AlertTitle><AlertDescription>{this.props.pluginId}：{this.state.error}</AlertDescription></Alert>
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

export default function PluginTabView({ item, onSelectSession }: Props) {
  return (
    <PluginPageBoundary pluginId={item.pluginId}>
      <PluginTabBody item={item} onSelectSession={onSelectSession} />
    </PluginPageBoundary>
  );
}

function PluginTabBody({ item, onSelectSession }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const navigate = (event: MessageEvent) => {
      if (event.origin === location.origin && event.source === frame.current?.contentWindow && event.data?.type === 'maharness:open-session' && typeof event.data.sessionId === 'string') onSelectSession?.(event.data.sessionId);
    };
    window.addEventListener('message', navigate);
    return () => window.removeEventListener('message', navigate);
  }, [onSelectSession]);
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
      const t = getMutationToken();
      const res = await fetch(item.statusUrl, { headers: t ? { 'x-maharness-token': t } : {} });
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

  const trust = TRUST_LABEL[item.mode];
  const src = item.mode === 'iframe' ? `${item.url}${item.url.includes('?') ? '&' : '?'}_t=${reloadKey}` : '';

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-plugin-id={item.pluginId}
      data-plugin-mode={item.mode}
    >
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <Badge variant="outline" data-trust={item.mode} title={trust.title}>{trust.text}</Badge>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
          {item.statusUrl && (
            <>
              <Badge variant={status?.connected ? 'secondary' : 'outline'}>{status?.text ?? item.pluginName}</Badge>
              {status?.detail && <span className="truncate text-xs text-muted-foreground" title={status.detail}>{status.detail}</span>}
            </>
          )}
          {!item.statusUrl && <span>{item.pluginName}</span>}
        </div>
        <div className="ml-auto flex gap-2">
          {item.url && (
            <Button variant="outline" size="sm"
              onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
              title="在独立窗口打开"
            >
              <ExternalLink data-icon="inline-start" />独立窗口
            </Button>
          )}
          {item.mode === 'iframe' && (
            <Button variant="ghost" size="icon-sm" onClick={() => setReloadKey((k) => k + 1)} aria-label="刷新插件页面"><RefreshCw /></Button>
          )}
        </div>
      </div>

      {item.mode === 'module' ? (
        <PluginModuleView item={item} />
      ) : item.mode === 'iframe' ? (
        <iframe
          ref={frame}
          key={reloadKey}
          src={src}
          title={item.label}
          className="min-h-0 w-full flex-1 border-0"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
        />
      ) : panelError ? (
        <Alert variant="destructive" className="m-4 w-auto"><ShieldAlert /><AlertTitle>插件面板加载失败</AlertTitle><AlertDescription>{panelError}</AlertDescription></Alert>
      ) : !panel ? (
        <div className="flex min-h-32 flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground" aria-busy="true">
          <Spinner />
          <span>加载插件页面…</span>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1"><div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-4 md:p-6"><Card><CardHeader><CardTitle>{panel.title}</CardTitle></CardHeader><CardContent><div className="min-w-0 wrap-break-word" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(panel.html) }} /></CardContent></Card></div></ScrollArea>
      )}
    </div>
  );
}
