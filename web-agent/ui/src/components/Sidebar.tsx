// ui/src/components/Sidebar.tsx —— 左侧边栏（羊 Logo + Tab + 会话列表 + 批量管理 + Footer）
// 微信式聊天列表：头像 + 名字 + 最后一句摘要 + 时间 + 未读点；
// Tab 数据驱动：内置 4 tab + 插件可注册扩展 tab；
// memo 化：配合 App 侧稳定引用回调，流式渲染期间跳过整个侧边栏 reconcile。
import { memo, useCallback, useEffect, useState } from 'react';
import type { Session } from '../types';
import { hueFrom } from '../types';
import { AGENT_NAME, chatTime, displayTitle, previewOf } from '../voice';
import Confirm, { type ConfirmRequest } from './Confirm';
import { IconArchive, IconChat, IconClose, IconFolder, IconManage, IconPin, IconPlugin, IconPlus, IconSettings, IconSheep, IconStats, IconTrash } from './Icon';

export type MainTab = string;

/** Tab 定义：插件可通过注册 UI tab 扩展侧边栏导航 */
export interface TabDef {
  key: string;
  label: string;
  icon: React.ReactNode;
}

/** 内置 tab（核心功能，不可卸载） */
export const BUILTIN_TABS: TabDef[] = [
  { key: 'chat', label: '会话', icon: <IconChat size={14} /> },
  { key: 'files', label: '文件', icon: <IconFolder size={14} /> },
  { key: 'plugins', label: '插件', icon: <IconPlugin size={14} /> },
  { key: 'stats', label: '统计', icon: <IconStats size={14} /> },
];

interface Props {
  sessions: Session[];
  activeId: string | null;
  activeTab: MainTab;
  onTab: (t: MainTab) => void;
  /** 插件扩展 tab：由 App 按插件运行状态动态计算（插件停用即消失） */
  pluginTabs?: TabDef[];
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onPin: (id: string, pinned: boolean) => void;
  onRename: (id: string, title: string) => void;
  onBatchDelete: (ids: string[]) => void;
  onBatchArchive: (ids: string[]) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  pluginRunning: number;
  /** 正在流式回答的会话 id：列表里显示"正在输入…"（微信式在场感） */
  streamingId?: string | null;
  /** 版本号（来自 package.json，避免写死在 UI 里） */
  version?: string;
}

// ---- 已读水位：纯前端（localStorage），不落库、不增加后端口径 ----
const READS_KEY = 'maharness-reads';
function loadReads(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(READS_KEY) ?? '{}') as Record<string, number>; } catch { return {}; }
}

