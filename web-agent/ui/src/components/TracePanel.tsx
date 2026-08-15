// ui/src/components/TracePanel.tsx —— 运行轨迹面板（Screen 1 右侧）：实时步骤 + 缓存/成本统计
import { useState } from 'react';
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

export default function TracePanel({ steps, stats, onRefresh }: Props) {
  const [typeFilter, setTypeFilter] = useState('');
  const filtered = typeFilter ? steps.filter((s) => s.type === typeFilter) : steps;
  const cacheRate = stats?.trace?.cacheHits
    ? Math.min(100, Math.round((stats.trace.cacheHits / Math.max(1, stats.trace.llmCalls + stats.trace.toolCalls)) * 100))
    : 0;

  return (
    <>
      <div className="trail-head">
        <div className="th-left">
          <span className="th-dot" />
          <span className="th-title">运行轨迹</span>
          {stats && <span className="msg-tag">{filtered.length} 条</span>}
        </div>
        <div className="th-right" style={{ display: 'flex', gap: 4 }}>
          <button className="manager-close" title="刷新" aria-label="刷新" onClick={onRefresh}><IconRefresh size={13} /></button>
          <button className="manager-close" title="导出 JSONL" aria-label="导出 JSONL" onClick={() => exportJsonl(filtered)} disabled={!steps.length}><IconDownload size={13} /></button>
        </div>
      </div>

      {stats && (
        <div className="trail-stats">
          <div className="ts-grid">
            <div className="ts-card">
              <span className="ts-label">缓存命中率</span>
              <span className="ts-value teal">{cacheRate}%</span>
              <span className="ts-hint">L1 {stats.cache.l1Hits ?? 0} · L2 {stats.cache.l2Hits ?? 0}</span>
            </div>
            <div className="ts-card">
              <span className="ts-label">本次成本</span>
              <span className="ts-value">¥{(stats.trace.totalCost ?? 0).toFixed(3)}</span>
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
        {[...filtered].reverse().map((s) => {
          const b = TYPE_BADGE[s.type] ?? { label: s.type.toUpperCase(), cls: 'sys' };
          return (
            <div key={s.id} className={`tl-item ${s.status === 'running' ? 'streaming' : ''}`}>
              <div className="tl-head">
                <div className="tl-left">
                  <span className={`tl-badge ${b.cls}`}>{b.label}</span>
                  <span className="tl-title">{s.name ?? b.label}</span>
                </div>
                <div className="tl-right">
                  {s.cacheLayer && <span style={{ color: 'var(--teal)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>L{s.cacheLayer} ✓</span>}
                  <span className="tl-dur">{fmtMs(s.durationMs)}</span>
                </div>
              </div>
              {(s.tokensIn || s.tokensOut || s.cost) && (
                <div className="tl-body">↑{s.tokensIn ?? 0} ↓{s.tokensOut ?? 0}{s.cost ? ` · ¥${s.cost.toFixed(4)}` : ''}</div>
              )}
              {s.outputSummary && <div className="tl-body" style={{ color: 'var(--text-3)' }}>{s.outputSummary}</div>}
              {s.error && <div className="tl-body" style={{ color: 'var(--red)' }}>{s.error}</div>}
            </div>
          );
        })}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
          <button className="tl-export" onClick={() => exportJsonl(filtered)} disabled={!steps.length} title="导出当前步骤为 JSONL 审计文件">查看完整 JSONL 审计 →</button>
        </div>
      </div>
    </>
  );
}
