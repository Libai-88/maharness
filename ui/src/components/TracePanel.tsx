// ui/src/components/TracePanel.tsx —— 运行轨迹面板（黑箱解药）
import type { TraceStep } from '../types';

interface Props {
  steps: TraceStep[];
  stats: { trace: Record<string, number>; cache: Record<string, number>; l1Enabled: boolean } | null;
}

const TYPE_LABEL: Record<string, string> = {
  llm_call: 'LLM 调用',
  tool_call: '工具调用',
  cache_hit: '缓存命中',
  user_msg: '用户消息',
  system: '系统',
};

export default function TracePanel({ steps, stats }: Props) {
  return (
    <div className="trace-body">
      {stats && (
        <div className="trace-stats">
          <div>LLM 调用 <b>{stats.trace.llmCalls}</b></div>
          <div>工具调用 <b>{stats.trace.toolCalls}</b></div>
          <div>缓存命中 <b>{stats.trace.cacheHits}</b></div>
          <div>总成本 <b>${(stats.trace.totalCost ?? 0).toFixed(5)}</b></div>
          <div>L2 命中 <b>{stats.cache.l2Hits}</b> / L1 {stats.l1Enabled ? '开' : '关'}</div>
        </div>
      )}
      <div className="trace-list">
        {steps.length === 0 && <div className="empty-hint">暂无运行记录——发送消息后这里会实时显示每一步动作</div>}
        {[...steps].reverse().map((s) => (
          <div key={s.id} className={`trace-step ${s.status}`}>
            <div className="trace-head">
              <span className={`trace-type ${s.type}`}>{TYPE_LABEL[s.type] ?? s.type}</span>
              {s.name && <span className="trace-name">{s.name}</span>}
              <span className={`trace-status ${s.status}`}>{s.status === 'done' ? `✓ ${s.durationMs ?? '?'}ms` : s.status}</span>
            </div>
            {(s.tokensIn || s.tokensOut) && (
              <div className="trace-tokens">tokens ↑{s.tokensIn} ↓{s.tokensOut}{s.cost ? ` · $${s.cost.toFixed(5)}` : ''}</div>
            )}
            {s.cacheLayer && <div className="trace-cache">L2 缓存命中 · 键 {s.cacheKey?.slice(0, 12)}…</div>}
            {s.error && <div className="trace-error">{s.error}</div>}
            {s.outputSummary && <pre className="trace-output">{s.outputSummary}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}
