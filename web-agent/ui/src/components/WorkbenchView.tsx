// ui/src/components/WorkbenchView.tsx —— 办公工作台 v2（嵌入用户 HTML 应用 + 文件桥联动）
// 采用 iframe 嵌入 app.html（100% 功能保真，插件停用即整页下线）。
// 顶部联动状态条轮询 /wb/bridge，展示连接状态/记录数/同步时间；
// 用户首次需在嵌入的工作台「备份」视图连接文件夹（桥目录）实现实时联动。
import { useCallback, useEffect, useRef, useState } from 'react';
import { workbenchApi } from '../api';
import type { BridgeInfo } from '../types';
import { IconRefresh, IconWorkbench } from './Icon';

// 工作台应用 URL：插件挂载在 /api/plugins/workbench/wb，/app 返回完整 HTML
const APP_URL = '/api/plugins/workbench/wb/app';
const OPEN_LABEL = '独立窗口打开';

/** 格式化时间差：X 分钟前 / X 小时前 / 刚刚 */
function timeAgo(ms: number): string {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export default function WorkbenchView() {
  const [bridge, setBridge] = useState<BridgeInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);   // 刷新 iframe 用
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // ---- 联动状态轮询 ----
  const fetchBridge = useCallback(async () => {
    try {
      const info = await workbenchApi.bridge();
      setBridge(info);
      setNotFound(false);
    } catch {
      setNotFound(true);
      setBridge(null);
    }
  }, []);

  useEffect(() => { void fetchBridge(); }, [fetchBridge]);
  useEffect(() => {
    const t = setInterval(() => void fetchBridge(), 6000);
    return () => clearInterval(t);
  }, [fetchBridge]);

  // ---- 插件未启用 ----
  if (notFound) {
    return (
      <div className="view-loading" aria-busy="true">
        <span className="spin" style={{ color: 'var(--accent)' }} />
        <span>工作台插件未启用或加载失败</span>
      </div>
    );
  }

  // ---- iframe src（带时间戳防缓存，便于开发时 hot-reload app.html） ----
  const src = `${APP_URL}?_t=${iframeKey || ''}`;
  const connected = !!bridge?.connected;
  const rec = bridge?.records;
  const total = (rec?.tasks ?? 0) + (rec?.notes ?? 0) + (rec?.projects ?? 0);

  return (
    <div className="workbench-embed" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* ---- 联动状态条 ---- */}
      <div className="wb-status-bar">
        <div className="wb-status-left">
          <span className={`wb-status-dot ${connected ? 'connected' : ''}`} />
          <span className="wb-status-text">
            {connected ? '桥已连接' : '桥未连接'}
          </span>
          {bridge && (
            <span className="wb-status-records">
              {total > 0 && `${rec!.tasks} 任务 / ${rec!.notes} 灵感 / ${rec!.projects} 项目`}
              {total === 0 && '暂无记录'}
            </span>
          )}
          {bridge?.lastExternalAt ? (
            <span className="wb-status-sync">最后同步：{timeAgo(bridge.lastExternalAt)}</span>
          ) : bridge?.mtimeMs ? (
            <span className="wb-status-sync">最后同步：{timeAgo(bridge.mtimeMs)}</span>
          ) : null}
        </div>
        <div className="wb-status-right">
          {!connected && (
            <button className="wb-status-btn guide" onClick={() => setGuideOpen(g => !g)}>
              {guideOpen ? '收起指引' : '查看连接指引'}
            </button>
          )}
          <button className="wb-status-btn" onClick={() => window.open(APP_URL, '_blank', 'noopener,noreferrer')}>{OPEN_LABEL}</button>
          <button className="wb-status-btn" onClick={() => setIframeKey(k => k + 1)} title="刷新"><IconRefresh size={13} /></button>
        </div>
      </div>

      {/* ---- 连接指引 ---- */}
      {guideOpen && !connected && (
        <div className="wb-connect-guide">
          <div className="wb-guide-title"><IconWorkbench size={14} /> 连接工作台文件夹实现联动</div>
          <div className="wb-guide-step"><span className="step-num">1</span> 在下方工作台中打开「备份」视图 → 点击「连接本地文件夹」</div>
          <div className="wb-guide-step"><span className="step-num">2</span> 选择目录：<code>{bridge?.dir || '（正在加载…）'}</code></div>
          <div className="wb-guide-step"><span className="step-num">3</span> 连接后，工作台会自动读取该目录下的 <code>workbench-data.json</code>，实现与 Agent 双向实时联动</div>
          <div className="wb-guide-note">首次连接后会话记忆永久保存在浏览器中，无需重复操作。</div>
          {bridge?.dir && (
            <button className="wb-guide-copy" onClick={() => navigator.clipboard?.writeText(bridge.dir).then(() => { /* ok */ }).catch(() => undefined)}>
              复制路径
            </button>
          )}
        </div>
      )}

      {/* ---- 内嵌工作台 ---- */}
      <iframe
        ref={iframeRef}
        key={iframeKey}
        src={src}
        title="办公工作台"
        className="wb-iframe"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
        style={{ flex: 1, border: 'none', width: '100%' }}
      />
    </div>
  );
}
