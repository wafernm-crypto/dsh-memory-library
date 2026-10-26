import fs from 'node:fs';
import path from 'node:path';
import {
  appendTextFile,
  clip,
  clampInt,
  dirSize,
  exists,
  formatBytes,
  localDate,
  localTime,
  newId,
  normalizeWhitespace,
  readTextFile,
  removeFile,
  stars,
  walkFiles,
  writeTextFile,
} from './util.js';
import { runConsolidationModel } from './consolidate.js';

const DAY = 86400000;
const RULES_FILE = 'RULES.md';
const INDEX_FILE = 'INDEX.md';
const STATE_FILE = '.state.json';
const JOURNAL_DIR = 'journal';
const LIBRARY_DIR = 'library';
const ARCHIVE_DIR = 'archive';
const LEVEL_LABEL = ['全文', '简介', '已归档（仅标题）'];

function normTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseEntry(text, file) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const head = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\s*\n/, '');
  const meta = {};
  for (const line of head.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!meta.id || !meta.title) return null;
  let tags = [];
  try {
    const parsed = JSON.parse(meta.tags || '[]');
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    tags = String(meta.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  }
  return {
    id: meta.id,
    title: oneLine(meta.title),
    summary: oneLine(meta.summary),
    importance: clampInt(meta.importance, 1, 5, 3),
    level: clampInt(meta.level, 0, 2, 0),
    tags,
    created: meta.created || new Date().toISOString(),
    updated: meta.updated || new Date().toISOString(),
    reviewed: meta.reviewed || meta.updated || new Date().toISOString(),
    reviews: clampInt(meta.reviews, 0, 50, 0),
    pinned: meta.pinned === 'true',
    content: body.trim(),
    file,
  };
}

function serializeEntry(entry) {
  const tags = JSON.stringify(entry.tags || []);
  return [
    '---',
    `id: ${entry.id}`,
    `title: ${entry.title}`,
    `summary: ${entry.summary}`,
    `importance: ${entry.importance}`,
    `level: ${entry.level}`,
    `tags: ${tags}`,
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    `reviewed: ${entry.reviewed}`,
    `reviews: ${entry.reviews}`,
    `pinned: ${entry.pinned ? 'true' : 'false'}`,
    '---',
    '',
    entry.content || '',
    '',
  ].join('\n');
}

export class MemoryStore {
  constructor(dir, config, ctx) {
    this.dir = dir;
    this.baseConfig = config;
    this.settings = this.loadSettings();
    this.config = { ...config, ...this.settings };
    this.ctx = ctx;
    this._entries = null;
    this._entriesAt = 0;
    this._usage = null;
    this._usageAt = 0;
    this._prompt = null;
    this._promptAt = 0;
    this.consolidating = false;
    this.lastError = null;
    this.state = this.loadState();
    this.mounts = this.loadMounts();
    this.sessions = this.loadSessions();
    this._sessionsMtime = 0;
  }

  // ---------------------------------------------------------------- paths

  get rulesFile() {
    return path.join(this.dir, RULES_FILE);
  }

  get indexFile() {
    return path.join(this.dir, INDEX_FILE);
  }

  get journalDir() {
    return path.join(this.dir, JOURNAL_DIR);
  }

  get libraryDir() {
    return path.join(this.dir, LIBRARY_DIR);
  }

  get archiveDir() {
    return path.join(this.dir, ARCHIVE_DIR);
  }

  get settingsFile() {
    return path.join(this.dir, 'settings.json');
  }

  get mountsFile() {
    return path.join(this.dir, 'mounts.json');
  }

  get sessionsFile() {
    return path.join(this.dir, 'sessions.json');
  }

  // ---------------------------------------------------------------- session opt-in

