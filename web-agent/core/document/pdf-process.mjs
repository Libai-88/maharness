import { register } from 'tsx/esm/api';
register();
process.once('message', async (job) => {
  try {
    const { documentJob } = await import('./formats.ts');
    const result = await documentJob(job);
    process.send?.({ result }, () => process.disconnect());
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) }, () => process.disconnect());
  }
});