export default memo(function Sidebar({
  sessions, activeId, activeTab, onTab, pluginTabs = [], onSelect, onCreate, onDelete, onArchive, onPin, onRename,
  onBatchDelete, onBatchArchive, settingsOpen, onToggleSettings, pluginRunning, streamingId, version,
}: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [reads, setReads] = useState<Record<string, number>>(loadReads);

  const markRead = useCallback((id: string | null) => {
    if (!id) return;
    setReads((prev) => {
      const next = { ...prev, [id]: Date.now() };
      try { localStorage.setItem(READS_KEY, JSON.stringify(next)); } catch { /* 隐私模式忽略 */ }
      return next;
    });
  }, []);

  // 打开哪个会话就算读过了（含首屏自动选中的那个）
  useEffect(() => { markRead(activeId); }, [activeId, markRead]);

  const pinned = sessions.filter((s) => s.pinned && !s.archived);
  const normal = sessions.filter((s) => !s.pinned && !s.archived);
  const archived = sessions.filter((s) => s.archived);
  const allIds = sessions.map((s) => s.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const commitRename = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allIds));

  const exitManage = () => { setManaging(false); setSelected(new Set()); };

  // 危险操作一律走应用内确认（原来的 window.confirm 在微信式界面里非常出戏）
  const doBatchDelete = () => {
    if (!selected.size) return;
    const n = selected.size;
    setConfirmReq({
      text: `删掉这 ${n} 段对话？删了就找不回来了。`,
      okText: '删除',
      danger: true,
      onOk: () => { onBatchDelete([...selected]); exitManage(); },
    });
  };
  const doBatchArchive = () => {
    if (!selected.size) return;
    const n = selected.size;
    setConfirmReq({ text: `把这 ${n} 段对话收进归档？之后随时能翻出来。`, okText: '归档', onOk: () => { onBatchArchive([...selected]); exitManage(); } });
  };

  const askDelete = (s: Session) => setConfirmReq({
    text: `删掉「${displayTitle(s.title)}」这段对话？删了就找不回来了。`,
    okText: '删除',
    danger: true,
    onOk: () => onDelete(s.id),
  });

  // 微信聊天列表样式：涂鸦头像 + 标题行（名字/时间）+ 摘要行（最后一句话）
  const renderItem = (s: Session) => {
    const modeText = s.mode === 'plan' ? '计划模式' : s.mode === 'goal' ? '目标模式' : '';
    const preview = previewOf(s.lastRole, s.lastMsg);
    const typing = streamingId === s.id;
    const unread = s.id !== activeId && !managing && s.lastRole === 'assistant' && s.updatedAt > (reads[s.id] ?? 0);
    return (
      <div
        key={s.id}
        className={`sb-session-item ${s.id === activeId ? 'active' : ''} ${managing ? 'managing' : ''} ${unread ? 'unread' : ''}`}
        onClick={() => { if (managing) toggleSelect(s.id); else { markRead(s.id); onSelect(s.id); } }}
        onDoubleClick={() => { if (!managing) { setEditingId(s.id); setDraft(s.title || ''); } }}
        onMouseEnter={() => setHoverId(s.id)}
        onMouseLeave={() => setHoverId(null)}
        title={s.title || '新会话'}
        role="button"
        tabIndex={0}
        aria-current={s.id === activeId ? 'true' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (managing) toggleSelect(s.id); else { markRead(s.id); onSelect(s.id); } }
          if (e.key === 'F2' && !managing) { setEditingId(s.id); setDraft(s.title || ''); }
        }}
      >
        {managing ? (
          <span className={`sb-check ${selected.has(s.id) ? 'checked' : ''}`} onClick={(e) => { e.stopPropagation(); toggleSelect(s.id); }} role="checkbox" aria-checked={selected.has(s.id)} aria-label={`选择 ${s.title || '新会话'}`} />
        ) : (
          <span className="wx-sb-avatar" style={{ '--h': hueFrom(s.id) } as React.CSSProperties} aria-hidden>
            <IconSheep size={15} />
            {unread && <span className="sb-unread-dot" aria-label="有新回复" />}
          </span>
        )}
        {editingId === s.id ? (
          <input
            className="sb-rename-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              else if (e.key === 'Escape') setEditingId(null);
              e.stopPropagation();
            }}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="wx-sb-main">
            <div className="wx-sb-line1">
              <span className="name">{displayTitle(s.title)}</span>
              <span className="time">{chatTime(s.updatedAt)}</span>
            </div>
            <div className="wx-sb-line2">
              {/* 摘要 = 最后一句真正说出口的话（微信的样子），而不是恒为「私聊」的死文本 */}
              {typing
                ? <span className="wx-sb-preview typing">{AGENT_NAME}正在输入…</span>
                : preview
                  ? <span className={`wx-sb-preview ${s.lastRole === 'user' ? 'mine' : ''}`}>{preview}</span>
                  : s.role
                    ? <span className="wx-sb-preview role">{s.role} 接手了</span>
                    : modeText
                      ? <span className="wx-sb-preview mode">{modeText}</span>
                      : <span className="wx-sb-preview empty">还没聊过，打个招呼吧</span>}
            </div>
          </div>
        )}
        {!managing && hoverId === s.id && (
          <span className="item-actions" onClick={(e) => e.stopPropagation()}>
            <button title="置顶" aria-label="置顶" onClick={() => onPin(s.id, !s.pinned)}><IconPin size={12} /></button>
            <button title="归档" aria-label="归档" onClick={() => onArchive(s.id, !s.archived)}><IconArchive size={12} /></button>
            <button title="删除" aria-label="删除" onClick={() => askDelete(s)}><IconTrash size={12} /></button>
          </span>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sb-logo">
        <div className="sb-logo-left">
          <div className="sb-logo-mark"><IconSheep size={17} /></div>
          <div className="sb-logo-title">maharness</div>
        </div>
      </div>

      <div className="sb-tabs">
        {BUILTIN_TABS.slice(0, 2).concat(pluginTabs, BUILTIN_TABS.slice(2)).map((tab) => (
          <button key={tab.key} className={`sb-tab ${activeTab === tab.key ? 'active' : ''}`} onClick={() => onTab(tab.key)}>
            {tab.icon}{tab.label}
          </button>
        ))}
      </div>

      <div className="sb-divider" />

      <div className="sb-new-row">
        <button className="sb-new-chat" onClick={() => { if (!managing) onCreate(); }}><IconPlus size={15} />新会话</button>
        <button
          className={`sb-manage-btn ${managing ? 'active' : ''}`}
          onClick={() => { if (managing) exitManage(); else setManaging(true); }}
          title={managing ? '退出批量管理' : '批量管理会话'}
          aria-label={managing ? '退出批量管理' : '批量管理会话'}
        >
          {managing ? <IconClose size={15} /> : <IconManage size={15} />}
        </button>
      </div>

      <div className="sb-session-scroll">
        {managing && (
          <div className="sb-manage-bar">
            <button className="sb-mg-link" onClick={toggleAll}>{allSelected ? '取消全选' : '全选'}</button>
            <span className="sb-mg-count">{selected.size} 已选</span>
          </div>
        )}
        {sessions.length === 0 && <div className="empty-state" style={{ padding: '24px 12px' }}>还没有对话，点上面「新会话」开始</div>}
        {pinned.length > 0 && <div className="sb-group-label">已置顶</div>}
        {pinned.map(renderItem)}
        {normal.length > 0 && <div className="sb-group-label">会话</div>}
        {normal.map(renderItem)}
        {archived.length > 0 && (
          <>
            <div className="sb-group-label">归档</div>
            {archived.map(renderItem)}
          </>
        )}
      </div>

      {managing ? (
        <div className="sb-manage-actions">
          <button className="sb-ma-btn" onClick={doBatchArchive} disabled={!selected.size} title="归档选中会话">
            <IconArchive size={13} />归档
          </button>
          <button className="sb-ma-btn danger" onClick={doBatchDelete} disabled={!selected.size} title="删除选中会话">
            <IconTrash size={13} />删除
          </button>
          <button className="sb-ma-btn primary" onClick={exitManage}>完成</button>
        </div>
      ) : (
        <div className="sb-footer">
          <div className="sb-foot-row">
            <div className="sb-foot-left">
              <span className="sb-foot-chip" title="正在运行的插件数">{pluginRunning} 个插件在跑</span>
            </div>
            <span className="sb-foot-chip ver">v{version ?? '0.1.0'}</span>
          </div>
          <button className={`sb-settings-btn ${settingsOpen ? 'active' : ''}`} onClick={onToggleSettings}>
            <IconSettings size={14} />
            <span>设置</span>
          </button>
        </div>
      )}
      <Confirm req={confirmReq} onClose={() => setConfirmReq(null)} />
    </aside>
  );
});