  loadSessions() {
    let raw = {};
    try {
      raw = JSON.parse(readTextFile(this.sessionsFile) || '{}');
    } catch {
      raw = {};
    }
    const map = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      map[id] = {
        enabled: value.enabled === true,
        updatedAt: value.updatedAt || new Date().toISOString(),
      };
    }
    return map;
  }

  isSessionEnabled(sessionId) {
    this.syncSessions();
    return Boolean(this.sessions[String(sessionId)] && this.sessions[String(sessionId)].enabled);
  }

  syncSessions() {
    try {
      const mtime = fs.statSync(this.sessionsFile).mtimeMs;
      if (mtime === this._sessionsMtime) return;
      this._sessionsMtime = mtime;
      this.sessions = this.loadSessions();
    } catch {
      /* no sessions.json yet */
    }
  }

  setSessionEnabled(sessionId, enabled) {
    const key = String(sessionId);
    const next = Boolean(enabled);
    if (!next && !this.sessions[key] && !exists(this.sessionsFile)) return;
    if (next) this.ensureLayout();
    this.sessions[key] = { enabled: next, updatedAt: new Date().toISOString() };
    writeTextFile(this.sessionsFile, `${JSON.stringify(this.sessions, null, 2)}\n`);
    this._sessionsMtime = 0;
    this._prompt = null;
  }

  invalidatePrompt() {
    this._prompt = null;
  }

  loadSettings() {
    let raw = {};
    try {
      raw = JSON.parse(readTextFile(this.settingsFile) || '{}');
    } catch {
      raw = {};
    }
    const allowed = {
      maxStorageBytes: [64 * 1024 * 1024, 1024 ** 4],
      slowdown: [1, 20],
      promptMaxChars: [1200, 20000],
    };
    const settings = {};
    for (const [key, [min, max]] of Object.entries(allowed)) {
      const value = Number(raw[key]);
      if (!Number.isFinite(value)) continue;
      settings[key] = Math.min(max, Math.max(min, key === 'slowdown' ? value : Math.round(value)));
    }
    return settings;
  }

  configure(input) {
    const allowed = {
      maxStorageBytes: [64 * 1024 * 1024, 1024 ** 4, true],
      slowdown: [1, 20, false],
      promptMaxChars: [1200, 20000, true],
    };
    const next = { ...this.settings };
    const changes = [];
    for (const [key, [min, max, integer]] of Object.entries(allowed)) {
      if (input[key] === undefined || input[key] === null) continue;
      const value = Number(input[key]);
      if (!Number.isFinite(value)) throw new Error(`${key} 必须是数字`);
      const clamped = Math.min(max, Math.max(min, integer ? Math.round(value) : value));
      next[key] = clamped;
      changes.push(`${key}=${clamped}`);
    }
    if (!changes.length) throw new Error('没有提供可修改的设置（maxStorageBytes / slowdown / promptMaxChars）');
    this.settings = next;
    this.config = { ...this.baseConfig, ...next };
    writeTextFile(this.settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    this.invalidate();
    return `已更新记忆库设置：${changes.join('，')}\n设置文件：${this.settingsFile}`;
  }

  // ---------------------------------------------------------------- mounts

  loadMounts() {
    let raw = [];
    try {
      raw = JSON.parse(readTextFile(this.mountsFile) || '[]');
    } catch {
      raw = [];
    }
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((mount) => mount && typeof mount.source === 'string' && mount.source.trim())
      .map((mount) => {
        const source = path.resolve(mount.source);
        return {
          id: String(mount.id || `m-${Date.now().toString(36)}`),
          label: oneLine(mount.label || path.basename(path.dirname(source)) || 'external').slice(0, 40),
          source,
          tags: Array.isArray(mount.tags) ? mount.tags.map((tag) => oneLine(tag).slice(0, 24)).filter(Boolean).slice(0, 8) : [],
          minImportance: clampInt(mount.minImportance, 1, 5, 1),
          limit: clampInt(mount.limit, 1, 100, 40),
          addedAt: mount.addedAt || new Date().toISOString(),
        };
      });
  }

  saveMounts() {
    writeTextFile(this.mountsFile, `${JSON.stringify(this.mounts, null, 2)}\n`);
    this._prompt = null;
  }

  link(input) {
    let source = path.resolve(String(input.source || '').trim());
    if (!exists(source)) throw new Error(`源路径不存在：${source}`);
    try {
      if (!fs.statSync(source).isDirectory()) throw new Error(`源路径不是目录：${source}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('源路径')) throw error;
      throw new Error(`无法访问源路径：${source}`);
    }
    if (path.basename(source).toLowerCase() !== '.dsh-memory') source = path.join(source, '.dsh-memory');
    if (!exists(source)) throw new Error(`没有找到记忆库：${source}（请确认源工作区已有 .dsh-memory）`);
    if (path.resolve(source) === path.resolve(this.dir)) throw new Error('不能接取当前工作区自己的记忆库');

    const label = oneLine(input.label || path.basename(path.dirname(source))).slice(0, 40) || 'external';
    const tags = Array.isArray(input.tags) ? input.tags.map((tag) => oneLine(tag).slice(0, 24)).filter(Boolean).slice(0, 8) : [];
    const minImportance = clampInt(input.minImportance, 1, 5, 1);
    const limit = clampInt(input.limit, 1, 100, 40);
    const existing = this.mounts.find((mount) => path.resolve(mount.source) === path.resolve(source));
    if (existing) {
      Object.assign(existing, { label, tags, minImportance, limit });
      this.saveMounts();
      this.rebuildIndex();
      return { mount: existing, updated: true };
    }
    const mount = {
      id: `m-${Date.now().toString(36)}`,
      label,
      source: path.resolve(source),
      tags,
      minImportance,
      limit,
      addedAt: new Date().toISOString(),
    };
    this.mounts.push(mount);
    this.saveMounts();
    this.rebuildIndex();
    return { mount, updated: false };
  }

  unlink(key) {
    const value = String(key || '').trim();
    if (!value) return null;
    const index = this.mounts.findIndex((mount) => {
      if (mount.id === value) return true;
      if (path.resolve(mount.source) === path.resolve(value)) return true;
      return path.resolve(mount.source) === path.resolve(value, '.dsh-memory');
    });
    if (index < 0) return null;
    const [removed] = this.mounts.splice(index, 1);
    this.saveMounts();
    this.rebuildIndex();
    return removed;
  }

  listMounts() {
    if (!this.mounts.length) return '当前没有接取任何外部记忆库。';
    const lines = [`外部接取：${this.mounts.length} 个（只读）`];
    for (const mount of this.mounts) {
      const filters = [
        mount.tags.length ? `标签 ${mount.tags.join('/')}` : '标签不限',
        `最低重要度 ${mount.minImportance}`,
        `最多 ${mount.limit} 条`,
      ];
      lines.push(`- ${mount.label} [${mount.id}] → ${mount.source}\n  ${filters.join('；')}`);
    }
    return lines.join('\n');
  }

  linkedEntries() {
    const result = [];
    for (const mount of this.mounts) {
      const library = path.join(mount.source, 'library');
      if (!exists(library)) continue;
      const seen = new Set();
      const batch = [];
      for (const file of walkFiles(library)) {
        if (!file.endsWith('.md') || path.basename(file).includes('.tmp-')) continue;
        const entry = parseEntry(readTextFile(file), file);
        if (!entry || entry.level >= 2) continue;
        if (entry.importance < mount.minImportance) continue;
        if (mount.tags.length && !entry.tags.some((tag) => mount.tags.includes(tag))) continue;
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        batch.push({
          ...entry,
          mountId: mount.id,
          mountLabel: mount.label,
          linkKey: `${mount.id}:${entry.id}`,
          linked: true,
        });
      }
      batch.sort((a, b) => b.importance - a.importance || String(b.updated).localeCompare(String(a.updated)));
      result.push(...batch.slice(0, mount.limit));
    }
    return result;
  }

  entryFile(id, level) {
    return path.join(level >= 2 ? this.archiveDir : this.libraryDir, `${id}.md`);
  }

  ensureLayout() {
    fs.mkdirSync(this.journalDir, { recursive: true });
    fs.mkdirSync(this.libraryDir, { recursive: true });
    fs.mkdirSync(this.archiveDir, { recursive: true });
  }

  // ---------------------------------------------------------------- state

  loadState() {
    let state = {};
    try {
      state = JSON.parse(readTextFile(path.join(this.dir, STATE_FILE)) || '{}');
    } catch {
      state = {};
    }
    return {
      lastConsolidatedAt: Number(state.lastConsolidatedAt) || 0,
      lastJournalAt: Number(state.lastJournalAt) || 0,
      lastCapacityAt: Number(state.lastCapacityAt) || 0,
      lastAttemptAt: Number(state.lastAttemptAt) || 0,
    };
  }

  saveState() {
    writeTextFile(path.join(this.dir, STATE_FILE), `${JSON.stringify(this.state, null, 2)}\n`);
  }

  // ---------------------------------------------------------------- entries

  entries() {
    if (this._entries && Date.now() - this._entriesAt < 3000) return this._entries;
    const map = new Map();
    for (const file of walkFiles(this.libraryDir)) {
      if (!file.endsWith('.md') || path.basename(file).includes('.tmp-')) continue;
      const entry = parseEntry(readTextFile(file), file);
      if (entry) map.set(entry.id, entry);
    }
    for (const file of walkFiles(this.archiveDir)) {
      if (!file.endsWith('.md') || path.basename(file).includes('.tmp-')) continue;
      const entry = parseEntry(readTextFile(file), file);
      if (entry && !map.has(entry.id)) map.set(entry.id, entry);
    }
    this._entries = map;
    this._entriesAt = Date.now();
    return map;
  }

  invalidate() {
    this._entries = null;
    this._usage = null;
    this._prompt = null;
  }

  libraryEntries() {
    return [...this.entries().values()].filter((entry) => entry.level < 2);
  }

  resolveId(input) {
    const raw = String(input || '').trim().replace(/^library[\\/]/, '').replace(/^archive[\\/]/, '').replace(/\.md$/i, '');
    if (!raw) return undefined;
    const all = this.entries();
    if (all.has(raw)) return all.get(raw);
    const hits = [...all.values()].filter((entry) => entry.id.startsWith(raw));
    return hits.length === 1 ? hits[0] : undefined;
  }

  saveEntry(entry) {
    this.ensureLayout();
    entry.title = oneLine(entry.title).slice(0, 140);
    entry.summary = oneLine(entry.summary).slice(0, 320);
    const target = this.entryFile(entry.id, entry.level);
    const other = this.entryFile(entry.id, entry.level >= 2 ? 0 : 2);
    writeTextFile(target, serializeEntry(entry));
    if (exists(other)) removeFile(other);
    this.invalidate();
    return entry;
  }

  deleteEntry(entry) {
    removeFile(this.entryFile(entry.id, 0));
    removeFile(this.entryFile(entry.id, 2));
    this.invalidate();
  }

  write(input, options = {}) {
    const title = oneLine(input.title).slice(0, 140);
    if (!title) throw new Error('title 不能为空');
    const content = normalizeWhitespace(input.content || '');
    const summary = oneLine(input.summary || (content ? content.slice(0, 90) : ''));
    if (!summary) throw new Error('summary 不能为空');
    const importance = clampInt(input.importance, 1, 5, 3);
    const tags = Array.isArray(input.tags)
      ? input.tags.map((tag) => oneLine(tag).slice(0, 24)).filter(Boolean).slice(0, 8)
      : [];
    const now = new Date().toISOString();

    const existing = [...this.entries().values()].find((entry) => normTitle(entry.title) === normTitle(title));
    if (existing) {
      existing.title = title;
      existing.summary = summary;
      if (content) existing.content = content;
      existing.importance = importance;
      if (tags.length) existing.tags = [...new Set([...existing.tags, ...tags])].slice(0, 8);
      existing.level = content ? 0 : Math.min(existing.level, 1);
      existing.updated = now;
      if (options.review !== false) {
        existing.reviewed = now;
        existing.reviews = Math.min(50, existing.reviews + 1);
      }
      this.saveEntry(existing);
      this.rebuildIndex();
      return { entry: existing, created: false };
    }

    const entry = {
      id: newId(),
      title,
      summary,
      importance,
      level: content ? 0 : 1,
      tags,
      created: now,
      updated: now,
      reviewed: now,
      reviews: 0,
      pinned: false,
      content,
    };
    this.saveEntry(entry);
    this.rebuildIndex();
    return { entry, created: true };
  }

  updateEntry(id, patch, options = {}) {
    const entry = this.resolveId(id);
    if (!entry) throw new Error(`未找到记忆条目：${id}`);
    const now = new Date().toISOString();
    if (patch.title !== undefined) entry.title = oneLine(patch.title).slice(0, 140);
    if (patch.summary !== undefined) entry.summary = oneLine(patch.summary).slice(0, 320);
    if (patch.content !== undefined) {
      entry.content = normalizeWhitespace(patch.content);
      entry.level = 0;
    }
    if (patch.importance !== undefined) entry.importance = clampInt(patch.importance, 1, 5, entry.importance);
    if (Array.isArray(patch.tags)) {
      entry.tags = patch.tags.map((tag) => oneLine(tag).slice(0, 24)).filter(Boolean).slice(0, 8);
    }
    entry.updated = now;
    if (options.review !== false) {
      entry.reviewed = now;
      entry.reviews = Math.min(50, entry.reviews + 1);
    }
    this.saveEntry(entry);
    this.rebuildIndex();
    return entry;
  }

  reviewEntry(entry) {
    entry.reviewed = new Date().toISOString();
    entry.reviews = Math.min(50, entry.reviews + 1);
    this.saveEntry(entry);
  }

  // ---------------------------------------------------------------- journal

  appendJournal({ time, sessionId, user, assistant }) {
    this.ensureLayout();
    const date = localDate(time);
    const file = path.join(this.journalDir, `${date}.md`);
    const fresh = !exists(file);
    const block = [
      '',
      `### ${localTime(time)} · ${String(sessionId).slice(-6)}`,
      `<!-- ts:${time} -->`,
      '**我**：',
      user || '（无）',
      '',
      '**回复要点**：',
      assistant || '（无）',
      '',
    ].join('\n');
    if (fresh) appendTextFile(file, `# ${date}\n${block}\n`);
    else appendTextFile(file, `${block}\n`);
    this.state.lastJournalAt = Math.max(this.state.lastJournalAt || 0, time);
    this.saveState();
  }

  journalFiles() {
    let names = [];
    try {
      names = fs.readdirSync(this.journalDir);
    } catch {
      return [];
    }
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
      .map((name) => ({ date: name.slice(0, 10), file: path.join(this.journalDir, name) }));
  }

  collectJournalBlocks(sinceMs) {
    const blocks = [];
    const since = Number(sinceMs) || 0;
    const sinceDate = since ? localDate(since) : '0000-01-01';
    for (const { date, file } of this.journalFiles()) {
      if (date < sinceDate) continue;
      const raw = readTextFile(file);
      if (!raw) continue;
      const chunks = raw.split(/\n(?=### )/);
      for (const chunk of chunks) {
        if (!chunk.startsWith('### ')) continue;
        const tsMatch = chunk.match(/<!--\s*ts:(\d+)\s*-->/);
        const ts = tsMatch ? Number(tsMatch[1]) : Date.parse(`${date}T00:00:00`);
        if (!Number.isFinite(ts) || ts <= since) continue;
        const head = chunk.slice(4, chunk.indexOf('\n')).trim();
        const body = chunk
          .split('\n')
          .filter((line) => !line.includes('<!-- ts:'))
          .slice(1)
          .join('\n')
          .trim();
        const match = body.match(/^\*\*我\*\*：\n([\s\S]*?)\n\n\*\*回复要点\*\*：\n([\s\S]*)$/);
        blocks.push({
          date,
          time: head.split('·')[0].trim(),
          session: head.split('·')[1] ? head.split('·')[1].trim() : '',
          ts,
          user: match ? match[1].trim() : body,
          assistant: match ? match[2].trim() : '',
        });
      }
    }
    return blocks;
  }

  hasJournalSince(sinceMs) {
    return this.collectJournalBlocks(sinceMs).length > 0;
  }

  // ---------------------------------------------------------------- prompt

  promptText() {
    if (this._prompt && Date.now() - this._promptAt < 2000) return this._prompt;
    const rules = readTextFile(this.rulesFile).trim();
    const library = this.libraryEntries();
    const linked = this.linkedEntries();
    if (!rules && !library.length && !linked.length) {
      this._prompt = '';
      this._promptAt = Date.now();
      return '';
    }

    const maxChars = Math.max(1200, Number(this.config.promptMaxChars) || 7000);
    const indexBudget = Math.floor(maxChars * 0.62);
    const localText = this.renderIndexBody(library);
    const linkedText = linked.length ? this.renderLinkedBody(linked) : '';
    const localBudget = linkedText ? Math.floor(indexBudget * 0.62) : indexBudget;

    const parts = [
      '## 工作区记忆库（自动加载）',
      '本工作区拥有持久记忆（.dsh-memory/）。下面是你长期积累的上下文，规则部分优先级最高。',
      '',
      '### 规则（最高优先级，必须遵守）',
      rules ? clip(rules, Math.floor(maxChars * 0.55)) : '（暂无自定义规则）',
      '',
      '### 记忆索引（标题 + 一句话简介）',
      localText ? clip(localText, localBudget) : '（暂无本地记忆条目）',
    ];
    if (linkedText) {
      parts.push('', `### 外部接取（只读，共 ${linked.length} 条）`, clip(linkedText, Math.max(400, indexBudget - localBudget)));
    }
    parts.push(
      '',
      '需要细节时用 memory_read(id) 或 memory_search(query) 按需读取，不要一次拉取大量条目；外链条目的 id 形如 m-xxx:mem-yyy，只读。',
      '遇到值得长期记住的偏好、决定或事实，用 memory_write 保存；修改规则必须用 memory_propose_rule 并等待用户确认。',
    );
    this._prompt = parts.join('\n');
    this._promptAt = Date.now();
    return this._prompt;
  }

  // ---------------------------------------------------------------- index

  renderIndexBody(entries) {
    const groups = [
      [5, '核心（永久保留）'],
      [4, '重要'],
      [3, '常规'],
      [2, '次要'],
      [1, '低价值'],
    ];
    const lines = [];
    for (const [importance, label] of groups) {
      const group = entries
        .filter((entry) => entry.importance === importance)
        .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
      if (!group.length) continue;
      lines.push(`#### ${stars(importance)} ${label}`);
      for (const entry of group) {
        lines.push(`- ${entry.title} — ${entry.summary || '（无简介）'} \`${entry.id}\``);
      }
    }
    return lines.join('\n');
  }

  renderLinkedBody(entries) {
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.mountId)) groups.set(entry.mountId, { label: entry.mountLabel, items: [] });
      groups.get(entry.mountId).items.push(entry);
    }
    const lines = [];
    for (const { label, items } of groups.values()) {
      lines.push(`#### ↔ ${label}（只读外链）`);
      for (const entry of items) {
        lines.push(`- ${entry.title} — ${entry.summary || '（无简介）'} \`${entry.linkKey}\``);
      }
    }
    return lines.join('\n');
  }

  rebuildIndex() {
    const entries = this.libraryEntries();
    const linked = this.linkedEntries();
    const lines = [
      '# 记忆索引',
      '',
      `> 更新：${new Date().toLocaleString('zh-CN', { hour12: false })} · 本地 ${entries.length} 条 · 外链 ${linked.length} 条`,
      '',
      this.renderIndexBody(entries) || '（暂无本地记忆条目）',
      '',
    ];
    if (linked.length) lines.push('## 外部接取（只读）', '', this.renderLinkedBody(linked), '');
    writeTextFile(this.indexFile, lines.join('\n'));
    this._prompt = null;
  }

  readRules() {
    return readTextFile(this.rulesFile);
  }

  appendRule(section, rule, rationale) {
    const label = section === 'special' ? '特殊规则' : '基础规则';
    const text = oneLine(rule).slice(0, 500);
    if (!text) throw new Error('规则内容不能为空');
    const current = this.readRules();
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    const block = [
      '',
      `<!-- memory-rule:${Date.now()} -->`,
      `- [${label}] ${text}`,
      rationale ? `  <!-- 理由：${oneLine(rationale).slice(0, 240)} -->` : '',
      `  <!-- 确认时间：${stamp} -->`,
      '',
    ].join('\n');

    let next;
    if (!current.trim()) {
      next = [
        '# 记忆库规则',
        '',
        '> 本文件保存你确认过的长期规则，优先级高于普通记忆。AI 只能提议，确认后才会写入。',
        '',
        '## 基础规则',
        block,
        '## 特殊规则',
        '',
      ].join('\n');
    } else {
      const heading = section === 'special' ? '## 特殊规则' : '## 基础规则';
      const index = current.indexOf(heading);
      if (index < 0) {
        next = `${current.replace(/\s*$/, '')}\n\n${heading}\n${block}`;
      } else {
        const insertAt = current.indexOf('\n## ', index + heading.length);
        if (insertAt < 0) next = `${current.replace(/\s*$/, '')}\n${block}`;
        else next = `${current.slice(0, insertAt)}\n${block}${current.slice(insertAt)}`;
      }
    }
    writeTextFile(this.rulesFile, next);
    this._prompt = null;
    return text;
  }

  // ---------------------------------------------------------------- decay

  importanceFactor(importance) {
    const factors = this.config.importanceFactors || {};
    const value = Number(factors[importance]);
    return Number.isFinite(value) ? value : 1;
  }

  dueAt(entry) {
    if (entry.pinned || entry.importance >= 5) return Number.POSITIVE_INFINITY;
    if (entry.level >= 2) return Number.POSITIVE_INFINITY;
    const base = entry.level === 0 ? Number(this.config.baseFullDays) || 4 : Number(this.config.baseSummaryDays) || 12;
    const slowdown = Math.max(1, Number(this.config.slowdown) || 2.5);
    const factor = this.importanceFactor(entry.importance);
    const interval = base * slowdown * factor * Math.pow(2, Math.min(entry.reviews, 8));
    const anchor = Date.parse(entry.reviewed || entry.updated || entry.created);
    if (!Number.isFinite(anchor)) return Number.POSITIVE_INFINITY;
    return anchor + interval * DAY;
  }

  dueEntries(now = Date.now()) {
    return this.libraryEntries().filter((entry) => this.dueAt(entry) <= now);
  }

  compressEntry(id, to, summary) {
    const entry = this.resolveId(id);
    if (!entry) return null;
    if (entry.pinned || entry.importance >= 5) return null;
    const target = clampInt(to, 1, 2, Math.min(2, entry.level + 1));
    if (target <= entry.level && target !== 1) return null;
    if (target === 1) {
      entry.level = 1;
      entry.content = '';
      if (summary) entry.summary = oneLine(summary).slice(0, 320);
    } else {
      entry.level = 2;
      entry.content = '';
      entry.summary = '';
    }
    entry.updated = new Date().toISOString();
    this.saveEntry(entry);
    return entry;
  }

  purgeExpiredArchive(now = Date.now()) {
    const days = Math.max(30, Number(this.config.archiveRetentionDays) || 180);
    let removed = 0;
    for (const entry of this.entries().values()) {
      if (entry.level < 2 || entry.importance > 1 || entry.pinned) continue;
      const updated = Date.parse(entry.updated);
      if (Number.isFinite(updated) && now - updated > days * DAY) {
        this.deleteEntry(entry);
        removed += 1;
      }
    }
    return removed;
  }

  // ---------------------------------------------------------------- capacity

  usage(force = false) {
    if (!force && this._usage !== null && Date.now() - this._usageAt < 60000) return this._usage;
    const bytes = dirSize(this.dir);
    this._usage = bytes;
    this._usageAt = Date.now();
    return bytes;
  }

  maxBytes() {
    return Math.max(64 * 1024 * 1024, Number(this.config.maxStorageBytes) || 5 * 1024 * 1024 * 1024);
  }

  enforceCapacity() {
    const max = this.maxBytes();
    let used = this.usage(true);
    if (used <= max) return null;
    const report = { before: used, after: used, max, actions: [], overCapacity: false };
    let guard = 0;

    const trimJournals = (keepDays) => {
      const cutoff = localDate(Date.now() - keepDays * DAY);
      let removed = 0;
      for (const { date, file } of this.journalFiles()) {
        if (date >= cutoff) continue;
        removeFile(file);
        removed += 1;
      }
      if (removed) report.actions.push(`删除 ${removed} 个过期日志（保留 ${keepDays} 天）`);
      used = this.usage(true);
    };

    const compressPass = (predicate, to, label) => {
      const candidates = this.libraryEntries()
        .filter(predicate)
        .sort((a, b) => a.importance - b.importance || String(a.updated).localeCompare(String(b.updated)));
      let count = 0;
      for (const entry of candidates) {
        if (used <= max || guard++ > 400) break;
        if (!this.compressEntry(entry.id, to)) continue;
        count += 1;
        used = Math.max(0, used - (Buffer.byteLength(entry.content || '') + Buffer.byteLength(entry.summary || '') + 80));
      }
      if (count) report.actions.push(`${label} ${count} 条`);
      used = this.usage(true);
    };

    compressPass((entry) => entry.level === 0 && entry.importance <= 3, 1, '压缩为简介');
    if (used > max) compressPass((entry) => entry.level === 1 && entry.importance <= 3, 2, '归档为标题');
    if (used > max) trimJournals(Number(this.config.journalRetentionDays) || 45);
    if (used > max) compressPass((entry) => entry.level === 0 && entry.importance === 4, 1, '压缩重要条目');
    if (used > max) {
      let removed = 0;
      const candidates = [...this.entries().values()]
        .filter((entry) => entry.level >= 2 && entry.importance <= 2 && !entry.pinned)
        .sort((a, b) => a.importance - b.importance || String(a.updated).localeCompare(String(b.updated)));
      for (const entry of candidates) {
        if (used <= max || guard++ > 600) break;
        this.deleteEntry(entry);
        removed += 1;
        used = Math.max(0, used - 300);
      }
      if (removed) report.actions.push(`删除低价值归档 ${removed} 条`);
      used = this.usage(true);
    }
    if (used > max) trimJournals(7);

    report.after = this.usage(true);
    report.overCapacity = report.after > max;
    this.state.lastCapacityAt = Date.now();
    this.saveState();
    this.rebuildIndex();
    return report;
  }

  // ---------------------------------------------------------------- tools

  status() {
    const entries = [...this.entries().values()];
    const full = entries.filter((entry) => entry.level === 0).length;
    const short = entries.filter((entry) => entry.level === 1).length;
    const archived = entries.filter((entry) => entry.level === 2).length;
    const used = this.usage(true);
    const max = this.maxBytes();
    const journalDays = this.journalFiles().length;
    const rules = this.readRules().length;
    const pct = max > 0 ? ((used / max) * 100).toFixed(2) : '0';
    const last = this.state.lastConsolidatedAt
      ? new Date(this.state.lastConsolidatedAt).toLocaleString('zh-CN', { hour12: false })
      : '从未';
    return [
      `记忆库：${this.dir}`,
      `容量：${formatBytes(used)} / ${formatBytes(max)}（${pct}%）`,
      `条目：${entries.length} 条（全文 ${full} / 简介 ${short} / 归档 ${archived}）`,
      `日志：${journalDays} 天；规则：${rules} 字符`,
      `外链：${this.mounts.length} 个${this.mounts.length ? `（${this.mounts.map((mount) => mount.label).join('、')}）` : ''}`,
      `上次整理：${last}`,
      `遗忘曲线：${this.config.slowdown}× 放缓；全文→简介 ${this.config.baseFullDays} 天起、简介→归档 ${this.config.baseSummaryDays} 天起（按重要度与复习次数倍增）`,
    ].join('\n');
  }

  search(query, limit = 8) {
    const terms = String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    const max = clampInt(limit, 1, 20, 8);
    const pool = [
      ...[...this.entries().values()].map((entry) => ({ entry, linked: false })),
      ...this.linkedEntries().map((entry) => ({ entry, linked: true })),
    ];
    if (!terms.length) {
      return pool
        .sort((a, b) => b.entry.importance - a.entry.importance || String(b.entry.updated).localeCompare(String(a.entry.updated)))
        .slice(0, max)
        .map(({ entry }) => ({ entry, score: entry.importance }));
    }
    const hits = [];
    for (const { entry } of pool) {
      const title = entry.title.toLowerCase();
      const summary = entry.summary.toLowerCase();
      const tags = entry.tags.join(' ').toLowerCase();
      const content = entry.content.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title === term) score += 100;
        else if (title.includes(term)) score += 20;
        if (tags.includes(term)) score += 10;
        if (summary.includes(term)) score += 6;
        if (content.includes(term)) score += 2;
      }
      if (score > 0) hits.push({ entry, score });
    }
    hits.sort((a, b) => b.score - a.score || b.entry.importance - a.entry.importance || String(b.entry.updated).localeCompare(String(a.entry.updated)));
    return hits.slice(0, max);
  }

  formatEntryView(entry, linked = false) {
    const lines = [
      `# ${entry.title}`,
      linked ? `id: ${entry.linkKey}（外链：${entry.mountLabel}，只读）` : `id: ${entry.id}`,
      `重要度: ${stars(entry.importance)}${entry.pinned ? '（已固定）' : ''}`,
      `层级: ${LEVEL_LABEL[entry.level]}`,
      `标签: ${entry.tags.join('、') || '（无）'}`,
      `摘要: ${entry.summary || '（无）'}`,
      `更新: ${entry.updated}`,
    ];
    if (entry.level === 0) lines.push('', '---', '', entry.content || '（无正文）');
    else if (entry.level === 1) lines.push('', '（正文已按遗忘曲线压缩，仅保留摘要；如需恢复请让用户补充）');
    else lines.push('', '（已归档，仅保留标题）');
    return lines.join('\n');
  }

  read(id) {
    const key = String(id || '').trim();
    const lower = key.toLowerCase();
    if (lower === 'rules' || lower === `${RULES_FILE.toLowerCase()}`) {
      const rules = this.readRules().trim();
      return rules ? `# 规则文件\n\n${rules}` : '（规则文件为空）';
    }
    if (lower === 'index') {
      const index = readTextFile(this.indexFile).trim();
      return index || '（索引尚未生成）';
    }
    const journalMatch = key.match(/^(?:journal[:/])?(\d{4}-\d{2}-\d{2})$/);
    if (journalMatch && (key.startsWith('journal') || lower === journalMatch[1])) {
      const date = journalMatch[1];
      const file = path.join(this.journalDir, `${date}.md`);
      const text = readTextFile(file).trim();
      return text || `（${date} 没有日志）`;
    }
    if (key.includes(':')) {
      const linkedEntry = this.linkedEntries().find((entry) => entry.linkKey === key);
      if (linkedEntry) return this.formatEntryView(linkedEntry, true);
    }
    const entry = this.resolveId(key);
    if (!entry) return null;
    if (entry.level < 2) {
      this.reviewEntry(entry);
      this.rebuildIndex();
    }
    return this.formatEntryView(entry, false);
  }

  // ---------------------------------------------------------------- consolidation

  async consolidate({ force = false } = {}) {
    if (this.consolidating) return { skipped: 'busy' };
    if (!force && this.state.lastAttemptAt && Date.now() - this.state.lastAttemptAt < 30 * 60000) {
      return { skipped: 'backoff' };
    }
    this.consolidating = true;
    const startedAt = Date.now();
    try {
      const since = Math.max(this.state.lastConsolidatedAt || 0, startedAt - 7 * DAY);
      const journal = this.collectJournalBlocks(since).slice(-40);
      const due = this.dueEntries(startedAt);
      if (!journal.length && !due.length && !force) return { skipped: 'nothing-to-do' };

      let model = null;
      let modelError = null;
      try {
        model = await runConsolidationModel(this.ctx, this.config, {
          journal,
          library: this.libraryEntries(),
          due,
        });
      } catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
        this.lastError = modelError;
      }

      const applied = this.applyConsolidation(model, due);
      if (!modelError || !journal.length) this.state.lastConsolidatedAt = startedAt;
      this.saveState();
      this.rebuildIndex();
      const capacity = this.enforceCapacity();
      return {
        ok: true,
        ...applied,
        modelError,
        retryPending: Boolean(modelError && journal.length),
        capacity,
        usedBytes: this.usage(true),
      };
    } finally {
      this.state.lastAttemptAt = Date.now();
      this.saveState();
      this.consolidating = false;
    }
  }

  applyConsolidation(result, due) {
    const report = { created: 0, updated: 0, compressed: 0, archived: 0, errors: [] };
    const touched = new Set();
    const entries = result && Array.isArray(result.entries) ? result.entries.slice(0, 12) : [];
    for (const item of entries) {
      try {
        if (!item || typeof item !== 'object') continue;
        if (item.op === 'update' && item.id) {
          const entry = this.resolveId(item.id);
          if (!entry) continue;
          this.updateEntry(entry.id, {
            title: item.title || entry.title,
            summary: item.summary || entry.summary,
            content: typeof item.content === 'string' && item.content.trim() ? item.content : undefined,
            importance: item.importance,
            tags: Array.isArray(item.tags) ? item.tags : undefined,
          });
          touched.add(entry.id);
          report.updated += 1;
        } else {
          if (!item.title) continue;
          const written = this.write({
            title: item.title,
            summary: item.summary || '',
            content: item.content || '',
            importance: item.importance,
            tags: item.tags,
          });
          touched.add(written.entry.id);
          if (written.created) report.created += 1;
          else report.updated += 1;
        }
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const compressedIds = new Set();
    const compressions = result && Array.isArray(result.compressions) ? result.compressions.slice(0, 12) : [];
    for (const item of compressions) {
      try {
        if (!item || !item.id) continue;
        const entry = this.resolveId(item.id);
        if (!entry) continue;
        if (touched.has(entry.id)) continue;
        const to = clampInt(item.to, 1, 2, 1);
        const compressed = this.compressEntry(entry.id, to, item.summary);
        if (compressed) {
          compressedIds.add(entry.id);
          if (to === 2) report.archived += 1;
          else report.compressed += 1;
        }
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    for (const entry of due) {
      if (touched.has(entry.id) || compressedIds.has(entry.id)) continue;
      const current = this.resolveId(entry.id);
      if (!current || current.level >= 2) continue;
      const to = current.level === 0 ? 1 : 2;
      const compressed = this.compressEntry(current.id, to);
      if (compressed) {
        if (to === 2) report.archived += 1;
        else report.compressed += 1;
      }
    }
    return report;
  }
}
