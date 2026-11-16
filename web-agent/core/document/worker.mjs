import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';
register();
try {
  const { documentJob } = await import('./formats.ts');
  const result = await documentJob(workerData);
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
