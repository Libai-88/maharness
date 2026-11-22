import { startServer } from '../../index';

const mode = process.argv[2];
const sessionId = process.env.RECOVERY_SESSION_ID;

if (!mode) throw new Error('mode is required');

const runtime = await startServer();
try {
  if (mode === 'seed') {
    const session = runtime.store.createSession('recovery-model', '');
    runtime.store.upsertProvider({
      id: 'recovery-provider',
      label: 'RECOVERY',
      baseUrl: process.env.MOCK_URL ?? '',
      apiKey: 'recovery-key',
      model: 'recovery-model',
    });
    const runId = 'process-recovery-run';
    runtime.store.runs.create({
      id: runId,
      rootId: runId,
      sessionId: session.id,
      tenantId: 'default',
      depth: 0,
      objective: 'recover this task',
      model: 'recovery-model',
      providerId: 'recovery-provider',
      status: 'running',
      authorization: { workspace: process.env.SANDBOX_ROOT!, profile: 'standard', readOnly: false, revision: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cost: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    runtime.store.runs.saveCheckpoint(runId, {
      turn: 1,
      history: [{ role: 'user', content: 'recover this task' }],
      costUsd: 0,
      toolResults: [{ name: 'write_once', ok: true }],
    });
    runtime.store.claimToolEffect(runId, 'write-once-key');
    runtime.store.completeToolEffect(runId, 'write-once-key', { ok: true, data: { written: true } });
    process.stdout.write(`${JSON.stringify({ ready: true, sessionId: session.id })}\n`);
    setInterval(() => undefined, 60_000).unref();
    await new Promise<void>(() => undefined);
  } else if (mode === 'verify') {
    if (!sessionId) throw new Error('RECOVERY_SESSION_ID is required');
    const effectBefore = runtime.store.claimToolEffect('process-recovery-run', 'write-once-key');
    if (effectBefore.state !== 'done') throw new Error(`recovered effect is not done: ${JSON.stringify(effectBefore)}`);
    const before = runtime.runs.get('process-recovery-run', 'default');
    if (before.status !== 'interrupted') throw new Error(`unexpected restored status: ${before.status}`);
    const response = await fetch(`http://127.0.0.1:${process.env.PORT}/api/v2/runs/process-recovery-run/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume: true }),
    });
    if (!response.ok) throw new Error(`resume failed: ${response.status} ${await response.text()}`);
    const events = await fetch(`http://127.0.0.1:${process.env.PORT}/api/v2/runs/process-recovery-run/events`);
    const streamText = await events.text();
    const run = runtime.runs.get('process-recovery-run', 'default');
    process.stdout.write(
      `${JSON.stringify({
        ready: true,
        status: response.status,
        completed: streamText.includes('event: done') && run.status === 'completed',
        effectBefore,
      })}\n`,
    );
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  runtime.server.close();
  runtime.closeEnvWatcher();
  await runtime.runs.shutdown();
  await runtime.kernel.stop();
  runtime.store.close();
}
