import type { Plugin } from '../../kernel/plugin-sdk';

const plugin: Plugin = {
  id: 'reference-hello',
  name: 'Reference Hello',
  version: '0.1.0',
  onLoad(ctx) {
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'reference_hello',
        description: 'Return a deterministic health response from the reference plugin.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: '{ ok: true, plugin: "reference-hello" }',
        risk: 'low',
        costHint: 'low',
        async handler() {
          return { ok: true, data: { ok: true, plugin: 'reference-hello' } };
        },
      },
    });
  },
};

export default plugin;
