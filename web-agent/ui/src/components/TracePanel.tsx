// ui/src/components/TracePanel.tsx —— 运行轨迹面板（Screen 1 右侧）：实时步骤（span 树）+ 缓存/成本统计
import { useMemo, useState } from 'react';
import type { TraceStep } from '../types';
import { IconDownload, IconRefresh } from './Icon';

interface Props {
  steps: TraceStep[];
  stats: { trace: Record<string, number>; cache: Record<string, number>; l1Enabled: boolean } | null;
  onRefresh: () => void;
}

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  llm_call: { label: 'LLM', cls: 'llm' },
  tool_call: { label: 'TOOL', cls: 'tool' },
  cache_hit: { label: 'CACHE', cls: 'cache' },
  user_msg: { label: 'USER', cls: 'sys' },
  system: { label: 'SYS', cls: 'sys' },
};

function fmtMs(ms?: number): string {
  if (ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 当前可见步骤导出为 JSONL 审计文件（本地下载） */
function exportJsonl(steps: TraceStep[]) {
  if (!steps.length) return;
  const blob = new Blob([steps.map((s) => JSON.stringify(s)).join('\n')], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `maharness-trace-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 单条步骤渲染（span 树：子步骤缩进 + 可折叠下钻，OpenAI/Anthropic agent 调试器风格） */
function StepRow({ s, depth, collapsed, onToggle }: { s: TraceStep; depth: number; collapsed: boolean; onToggle: () => void }) {
  const b = TYPE_BADGE[s.type] ?? { label: s.type.toUpperCase(), cls: 'sys' };
  return (
    <div
      className={`tl-item ${s.status === 'running' ? 'streaming' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <div className="tl-head" onClick={depth > 0 ? onToggle : undefined} style={depth > 0 ? { cursor: 'pointer' } : undefined}>
        <div className="tl-left">
          {depth > 0 && <span className={`tl-arrow ${collapsed ? '' : 'open'}`}>▾</span>}
          <span className={`tl-badge ${b.cls}`}>{b.label}</span>
          <span className="tl-title">{s.name ?? b.label}</span>
          {depth > 0 && s.traceId && <span className="tl-child-tag" title="子任务（span 树下钻：子代理/并行）">子任务</span>}
        </div>
        <div className="tl-right">
          {s.cacheLayer && <span style={{ color: 'var(--teal)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>L{s.cacheLayer} ✓</span>}
          <span className="tl-dur">{fmtMs(s.durationMs)}</span>
        </div>
      </div>
      {!collapsed && (
        <>
          {(s.tokensIn || s.tokensOut || s.cost) && (
            <div className="tl-body">↑{s.tokensIn ?? 0} ↓{s.tokensOut ?? 0}{s.cost ? ` · $${s.cost.toFixed(4)}` : ''}</div>
          )}
          {s.outputSummary && <div className="tl-body" style={{ color: 'var(--text-3)' }}>{s.outputSummary}</div>}
          {s.error && <div className="tl-body" style={{ color: 'var(--red)' }}>{s.error}</div>}
        </>
      )}
    </div>
  );
}

export default function TracePanel({ steps, stats, onRefresh }: Props) {
  const [typeFilter, setTypeFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // span 树组装：root = 无 parentId 的步骤；children 按 parentId 索引。
  // 跨 traceId 也成立——子代理步骤的 parentId 指向调用方工具步骤（OpenAI tracing 层级）
  const tree = useMemo(() => {
    const filtered = typeFilter ? steps.filter((s) => s.type === typeFilter) : steps;
    const byParent = new Map<string, TraceStep[]>();
    for (const s of filtered) {
      if (!s.parentId) continue;
      const arr = byParent.get(s.parentId) ?? [];
      arr.push(s);
      byParent.set(s.parentId, arr);
    }
    const roots = filtered.filter((s) => !s.parentId);
    return { roots, byParent };
  }, [steps, typeFilter]);
  const { roots, byParent } = tree;
  // 缓存命中率优先用「provider 真实命中率」（token 口径，唯一权威）：
  // L3 前缀缓存是 agent 成本主战场（DeepSeek 命中/未命中价差 50~120 倍），
  // L1/L2 只对重复问题/重复工具调用生效——全新问答命中为 0 是正常设计，不能作为主指标。
  // 无 provider 反馈（不支持缓存/无命中字段）时回退 trace.cacheHits 口径。
  const cache = stats?.cache ?? {};
  const realTotal = (cache.l3RealTokens ?? 0) + (cache.l3RealMissTokens ?? 0);
  const cacheRate = realTotal > 0
    ? Math.round(((cache.l3RealTokens ?? 0) / realTotal) * 100)
    : stats?.trace?.cacheHits
      ? Math.min(100, Math.round((stats.trace.cacheHits / Math.max(1, stats.trace.llmCalls + stats.trace.toolCalls)) * 100))
      : 0;

  // 深度优先渲染（倒序：最新在前），子步骤折叠时只显示一行
  const renderTree = (): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    const visit = (s: TraceStep, depth: number) => {
      const children = byParent.get(s.id) ?? [];
      const isCollapsed = !!collapsed[s.id];
      out.push(
        <StepRow
          key={s.id}
          s={s}
          depth={depth}
          collapsed={isCollapsed}
          onToggle={() => setCollapsed((c) => ({ ...c, [s.id]: !c[s.id] }))}
        />,
      );
      if (!isCollapsed) {
        for (const c of [...children].reverse()) visit(c, depth + 1);
      }
    };
    for (const s of [...roots].reverse()) visit(s, 0);
    // 孤儿（父步骤已被环形缓冲淘汰）：仍展示（depth 1，可下钻自己）
    const known = new Set(steps.map((x) => x.id));
    for (const s of [...steps].reverse()) {
      if (s.parentId && !known.has(s.parentId)) {
        out.push(<StepRow key={`or-${s.id}`} s={s} depth={1} collapsed={!!collapsed[s.id]} onToggle={() => setCollapsed((c) => ({ ...c, [s.id]: !c[s.id] }))} />);
      }
    }
    return out;
  };

  return (
    <>
      <div className="trail-head">
        <div className="th-left">
          <span className="th-dot" />
          <span className="th-title">运行轨迹</span>
          {stats && <span className="msg-tag">{steps.length} 条</span>}
        </div>
        <div className="th-right" style={{ display: 'flex', gap: 4 }}>
          <button className="manager-close" title="刷新" aria-label="刷新" onClick={onRefresh}><IconRefresh size={13} /></button>
          <button className="manager-close" title="导出 JSONL" aria-label="导出 JSONL" onClick={() => exportJsonl(steps)} disabled={!steps.length}><IconDownload size={13} /></button>
        </div>
      </div>

      {stats && (
        <div className="trail-stats">
          <div className="ts-grid">
            <div className="ts-card">
              <span className="ts-label">缓存命中率</span>
              <span className="ts-value teal">{cacheRate}%</span>
              <span className="ts-hint">
                {realTotal > 0
                  ? `L3 真实命中 ${(cache.l3RealTokens ?? 0).toLocaleString()} tok · L1 ${cache.l1Hits ?? 0} · L2 ${cache.l2Hits ?? 0}`
                  : `L1 ${cache.l1Hits ?? 0} · L2 ${cache.l2Hits ?? 0}`}
              </span>
            </div>
            <div className="ts-card">
              <span className="ts-label">本次成本</span>
              <span className="ts-value">${(stats.trace.totalCost ?? 0).toFixed(3)}</span>
              <span className="ts-hint">in {stats.trace.totalTokensIn ?? 0} · out {stats.trace.totalTokensOut ?? 0}</span>
            </div>
          </div>
          <div className="ts-grid">
            <div className="ts-card" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px' }}>
              <span className="ts-label">步骤</span>
              <span className="ts-value" style={{ fontSize: 16 }}>{stats.trace.steps ?? 0}</span>
              <span className="ts-label">LLM 调用</span>
              <span className="ts-value" style={{ fontSize: 16 }}>{stats.trace.llmCalls ?? 0}</span>
              <span className="ts-label">工具</span>
              <span className="ts-value" style={{ fontSize: 16 }}>{stats.trace.toolCalls ?? 0}</span>
            </div>
          </div>
          <select
            className="set-input" style={{ height: 28, fontSize: 11, width: '100%' }}
            value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">全部步骤</option>
            {Object.entries(TYPE_BADGE).map(([v, x]) => <option key={v} value={v}>{x.label}</option>)}
          </select>
        </div>
      )}

      <div className="trail-scroll">
        {steps.length === 0 && (
          <div className="empty-state">暂无运行记录——发送消息后这里会实时显示每一步动作</div>
        )}
        {renderTree()}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
          <button className="tl-export" onClick={() => exportJsonl(steps)} disabled={!steps.length} title="导出当前步骤为 JSONL 审计文件">查看完整 JSONL 审计 →</button>
        </div>
      </div>
    </>
  );
}
