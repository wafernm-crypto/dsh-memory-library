import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryPlugin } from '../lib/plugin.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-plugin-'));
const session = { id: 'session-plugin', header: { id: 'session-plugin', cwd: workspace }, deriveMessages: () => [] };
const config = {
  maxStorageBytes: 5 * 1024 ** 3,
  promptMaxChars: 4000,
  journalRetentionDays: 45,
  archiveRetentionDays: 180,
  files: { enabled: false, confirmOverMb: 100 },
};

test('plugin tools share one gate, catalog, and file area', async () => {
  const registered = new Map();
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => {};
      },
      guard() {
        return () => {};
      },
    },
    effect(callback) {
      callback();
      return () => {};
    },
    on() {},
    get(name) {
      return name === 'approval' ? { request: async () => 'allowed-once' } : undefined;
    },
    sessions: {
      get: (id) => (id === session.id ? session : undefined),
      list: () => [session],
    },
    workingDirectory: {
      get: () => workspace,
      defaultDirectory: workspace,
    },
    interval() {
      return () => {};
    },
    timeout() {
      return () => {};
    },
    systemPrompt: { section: () => () => {} },
  };

  const plugin = new MemoryPlugin(ctx, config);
  plugin.start();
  const agent = { id: session.id };
  const store = plugin.storeForAgent(agent);
  store.setSessionEnabled(session.id, true);

  const call = async (name, args) => {
    const definition = registered.get(name);
    assert.ok(definition, `${name} registered`);
    return definition.execute(args, { agent, signal: new AbortController().signal });
  };

  const written = await call('memory_write', {
    title: '插件工具测试',
    summary: '验证工具门禁与目录柜',
    content: '这张卡验证工具层和目录柜能协同工作。',
    importance: 3,
    confidence: 'summary',
    tags: ['测试'],
  });
  assert.match(written.text, /已创建/);

  const searched = await call('memory_search', { query: '插件工具' });
  assert.match(searched.text, /插件工具测试/);

  const status = await call('memory_status', {});
  assert.match(status.text, /卡片：/);

  const source = path.join(workspace, 'plugin-note.txt');
  fs.writeFileSync(source, 'hello plugin', 'utf8');
  const saved = await call('memory_file_save', { path: source, name: 'plugin-note.txt' });
  assert.match(saved.text, /已保存文件/);
  const listed = await call('memory_file_list', {});
  assert.match(listed.text, /plugin-note\.txt/);

  const forgot = await call('memory_forget', { id: 'nonexistent' }).catch((error) => error);
  assert.match(String(forgot.message), /未找到记忆卡/);

  store.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});
