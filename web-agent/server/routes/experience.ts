import type { Express, NextFunction, Request, Response } from 'express';
import { ExperienceError, ExperienceService } from '../experience';
import type { AIUserReviewRequest, FindingStatus } from '../experience-store';
import { getChatService, tenantIdOf, type RouteDeps } from './shared';

const FINDING_STATUSES = new Set<FindingStatus>(['new', 'triaged', 'reproduced', 'fixing', 'verifying', 'closed', 'wont_fix', 'reopened']);

interface EvolveExperienceService {
  proposeFromFinding: (input: {
    name: string;
    description: string;
    reason: string;
    findingId: string;
    severity: string;
    evidenceRefs: string[];
    sourceRunIds: string[];
    regressionId?: string;
  }, tenantId: string) => { id: string } | undefined;
}

function requestOf(req: Request): AIUserReviewRequest {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requestKey = req.get('Idempotency-Key') ?? (typeof body.requestKey === 'string' ? body.requestKey : undefined);
  if (requestKey !== undefined && (!requestKey.trim() || requestKey.length > 100)) throw new ExperienceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等标识不能为空且不能超过 100 字');
  return {
    runIds: Array.isArray(body.runIds) ? body.runIds as string[] : [],
    ...(typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(requestKey ? { requestKey } : {}),
  };
}

export function registerExperienceRoutes(app: Express, deps: RouteDeps): ExperienceService {
  const service = new ExperienceService({
    store: deps.store,
    providers: () => getChatService(deps.kernel)?.providers ?? [],
    emit: (type, data, traceId) => deps.kernel.bus.emit({ type, data, traceId, ts: Date.now() }),
  });
  const wrap = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    try {
      Promise.resolve(handler(req, res)).catch(error => {
        if (error instanceof ExperienceError) res.status(error.status).json({ code: error.code, error: error.message });
        else next(error);
      });
    } catch (error) {
      if (error instanceof ExperienceError) res.status(error.status).json({ code: error.code, error: error.message });
      else next(error);
    }
  };
  const requireWrite = (req: Request) => {
    if ((req as Request & { apiRole?: string }).apiRole === 'readonly') {
      throw new ExperienceError(403, 'USER_AUTHORIZATION_REQUIRED', 'AI 使用复盘需要用户写权限');
    }
  };
  const limitOf = (req: Request, fallback = 100) => {
    const value = Number(req.query.limit ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new ExperienceError(400, 'INVALID_LIMIT', '读取数量必须为 1 至 500');
    return value;
  };

  app.post('/api/experience/reviews/estimate', wrap((req, res) => {
    requireWrite(req);
    res.json(service.estimate(requestOf(req), tenantIdOf(req)));
  }));

  app.post('/api/experience/reviews', wrap((req, res) => {
    requireWrite(req);
    res.status(202).json({ review: service.create(requestOf(req), tenantIdOf(req)) });
  }));

  app.get('/api/experience/reviews', wrap((req, res) => {
    const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
    res.json({ reviews: service.list(tenantIdOf(req), limitOf(req), runId) });
  }));

  app.get('/api/experience/reviews/:id', wrap((req, res) => {
    const tenantId = tenantIdOf(req);
    const review = service.review(String(req.params.id), tenantId);
    const findings = deps.store.experience.findings(tenantId, undefined, 500).filter(item => item.reviewId === review.id);
    res.json({ review, audits: service.audits(review.id, tenantId), findings });
  }));

  app.post('/api/experience/reviews/:id/cancel', wrap((req, res) => {
    requireWrite(req);
    res.json({ review: service.cancel(String(req.params.id), tenantIdOf(req)) });
  }));

  app.post('/api/experience/reviews/:id/deepen', wrap((req, res) => {
    requireWrite(req);
    res.status(202).json({ review: service.deepen(String(req.params.id), tenantIdOf(req)) });
  }));

  app.post('/api/experience/reviews/:id/audit', wrap(async (req, res) => {
    requireWrite(req);
    const audit = await service.audit(String(req.params.id), tenantIdOf(req), {
      ...(typeof req.body?.providerId === 'string' ? { providerId: req.body.providerId } : {}),
      ...(typeof req.body?.model === 'string' ? { model: req.body.model } : {}),
    });
    res.status(201).json({ audit });
  }));

  app.post('/api/experience/reviews/:id/calibrate', wrap((req, res) => {
    requireWrite(req);
    const audit = service.calibrate(String(req.params.id), tenantIdOf(req), {
      verdict: req.body?.verdict,
      summary: req.body?.summary,
      dimensions: req.body?.dimensions,
    });
    res.status(201).json({ audit });
  }));

  app.post('/api/experience/reviews/:id/suggestions/:suggestionId/adopt', wrap((req, res) => {
    requireWrite(req);
    res.status(201).json({ finding: service.adoptSuggestion(String(req.params.id), String(req.params.suggestionId), tenantIdOf(req)) });
  }));

  app.get('/api/experience/findings', wrap((req, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (rawStatus && !FINDING_STATUSES.has(rawStatus as FindingStatus)) throw new ExperienceError(400, 'INVALID_FINDING_STATUS', '体验问题状态无效');
    res.json({ findings: service.findings(tenantIdOf(req), rawStatus as FindingStatus | undefined, limitOf(req)) });
  }));

  app.patch('/api/experience/findings/:id', wrap((req, res) => {
    requireWrite(req);
    const status = req.body?.status;
    if (typeof status !== 'string' || !FINDING_STATUSES.has(status as FindingStatus)) throw new ExperienceError(400, 'INVALID_FINDING_STATUS', '体验问题状态无效');
    const finding = service.updateFinding(
      String(req.params.id),
      tenantIdOf(req),
      status as FindingStatus,
      typeof req.body?.statusNote === 'string' ? req.body.statusNote : undefined,
    );
    res.json({ finding });
  }));

  app.post('/api/experience/findings/:id/reproduce', wrap((req, res) => {
    requireWrite(req);
    const result = service.reproduceFinding(
      String(req.params.id),
      tenantIdOf(req),
      typeof req.body?.expected === 'string' ? req.body.expected : undefined,
    );
    res.status(201).json(result);
  }));

  app.post('/api/experience/findings/:id/verify', wrap((req, res) => {
    requireWrite(req);
    const outcome = req.body?.outcome;
    if (outcome !== 'passed' && outcome !== 'failed') throw new ExperienceError(400, 'INVALID_REGRESSION_RESULT', '回归结果必须为 passed 或 failed');
    const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
    const summary = typeof req.body?.summary === 'string' ? req.body.summary : '';
    if (!runId) throw new ExperienceError(400, 'INVALID_REGRESSION_RESULT', '回归结果必须绑定验证运行');
    res.status(201).json(service.recordRegressionResult(String(req.params.id), tenantIdOf(req), { outcome, runId, summary }));
  }));

  app.post('/api/experience/findings/:id/evolve', wrap((req, res) => {
    requireWrite(req);
    const evolve = deps.kernel.plugins.resolveService('service:evolve') as EvolveExperienceService | undefined;
    if (!evolve?.proposeFromFinding) throw new ExperienceError(503, 'EVOLVE_UNAVAILABLE', '自进化提案服务不可用');
    const tenantId = tenantIdOf(req);
    const finding = service.evolveFinding(String(req.params.id), tenantId, input => evolve.proposeFromFinding(input, tenantId));
    res.status(201).json({ finding });
  }));

  return service;
}
