import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';

const DAY = 86400000;
const config = {
  maxStorageBytes: 5 * 1024 ** 3,
  slowdown: 2.5,
  baseFullDays: 4,
  baseSummaryDays: 12,
  importanceFactors: { 1: 0.35, 2: 0.7, 3: 1.3, 4: 4, 5: Number.POSITIVE_INFINITY },
  promptMaxChars: 7000,
  journalRetentionDays: 45,
  archiveRetentionDays: 180,
  files: { enabled: false, confirmOverMb: 100 },
};

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-test-'));
  const store = new MemoryStore(path.join(root, '.dsh-memory'), config, {});
  return { root, store };
}

test('writes, injects into the index, searches, and reads an entry', () => {
  const { root, store } = makeStore();
  try {
    const { entry } = store.write({
      title: '部署分支约定',
      summary: '部署走 release/2026',
      content: '部署必须使用 release/2026 分支，不要直接推 main。',
      importance: 3,
      tags: ['部署'],
    });
    assert.ok(fs.existsSync(store.indexFile), 'INDEX.md is written');
    assert.match(store.promptText(), /部署分支约定/);
    assert.equal(store.search('部署').length, 1);
    assert.match(store.read(entry.id), /release\/2026/);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('memory is off by default and the opt-in state persists', () => {
  const { root, store } = makeStore();
  try {
    assert.equal(store.isSessionEnabled('session-test'), false);
    store.setSessionEnabled('session-test', true);
    assert.equal(store.isSessionEnabled('session-test'), true);
    const reopened = new MemoryStore(store.dir, config, {});
    assert.equal(reopened.isSessionEnabled('session-test'), true);
    reopened.setSessionEnabled('session-test', false);
    assert.equal(reopened.isSessionEnabled('session-test'), false);
    reopened.close();
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('journals a turn and parses it back', () => {
  const { root, store } = makeStore();
  try {
    const now = Date.now();
    store.appendJournal({
      time: now,
      sessionId: 'session-abcdef',
      user: '请记住：部署分支是 release/2026。',
      assistant: '好的，要点是 release/2026。',
    });
    const blocks = store.collectJournalBlocks(0);
    assert.equal(blocks.length, 1);
    assert.match(blocks[0].user, /release\/2026/);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an aged entry becomes due, then compresses to summary and archive', () => {
  const { root, store } = makeStore();
  try {
    const { entry } = store.write({
      title: '旧约定',
      summary: '一条会过期的约定',
      content: '这是一段足够长的正文，用于验证压缩后正文会被丢弃。',
      importance: 2,
    });
    entry.reviewed = new Date(Date.now() - 100 * DAY).toISOString();
    entry.lastActivated = entry.reviewed;
    store.saveEntry(entry);
    assert.ok(store.dueEntries().some((item) => item.id === entry.id));

    store.compressEntry(entry.id, 1);
    assert.equal(store.resolveId(entry.id).level, 1);
    assert.equal(store.resolveId(entry.id).content, '');

    store.compressEntry(entry.id, 2);
    assert.equal(store.resolveId(entry.id).level, 2);

    store.compressEntry(entry.id, 4);
    assert.equal(store.resolveId(entry.id).level, 4);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
