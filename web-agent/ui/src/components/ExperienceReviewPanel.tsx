import { useCallback, useEffect, useState } from 'react';
import { Bot, CheckCircle2, CircleAlert, FileSearch, RefreshCw, ShieldCheck, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  experienceApi,
  type AIUserReview,
  type AIUserReviewEstimate,
  type ExperienceAudit,
  type ExperienceFinding,
  type ReviewDimensionScore,
} from '../experience-api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '复盘中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  insufficient_evidence: '证据不足',
};
const verdictLabels: Record<string, string> = {
  positive: '正向',
  neutral: '中性',
  negative: '负向',
  insufficient_evidence: '证据不足',
};
const dimensionLabels: Record<string, string> = {
  capability_discovery: '能力发现',
  tool_contract_clarity: '工具契约清晰度',
  result_actionability: '结果可操作性',
  state_credibility: '状态可信度',
  error_recovery: '错误恢复',
  execution_efficiency: '执行效率',
  context_continuity: '上下文连续性',
  authorization_control: '授权控制',
  result_usability: '结果可用性',
  reuse_intention: '再次使用意愿',
};
const gateLabels: Record<string, string> = {
  allTerminal: '全部结束',
  noFalseSuccess: '无虚假成功',
  noUnknownSideEffects: '无未知副作用',
  noUnauthorizedSideEffects: '无未授权副作用',
  artifactsParsable: '产物可解析',
};

type CalibrationDimension = {
  score: ReviewDimensionScore['score'];
  reason: string;
  evidenceRefs: string[];
};

function sameScope(review: AIUserReview, runIds: string[]): boolean {
  return review.sourceRunIds.length === runIds.length && runIds.every((id) => review.sourceRunIds.includes(id));
}

function ScoreRow({ dimension }: { dimension: ReviewDimensionScore }) {
  return (
    <div className="rounded-md border p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{dimensionLabels[dimension.id] ?? dimension.id}</span>
        <Badge
          variant={
            dimension.score !== null && dimension.score >= 4
              ? 'secondary'
              : dimension.score !== null && dimension.score <= 2
                ? 'destructive'
                : 'outline'
          }
        >
          {dimension.score === null ? 'N/A' : `${dimension.score}/5`}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{dimension.reason || '未说明'}</p>
      {dimension.evidenceRefs.length > 0 && (
        <p className="mt-1 break-all text-[11px] text-muted-foreground">证据：{dimension.evidenceRefs.join('、')}</p>
      )}
    </div>
  );
}

