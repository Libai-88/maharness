import { startServer } from '../../index';

const mode = process.argv[2];
const sessionId = process.env.RECOVERY_SESSION_ID;

if (!mode) throw new Error('mode is required');

const runtime = await startServer();
try {
  if (mode === 'seed') {
    const session = runtime.store.createSession('recovery-model', '');
    runtime.store.upsertProvider({
      id: 'recovery-provider', label: 'RECOVERY',
      baseUrl: process.env.MOCK_URL ?? '', apiKey: 'recovery-key', model: 'recovery-model',
    });
    const runId = 'process-recovery-run';
    runtime.store.saveCheckpoint(
      session.id,
      2,
      [{ role: 'user', content: 'recover this task' }],
      runId,
      { objective: 'recover this task', acceptance: [{ type: 'tool_succeeded', name: 'write_once' }] },
      [{ name: 'write_once', ok: true }],
    );
    runtime.store.claimToolEffect(runId, 'write-once-key');
    runtime.store.completeToolEffect(runId, 'write-once-key', { ok: true, data: { written: true } });
    process.stdout.write(`${JSON.stringify({ ready: true, sessionId: session.id })}\n`);
    setInterval(() => undefined, 60_000).unref();
    await new Promise<void>(() => undefined);
  } else if (mode === 'verify') {
    if (!sessionId) throw new Error('RECOVERY_SESSION_ID is required');
    const effectBefore = runtime.store.claimToolEffect('process-recovery-run', 'write-once-key');
    if (effectBefore.state !== 'done') throw new Error(`recovered effect is not done: ${JSON.stringify(effectBefore)}`);
    const response = await fetch(`http://127.0.0.1:${process.env.PORT}/api/sessions/${sessionId}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume: true }),
    });
    const streamText = await response.text();
    if (!response.ok || !streamText.includes('event: done')) {
      throw new Error(`resume chat failed: ${response.status} ${streamText.slice(0, 500)}`);
    }
    const checkpoint = runtime.store.loadCheckpoint(sessionId);
    process.stdout.write(`${JSON.stringify({
      ready: true,
      status: response.status,
      completed: streamText.includes('event: done'),
      checkpointCleared: !checkpoint,
      effectBefore,
    })}\n`);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  runtime.server.close();
  runtime.closeEnvWatcher();
  await runtime.kernel.stop();
  runtime.store.close();
}
