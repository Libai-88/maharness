import type { Plugin } from '../../kernel/plugin-sdk';

const plugin: Plugin = {
  id: 'reference-hello',
  name: 'Reference Hello',
  version: '0.1.0',
  onLoad(ctx) {
    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: [],
        name: 'reference_hello',
        description: 'Return a deterministic health response from the reference plugin.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: '{ ok: true, plugin: "reference-hello" }',
        outputSchema: {
          type: 'object', required: ['ok', 'plugin'],
          properties: { ok: { type: 'boolean' }, plugin: { type: 'string' } },
        },
        risk: 'low',
        costHint: 'low',
        sideEffect: 'none',
        async handler() {
          return { ok: true, data: { ok: true, plugin: 'reference-hello' } };
        },
      },
    });
  },
};

export default plugin;