export default function ExperienceReviewPanel({ runIds }: { runIds: string[] }) {
  const scopeKey = runIds.join(',');
  const [estimate, setEstimate] = useState<AIUserReviewEstimate>();
  const [current, setCurrent] = useState<AIUserReview>();
  const [audits, setAudits] = useState<ExperienceAudit[]>([]);
  const [findings, setFindings] = useState<ExperienceFinding[]>([]);
  const [alternative, setAlternative] = useState<{ providerId: string; model: string }>();
  const [models, setModels] = useState<Array<{ provider: string; model: string }>>([]);
  const [busy, setBusy] = useState('');
  const [calibration, setCalibration] = useState('');
  const [calibrationVerdict, setCalibrationVerdict] = useState<'agree' | 'disagree' | 'inconclusive'>('agree');
  const [calibrationDimensions, setCalibrationDimensions] = useState<Record<string, CalibrationDimension>>({});

  const load = useCallback(async () => {
    if (!runIds.length) return;
    const listed = await experienceApi.list(runIds[0]).then((value) => value.reviews);
    const matched = listed.find((review) => sameScope(review, runIds));
    if (!matched) {
      setCurrent(undefined);
      setAudits([]);
      setFindings([]);
      return;
    }
    const detail = await experienceApi.detail(matched.id);
    setCurrent(detail.review);
    setAudits(detail.audits);
    setFindings(detail.findings);
  }, [scopeKey]);

  useEffect(() => {
    setEstimate(undefined);
    setCurrent(undefined);
    setAudits([]);
    setFindings([]);
    void load().catch((error) => toast.error(String(error)));
  }, [scopeKey]);

  const active = current && ['queued', 'running'].includes(current.status);
  useEffect(() => {
    if (!current) {
      setCalibrationDimensions({});
      return;
    }
    setCalibrationDimensions(
      Object.fromEntries(
        current.dimensions.map((dimension) => [
          dimension.id,
          { score: dimension.score, reason: dimension.reason, evidenceRefs: dimension.evidenceRefs },
        ]),
      ),
    );
  }, [current?.id]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load().catch(() => undefined), 1500);
    return () => clearInterval(timer);
  }, [active, load]);

  const requestEstimate = async () => {
    setBusy('estimate');
    try {
      const value = await experienceApi.estimate(runIds, alternative);
      setEstimate(value);
      if (!value.available) {
        const availableModels = await experienceApi.models();
        setModels(availableModels);
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy('');
    }
  };

  const start = async () => {
    if (!estimate) return;
    setBusy('start');
    try {
      const created = await experienceApi.create(runIds, alternative);
      setCurrent(created.review);
      setAudits([]);
      setFindings([]);
      setEstimate(undefined);
      toast.success('AI 使用复盘已开始');
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy('');
    }
  };

  const action = async (kind: 'cancel' | 'deepen' | 'audit') => {
    if (!current) return;
    setBusy(kind);
    try {
      if (kind === 'cancel') await experienceApi.cancel(current.id);
      else if (kind === 'deepen') await experienceApi.deepen(current.id);
      else await experienceApi.audit(current.id);
      await load();
      toast.success(kind === 'cancel' ? '复盘已取消' : kind === 'deepen' ? '已开始深入分析' : '独立复核已完成');
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy('');
    }
  };

  const calibrate = async () => {
    if (!current || !calibration.trim()) return;
    setBusy('calibrate');
    try {
      await experienceApi.calibrate(current.id, {
        verdict: calibrationVerdict,
        summary: calibration.trim(),
        dimensions: current.dimensions.map((dimension) => {
          const edited = calibrationDimensions[dimension.id];
          return {
            id: dimension.id,
            score: edited?.score ?? dimension.score,
            reason: edited?.reason ?? dimension.reason,
            evidenceRefs: edited?.evidenceRefs ?? dimension.evidenceRefs,
          };
        }),
      });
      setCalibration('');
      await load();
      toast.success('人工校准已追加');
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy('');
    }
  };

  const adopt = async (suggestionId: string) => {
    if (!current) return;
    setBusy(suggestionId);
    try {
      await experienceApi.adopt(current.id, suggestionId);
      await load();
      toast.success('建议已加入体验问题池');
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy('');
    }
  };

  const aiAudits = audits.filter((audit) => audit.source === 'ai');
  const humanAudits = audits.filter((audit) => audit.source === 'human');
  return (
    <section aria-label="AI 使用复盘" className="flex flex-col gap-3" data-testid="experience-review">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">AI 使用复盘</h3>
          <p className="text-sm text-muted-foreground">由完成任务的同一模型在新上下文中读取可审计历程，复盘 maharness 的实际使用体验。</p>
        </div>
        {!active && (
          <Button size="sm" variant="outline" disabled={!!busy || !runIds.length} onClick={() => void requestEstimate()}>
            {busy === 'estimate' ? <RefreshCw className="animate-spin" /> : <FileSearch />}估算复盘
          </Button>
        )}
      </div>

      {estimate && (
        <Card>
          <CardHeader>
            <CardTitle>本次复盘范围</CardTitle>
            <CardDescription>确认模型、预算和取证路径后才会调用模型。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p>
              原工作模型：{estimate.originalProviderId} / {estimate.originalModel}
            </p>
            <p>
              复盘模型：{estimate.providerId} / {estimate.model}
              {estimate.crossModel ? '（跨模型，需明确确认）' : ''}
            </p>
            <p>
              路径：{estimate.path === 'fast' ? '快速复盘' : '聚焦取证'} · {estimate.runCount} 个运行 · 输入上限 {estimate.inputTokenLimit}{' '}
              token · 输出上限 {estimate.outputTokenLimit} token
            </p>
            <p>
              预计费用：{estimate.estimatedCostUsd === null ? '未知，将按模型账本结算' : `$${estimate.estimatedCostUsd.toFixed(6)}`} ·
              价格来源：{estimate.costSource}
            </p>
            {!estimate.available && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <p className="flex items-center gap-2 font-medium">
                  <CircleAlert className="size-4" />
                  原工作模型不可用，必须显式选择替代模型
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <select
                    className="rounded-md border bg-background px-3 py-2"
                    aria-label="替代复盘模型"
                    value={alternative ? `${alternative.providerId}\u0000${alternative.model}` : ''}
                    onChange={(event) => {
                      const [providerId, model] = event.target.value.split('\u0000');
                      setAlternative(providerId && model ? { providerId, model } : undefined);
                      setEstimate(undefined);
                    }}
                  >
                    <option value="">选择替代模型</option>
                    {models.map((item) => (
                      <option key={`${item.provider}@${item.model}`} value={`${item.provider}\u0000${item.model}`}>
                        {item.provider} / {item.model}
                      </option>
                    ))}
                  </select>
                  <Button variant="outline" onClick={() => void requestEstimate()}>
                    重新估算
                  </Button>
                </div>
              </div>
            )}
            {estimate.available && (
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy === 'start'} onClick={() => void start()}>
                  {busy === 'start' ? <RefreshCw className="animate-spin" /> : <Bot />}
                  {estimate.crossModel ? '确认跨模型复盘' : '开始复盘'}
                </Button>
                <Button variant="ghost" onClick={() => setEstimate(undefined)}>
                  取消
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {current && (
        <Card data-testid="experience-review-result">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>复盘结果</CardTitle>
              <Badge variant={current.verdict === 'negative' ? 'destructive' : current.verdict === 'positive' ? 'secondary' : 'outline'}>
                {statusLabels[current.status] ?? current.status} · {verdictLabels[current.verdict] ?? current.verdict}
              </Badge>
              {current.crossModel && <Badge variant="outline">跨模型</Badge>}
            </div>
            <CardDescription>
              {current.providerId} / {current.model} · {current.path === 'fast' ? '快速' : '聚焦'} · {current.calls} 次调用 ·{' '}
              {current.budget.inputTokens + current.budget.outputTokens} token · ${current.budget.costUsd.toFixed(6)}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {active && (
              <div className="flex items-center gap-2">
                <RefreshCw className="size-4 animate-spin" />
                <span className="text-sm">正在读取事实与按需证据…</span>
                <Button size="sm" variant="outline" disabled={busy === 'cancel'} onClick={() => void action('cancel')}>
                  取消
                </Button>
              </div>
            )}
            {current.error && (
              <p role="alert" className="text-sm">
                {current.error}
              </p>
            )}

            <div>
              <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4" />
                实际发生
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {Object.entries(current.facts.gates).map(([key, passed]) => (
                  <div key={key} className="rounded-md border p-2 text-xs">
                    <span className={passed ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}>
                      {passed ? '通过' : '未通过'}
                    </span>
                    <p className="mt-1">{gateLabels[key] ?? key}</p>
                  </div>
                ))}
              </div>
              {current.facts.anomalies.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {current.facts.anomalies.map((item) => (
                    <p key={`${item.code}|${item.summary}`} className="break-words text-xs">
                      <Badge variant={item.severity === 'P0' || item.severity === 'P1' ? 'destructive' : 'outline'}>{item.severity}</Badge>{' '}
                      <span className="ml-2">
                        {item.summary}
                        {item.occurrences > 1 ? ` · 出现 ${item.occurrences} 次` : ''}
                      </span>
                    </p>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                工具 {current.facts.totals.toolCalls} 次 · 模型 {current.facts.totals.modelCalls} 次 · 失败{' '}
                {current.facts.totals.failedTools} · 重复 {current.facts.totals.duplicateTools} · 审批等待{' '}
                {current.facts.totals.approvalWaits} · 产物 {current.facts.totals.artifacts}
                {current.facts.omittedRuns ? ` · 另有 ${current.facts.omittedRuns} 条运行计入汇总` : ''}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                模型输入 {current.facts.totals.modelInputTokens ?? 0} · 输出 {current.facts.totals.modelOutputTokens ?? 0} token · 成本 $
                {(current.facts.totals.modelCostUsd ?? 0).toFixed(6)} · 调用失败 {current.facts.totals.modelFailures ?? 0}
              </p>
            </div>

            <div>
              <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                <Bot className="size-4" />
                AI 用户复盘
              </p>
              {current.selfEvaluationBias?.detected && (
                <p className="mb-2 text-xs text-destructive">自评偏差：{current.selfEvaluationBias.reason}</p>
              )}
              <div className="grid gap-2 md:grid-cols-2">
                {current.dimensions.map((dimension) => (
                  <ScoreRow key={dimension.id} dimension={dimension} />
                ))}
              </div>
              {current.observations.length > 0 && (
                <div className="mt-3 flex flex-col gap-1">
                  {current.observations.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 观察项结构只有 kind 与自由文本，位置即身份
                    <p key={index} className="text-sm">
                      <span
                        className={
                          item.kind === 'positive' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'
                        }
                      >
                        {item.kind === 'positive' ? '正向' : '摩擦'}
                      </span>{' '}
                      · {item.summary}
                      {item.cost ? ` · ${item.cost}` : ''}
                    </p>
                  ))}
                </div>
              )}
              {current.evidenceGaps.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">证据缺口：{current.evidenceGaps.join('；')}</p>
              )}
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">带证据的改进建议</p>
              {current.suggestions.length === 0 && <p className="text-sm text-muted-foreground">没有建议。</p>}
              <div className="flex flex-col gap-2">
                {current.suggestions.map((suggestion) => {
                  const adopted = findings.find((finding) => finding.suggestionId === suggestion.id);
                  return (
                    <div key={suggestion.id} className="rounded-md border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex-1 text-sm font-medium">{suggestion.title}</span>
                        <Badge variant="outline">
                          {suggestion.category} · {suggestion.impact} · {Math.round(suggestion.confidence * 100)}%
                        </Badge>
                        {adopted ? (
                          <Badge variant="secondary">{adopted.status}</Badge>
                        ) : (
                          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void adopt(suggestion.id)}>
                            加入问题池
                          </Button>
                        )}
                      </div>
                      <p className="mt-1 text-xs">{suggestion.detail}</p>
                      <p className="mt-1 break-all text-[11px] text-muted-foreground">{suggestion.evidenceRefs.join('、')}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                <UserCheck className="size-4" />
                人工校准
              </p>
              <p className="text-xs text-muted-foreground">校准追加保存，不改写事实或原始 AI 评分。</p>
              <div className="mt-2 flex flex-col gap-2">
                <select
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  aria-label="人工校准结论"
                  value={calibrationVerdict}
                  onChange={(event) => setCalibrationVerdict(event.target.value as typeof calibrationVerdict)}
                >
                  <option value="agree">认可 AI 复盘</option>
                  <option value="disagree">不认可</option>
                  <option value="inconclusive">暂不能判断</option>
                </select>
                <textarea
                  className="min-h-20 rounded-md border bg-background p-2 text-sm"
                  aria-label="人工校准说明"
                  value={calibration}
                  onChange={(event) => setCalibration(event.target.value)}
                  placeholder="补充人类验收、目标变化或主观判断…"
                />
                <details className="rounded-md border p-2">
                  <summary className="cursor-pointer text-sm font-medium">逐维度人工校准</summary>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    {current.dimensions.map((dimension) => {
                      const edited = calibrationDimensions[dimension.id] ?? dimension;
                      return (
                        <div key={dimension.id} className="rounded-md bg-muted/40 p-2">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 text-sm">{dimensionLabels[dimension.id] ?? dimension.id}</span>
                            <select
                              aria-label={`人工评分 ${dimensionLabels[dimension.id] ?? dimension.id}`}
                              className="rounded-md border bg-background px-2 py-1 text-xs"
                              value={edited.score ?? ''}
                              onChange={(event) =>
                                setCalibrationDimensions((values) => ({
                                  ...values,
                                  [dimension.id]: {
                                    ...edited,
                                    score: event.target.value === '' ? null : (Number(event.target.value) as ReviewDimensionScore['score']),
                                  },
                                }))
                              }
                            >
                              <option value="">N/A</option>
                              {[1, 2, 3, 4, 5].map((score) => (
                                <option key={score} value={score}>
                                  {score}/5
                                </option>
                              ))}
                            </select>
                          </div>
                          <textarea
                            aria-label={`人工理由 ${dimensionLabels[dimension.id] ?? dimension.id}`}
                            className="mt-2 min-h-16 w-full rounded-md border bg-background p-2 text-xs"
                            value={edited.reason}
                            onChange={(event) =>
                              setCalibrationDimensions((values) => ({
                                ...values,
                                [dimension.id]: { ...edited, reason: event.target.value },
                              }))
                            }
                          />
                          <select
                            multiple
                            size={Math.min(3, Math.max(1, current.evidenceIndex.length))}
                            aria-label={`人工证据 ${dimensionLabels[dimension.id] ?? dimension.id}`}
                            className="mt-2 w-full rounded-md border bg-background p-1 text-[11px]"
                            value={edited.evidenceRefs}
                            onChange={(event) =>
                              setCalibrationDimensions((values) => ({
                                ...values,
                                [dimension.id]: {
                                  ...edited,
                                  evidenceRefs: [...event.target.selectedOptions].map((option) => option.value),
                                },
                              }))
                            }
                          >
                            {current.evidenceIndex.map((evidence) => (
                              <option key={evidence.id} value={evidence.id}>
                                {evidence.label} · {evidence.id}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </details>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={!calibration.trim() || !!busy} onClick={() => void calibrate()}>
                    追加人工校准
                  </Button>
                  <Button size="sm" variant="outline" disabled={!!busy || !current.dimensions.length} onClick={() => void action('audit')}>
                    独立复核（最多 2,000 输入 / 500 输出）
                  </Button>
                  {current.status === 'insufficient_evidence' && (
                    <Button size="sm" disabled={!!busy} onClick={() => void action('deepen')}>
                      继续深入分析
                    </Button>
                  )}
                </div>
              </div>
              {humanAudits.map((audit) => (
                <div key={audit.id} className="mt-2 rounded-md bg-muted p-2 text-xs">
                  <p>
                    {audit.verdict} · {audit.summary} · {new Date(audit.createdAt).toLocaleString()}
                  </p>
                  {audit.dimensions && (
                    <p className="mt-1 text-muted-foreground">
                      {audit.dimensions
                        .map(
                          (dimension) =>
                            `${dimensionLabels[dimension.id] ?? dimension.id} ${dimension.score === null ? 'N/A' : `${dimension.score}/5`}${dimension.reason ? `（${dimension.reason}）` : ''}`,
                        )
                        .join(' · ')}
                    </p>
                  )}
                </div>
              ))}
              {aiAudits.map((audit) => (
                <p key={audit.id} className="mt-2 rounded-md border p-2 text-xs">
                  独立复核：{audit.verdict} · {audit.summary} · {audit.inputTokens ?? 0} / {audit.outputTokens ?? 0} token · $
                  {(audit.costUsd ?? 0).toFixed(6)}
                </p>
              ))}
            </div>

            <details>
              <summary className="cursor-pointer text-sm font-medium">取证片段 · {current.evidence.length}</summary>
              <div className="mt-2 flex flex-col gap-2">
                {current.evidence.map((item) => (
                  <details key={item.ref} className="rounded-md border p-2">
                    <summary className="cursor-pointer break-all text-xs">
                      {item.label} · {item.tokens} token · {item.hash.slice(0, 12)}
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{item.text}</pre>
                  </details>
                ))}
              </div>
            </details>
          </CardContent>
        </Card>
      )}

      {!current && !estimate && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4" />
          尚未生成 AI 用户复盘。复盘只由你主动触发。
        </p>
      )}
    </section>
  );
}
