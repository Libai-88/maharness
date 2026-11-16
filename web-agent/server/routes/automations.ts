import type { Express } from 'express';
import { AutomationError } from '../automations';
import { tenantIdOf, type RouteDeps } from './shared';

function sendError(res: { status(code: number): { json(body: unknown): unknown } }, error: unknown): void {
  if (error instanceof AutomationError) {
    res.status(error.status).json({ code: error.code, error: error.message });
    return;
  }
  res.status(500).json({ code: 'AUTOMATION_ERROR', error: error instanceof Error ? error.message : String(error) });
}

function revision(body: unknown): number {
  const value = Number((body as { revision?: unknown } | undefined)?.revision);
  if (!Number.isInteger(value) || value < 1) throw new AutomationError(400, 'INVALID_REVISION', '请携带读取到的 revision');
  return value;
}

export function registerAutomationRoutes(app: Express, deps: RouteDeps): void {
  const service = deps.automations;
  if (!service) return;

  app.get('/api/automations', (req, res) => {
    const tenantId = tenantIdOf(req);
    res.json({ automations: service.list(tenantId), occurrences: service.occurrences(tenantId) });
  });

  app.post('/api/automations', (req, res) => {
    try {
      const item = service.create(tenantIdOf(req), req.body ?? {}, 'user');
      res.status(201).json({ automation: item });
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/automations/:id', (req, res) => {
    try {
      const tenantId = tenantIdOf(req);
      res.json({ automation: service.get(tenantId, String(req.params.id)), occurrences: service.occurrences(tenantId, String(req.params.id)) });
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/automations/:id/runs', (req, res) => {
    try {
      const tenantId = tenantIdOf(req);
      service.get(tenantId, String(req.params.id));
      res.json({ occurrences: service.occurrences(tenantId, String(req.params.id)) });
    } catch (error) { sendError(res, error); }
  });

  app.patch('/api/automations/:id', (req, res) => {
    try {
      const item = service.update(tenantIdOf(req), String(req.params.id), revision(req.body), req.body?.patch ?? {}, 'user');
      res.json({ automation: item });
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/automations/:id/confirm', (req, res) => {
    try { res.json({ automation: service.confirm(tenantIdOf(req), String(req.params.id), revision(req.body)) }); }
    catch (error) { sendError(res, error); }
  });

  app.post('/api/automations/:id/pause', (req, res) => {
    try { res.json({ automation: service.pause(tenantIdOf(req), String(req.params.id), revision(req.body)) }); }
    catch (error) { sendError(res, error); }
  });

  app.post('/api/automations/:id/resume', (req, res) => {
    try { res.json({ automation: service.resume(tenantIdOf(req), String(req.params.id), revision(req.body)) }); }
    catch (error) { sendError(res, error); }
  });

  app.post('/api/automations/:id/run', (req, res) => {
    try {
      const occurrence = service.runNow(tenantIdOf(req), String(req.params.id), req.body?.revision === undefined ? undefined : revision(req.body));
      res.status(202).json({ occurrence });
    } catch (error) { sendError(res, error); }
  });

  app.delete('/api/automations/:id', (req, res) => {
    try {
      const body = { ...(req.body ?? {}), revision: req.body?.revision ?? req.query.revision };
      res.json({ automation: service.cancel(tenantIdOf(req), String(req.params.id), revision(body)) });
    } catch (error) { sendError(res, error); }
  });
}
