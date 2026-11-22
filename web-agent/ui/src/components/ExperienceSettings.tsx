import { useEffect, useState } from 'react';
import { Bot, ExternalLink } from 'lucide-react';
import { experienceApi, type AIUserReview } from '../experience-api';
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

export default function ExperienceSettings({ onOpenRuns }: { onOpenRuns?: () => void }) {
  const [reviews, setReviews] = useState<AIUserReview[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void experienceApi
      .list()
      .then((result) => {
        setReviews(Array.isArray(result.reviews) ? result.reviews.slice(0, 20) : []);
        setError('');
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const costUsd = reviews.reduce((sum, review) => sum + review.budget.costUsd, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI 用户复盘</CardTitle>
        <CardDescription>查看固定评分口径、Token 上限与最近复盘。复盘只由人类在运行诊断或工作台主动触发。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Rubric</p>
            <p className="mt-1 font-medium">ai-user-review-v1</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">快速路径上限</p>
            <p className="mt-1 font-medium">3,800 token</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">单 Run 聚焦上限</p>
            <p className="mt-1 font-medium">9,200 token</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">多 Run 上限</p>
            <p className="mt-1 font-medium">11,500 token</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          超出预算立即终止；独立复核和继续深入分析都由人类额外确认。最近 {reviews.length} 次复盘费用 ${costUsd.toFixed(6)}。
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {reviews.length > 0 && (
          <div className="flex flex-col gap-2">
            {reviews.slice(0, 5).map((review) => (
              <div key={review.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                <Bot className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {review.originalProviderId} / {review.originalModel} · {review.path === 'fast' ? '快速' : '聚焦'}
                </span>
                <Badge variant={review.verdict === 'negative' ? 'destructive' : review.verdict === 'positive' ? 'secondary' : 'outline'}>
                  {statusLabels[review.status] ?? review.status} · {review.verdict}
                </Badge>
              </div>
            ))}
          </div>
        )}
        <div>
          <Button variant="outline" disabled={!onOpenRuns} onClick={onOpenRuns}>
            <ExternalLink data-icon="inline-end" />
            打开运行记录与复盘
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
