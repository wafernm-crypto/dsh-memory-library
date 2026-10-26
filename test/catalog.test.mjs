import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';

const config = {
  maxStorageBytes: 5 * 1024 ** 3,
  slowdown: 2.5,
  promptMaxChars: 4000,
  journalRetentionDays: 45,
  archiveRetentionDays: 180,
  files: { enabled: false, confirmOverMb: 100 },
};

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-catalog-'));
  const store = new MemoryStore(path.join(root, '.dsh-memory'), config, {});
  return { root, store };
}

test('catalog answers search and activation uses gist fields', () => {
  const { root, store } = makeStore();
  try {
    store.write({
      title: '部署分支',
      summary: '部署走 release/2026',
      content: '部署必须使用 release/2026。',
      importance: 4,
      confidence: 'quote',
      tags: ['部署'],
    });
    store.write({
      title: '回滚流程',
      summary: '回滚先切流量再回退',
      content: '回滚时先切流量，再回退版本。',
      importance: 3,
      tags: ['部署'],
    });
    assert.ok(fs.existsSync(path.join(store.dir, 'catalog.db')), 'catalog.db exists');
    const exact = store.search('部署分支');
    assert.ok(exact.length >= 1, '3+ char query uses catalog');
    assert.equal(exact[0].entry.title, '部署分支', 'higher-importance exact card ranks first');
    assert.ok(store.search('部署').length >= 1, 'short query falls back to LIKE');

    const active = store.catalog.active('部署又失败了', 8);
    assert.ok(active.some((card) => card.title === '部署分支'), 'activation finds the deployment card');
    assert.ok(active.every((card) => card.strength >= 0), 'activation cards carry clarity');

    const prompt = store.promptText('部署又失败了');
    assert.match(prompt, /此刻想起/);
    assert.match(prompt, /部署分支/);
    assert.match(prompt, /规则/);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('files are stored once, attached to a card, and protected while referenced', () => {
  const { root, store } = makeStore();
  try {
    const source = path.join(root, 'note.txt');
    fs.writeFileSync(source, 'hello memory', 'utf8');
    const { entry } = store.write({
      title: '文件测试',
      summary: '一张带文件的卡',
      content: '这张卡关联一个文本文件。',
      importance: 2,
    });

    const file = store.saveFile(source, { cardId: entry.id, name: 'note.txt' });
    assert.ok(fs.existsSync(file.absolute), 'stored file exists');
    assert.equal(store.listFiles(entry.id).length, 1, 'file is attached to card');
    assert.match(store.read(entry.id), /note\.txt/, 'card read shows the file');

    const same = store.saveFile(source, { name: 'note.txt' });
    assert.equal(same.id, file.id, 'same content is deduplicated');

    assert.throws(() => store.forgetFile(file.id), /仍被某张记忆卡引用/);
    assert.equal(store.forgetFile(file.id, { force: true }), true);
    assert.equal(store.listFiles().length, 0, 'file row is removed');

    const exe = path.join(root, 'bad.exe');
    fs.writeFileSync(exe, 'x');
    assert.throws(() => store.saveFile(exe), /不支持的文件类型/);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('old archived cards are read as level 4 with default certainty', () => {
  const { root, store } = makeStore();
  try {
    const oldFile = path.join(store.archiveDir, 'old-card.md');
    fs.mkdirSync(store.archiveDir, { recursive: true });
    fs.writeFileSync(oldFile, [
      '---',
      'id: old-card',
      'title: 旧卡片',
      'summary: 旧格式',
      'importance: 2',
      'level: 2',
      'tags: []',
      'created: 2025-01-01T00:00:00.000Z',
      'updated: 2025-01-01T00:00:00.000Z',
      'reviewed: 2025-01-01T00:00:00.000Z',
      'reviews: 0',
      'pinned: false',
      '---',
      '',
      '旧正文',
    ].join('\n'));
    const entry = store.entries().get('old-card');
    assert.equal(entry.level, 4, 'archive file becomes archived level');
    assert.equal(entry.confidence, 'summary', 'old card gets default certainty');
    assert.equal(entry.links.length, 0);
    assert.equal(entry.files.length, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file saving setting, pinning, and intentional forgetting work', () => {
  const { root, store } = makeStore();
  try {
    const { entry } = store.write({
      title: '可钉住的卡',
      summary: '钉住后不自动缩',
      content: '这条卡用于验证钉住和遗忘。',
      importance: 3,
    });
    const pinned = store.pinEntry(entry.id, true);
    assert.equal(pinned.pinned, true);
    assert.match(store.read(entry.id), /已固定/);

    store.configure({ files: { enabled: true, confirmOverMb: 50 } });
    assert.equal(store.files.settings.enabled, true);
    assert.equal(store.files.settings.confirmOverMb, 50);
    const saved = JSON.parse(fs.readFileSync(store.settingsFile, 'utf8'));
    assert.equal(saved.files.enabled, true);

    assert.equal(store.forgetEntry(entry.id), true);
    assert.equal(store.resolveId(entry.id), undefined);
    assert.equal(store.search('可钉住').length, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
