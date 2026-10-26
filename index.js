import { MemoryPlugin } from './lib/plugin.js';

export const inject = [
  'tools',
  'systemPrompt',
  'workingDirectory',
  'sessions',
  'approval',
  'llm',
  'agentDefaultModel',
  'timer',
];

export function apply(ctx, config) {
  new MemoryPlugin(ctx, config).start();
}
