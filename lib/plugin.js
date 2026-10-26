import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MemoryStore } from './store.js';
import { effectiveStrength } from './catalog.js';
import { clip, exists, extractText, readTextFile, removeFile, replyExcerpt, stars, writeTextFile } from './util.js';

const DAY = 86400000;

const DEFAULTS = {
  maxStorageBytes: 5 * 1024 * 1024 * 1024,
  consolidationsPerDay: 3,
  slowdown: 2.5,
  captureSubagents: false,
  indexMaxChars: 3500,
  promptMaxChars: 4200,
  baseFullDays: 4,
  baseSummaryDays: 12,
  journalRetentionDays: 45,
  archiveRetentionDays: 180,
  maintenanceIntervalMs: 60000,
  sectionOrder: 30,
  llmTimeoutMs: 120000,
  consolidationMaxTokens: 2400,
  provider: '',
  model: '',
  files: { enabled: false, confirmOverMb: 100 },
  importanceFactors: { 1: 0.35, 2: 0.7, 3: 1.3, 4: 4, 5: Number.POSITIVE_INFINITY },
};

function textOutput() {
  return {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: String(value && value.text ? value.text : '') }];
    },
  };
}

function tool(name, description, parameters, execute, extra = {}) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: parameters, required: extra.required || [], additionalProperties: false },
    output: textOutput(),
    execute: async (args, exec) => ({ text: String(await execute(args || {}, exec)) }),
    ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
    ...(extra.isConcurrencySafe ? { isConcurrencySafe: () => true } : {}),
  };
}

/** Last user-authored text in this session, used to seed the first journal block after mid-turn opt-in. */
function lastUserText(session) {
  try {
    const messages = session.deriveMessages();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && message.role === 'user') {
        const text = extractText(message.content);
        if (text) return text;
      }
    }
  } catch {
    /* session may be detaching */
  }
  return '';
}

function sendJson(res, status, value) {
  if (!res || typeof res.writeHead !== 'function') return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** Inline page tokens can be blocked by CSP; a same-origin browser request is equally trustworthy. */
function isSameOrigin(req) {
  if (!req || !req.headers) return false;
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  const host = req.headers.host;
  if (!host) return false;
  for (const header of ['origin', 'referer']) {
    const value = req.headers[header];
    if (!value) continue;
    try {
      if (new URL(value).host === host) return true;
    } catch {
      /* ignore malformed header */
    }
  }
  return false;
}

/** The GUI binds loopback; a local page request may omit Origin/Referer under strict policies. */
function isLoopbackRequest(req) {
  if (!req) return false;
  const hostValue = String((req.headers && req.headers.host) || '');
  let hostname = hostValue;
  try {
    hostname = new URL(`http://${hostValue}`).hostname;
  } catch {
    /* keep raw value */
  }
  hostname = hostname.replace(/^\[|\]$/g, '');
  const localHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  const remote = String((req.socket && req.socket.remoteAddress) || '');
  const localRemote = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return localHost && localRemote;
}

export class MemoryPlugin {
  constructor(ctx, rawConfig) {
    this.ctx = ctx;
    const provided = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    this.config = { ...DEFAULTS, ...provided };
    this.config.importanceFactors = { ...DEFAULTS.importanceFactors, ...(provided.importanceFactors || {}) };
    this.config.files = { ...DEFAULTS.files, ...(provided.files || {}) };
    this.stores = new Map();
    this.turnBuffers = new Map();
    this.agentDisposers = new Map();
    this.lastCapacityCheck = new Map();
    this.ticking = false;
  }

  start() {
    this.registerTools();
    this.registerPrompt();
    this.registerCapture();
    this.registerGuard();
    this.registerApi();
    this.scanWorkspaces();
    this.startMaintenance();
    this.ctx.effect(() => () => {
      for (const store of this.stores.values()) store.close();
    });
  }

  // ---------------------------------------------------------------- resolution

  resolveDirForSession(session) {
    if (!session) return undefined;
    let cwd;
    try {
      cwd = this.ctx.workingDirectory.get(session);
    } catch {
      cwd = undefined;
    }
    if (!cwd && session.header && typeof session.header.cwd === 'string') cwd = session.header.cwd;
    if (!cwd || typeof cwd !== 'string') return undefined;
    return path.join(cwd, '.dsh-memory');
  }

  resolveDirForAgent(agentId) {
    const session = this.ctx.sessions.get(agentId);
    return this.resolveDirForSession(session);
  }

  storeForDir(dir) {
    const resolved = this.resolveStoreDir(dir);
    const key = path.resolve(resolved);
    let store = this.stores.get(key);
    if (!store) {
      store = new MemoryStore(key, this.config, this.ctx);
      this.stores.set(key, store);
    }
    return store;
  }

  /** `<workspace>/.dsh-memory/mode.json` selects shared / isolated (default). */
  readMode(dir) {
    try {
      const raw = JSON.parse(readTextFile(path.join(dir, 'mode.json')) || '{}');
      if (raw.mode === 'shared' && typeof raw.source === 'string' && raw.source.trim()) {
        return { mode: 'shared', source: path.resolve(raw.source) };
      }
    } catch {
      /* treat as isolated */
    }
    return { mode: 'isolated' };
  }

  resolveStoreDir(dir) {
    const target = path.resolve(dir);
    const mode = this.readMode(target);
    if (mode.mode === 'shared' && exists(mode.source)) return mode.source;
    return target;
  }

  sourceDirOf(input) {
    let source = path.resolve(String(input || '').trim());
    if (!exists(source)) throw new Error(`源路径不存在：${source}`);
    if (path.basename(source).toLowerCase() !== '.dsh-memory') source = path.join(source, '.dsh-memory');
    if (!exists(source)) throw new Error(`没有找到记忆库：${source}（请确认源工作区已有 .dsh-memory）`);
    return source;
  }

  targetDirFor(agent) {
    const dir = agent ? this.resolveDirForAgent(agent.id) : undefined;
    if (!dir) throw new Error('当前会话没有工作目录，无法定位 .dsh-memory 记忆库');
    return dir;
  }

  modeDescription(targetDir, store) {
    const mode = this.readMode(targetDir);
    if (mode.mode === 'shared') {
      return [
        '模式：共用记忆库',
        `读写源：${mode.source}`,
        exists(mode.source) ? '状态：源可用（条目、日志、规则、整理全部共用）' : '⚠ 状态：源不可用，已回退到本地库',
        `本地指针：${path.join(targetDir, 'mode.json')}`,
      ].join('\n');
    }
    return [
      `模式：${store.mounts.length ? '只读接取 + 本地新库' : '完全独立'}`,
      `本地库：${store.dir}`,
      `外链：${store.mounts.length} 个${store.mounts.length ? `（${store.mounts.map((mount) => mount.label).join('、')}）` : ''}`,
    ].join('\n');
  }

  storeForAgent(agent) {
    return this.storeForDir(this.targetDirFor(agent));
  }

  requireStoreForAgent(agent) {
    const store = this.storeForAgent(agent);
    if (!agent || !store.isSessionEnabled(agent.id)) {
      throw new Error('本会话尚未开启记忆。请由用户确认后开启：memory_session action=on');
    }
    return store;
  }

  // ---------------------------------------------------------------- prompt

  registerPrompt() {
    this.ctx.on('agent/created', ({ agent }) => {
      if (!agent || !agent.ctx) return;
      try {
        const dispose = this.ctx.effect(() => {
          const off = agent.ctx.systemPrompt.section({
            name: 'workspace-memory',
            order: Number(this.config.sectionOrder) || 30,
            interpolate: false,
            text: () => this.promptForAgent(agent.id),
          });
          return () => {
            try {
              off();
            } catch {
              /* agent context may already be gone */
            }
          };
        });
        this.agentDisposers.set(agent.id, dispose);
      } catch (error) {
        console.error('[memory-library] prompt registration failed', error);
      }
    });

    this.ctx.on('agent/disposed', ({ agent }) => {
      const dispose = this.agentDisposers.get(agent.id);
      if (!dispose) return;
      this.agentDisposers.delete(agent.id);
      try {
        dispose();
      } catch {
        /* already disposed */
      }
    });
  }

  promptForAgent(agentId) {
    const dir = this.resolveDirForAgent(agentId);
    if (!dir) return '';
    try {
      const store = this.storeForDir(dir);
      if (!store.isSessionEnabled(agentId)) return '';
      const session = this.ctx.sessions.get(agentId);
      const cue = session ? clip(lastUserText(session), 500) : '';
      return store.promptText(cue);
    } catch (error) {
      console.error('[memory-library] prompt render failed', error);
      return '';
    }
  }

  // ---------------------------------------------------------------- capture

  registerCapture() {
    this.ctx.on('session/event', (session, event) => {
      try {
        this.onSessionEvent(session, event);
      } catch (error) {
        console.error('[memory-library] capture failed', error);
      }
    });
  }

  onSessionEvent(session, event) {
    if (!session || !event) return;
    if (event.type !== 'turn/start' && event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'turn/end') return;
    const header = session.header || {};
    if (header.origin === 'subagent' && !this.config.captureSubagents) return;
    const id = session.id;
    const dir = this.resolveDirForSession(session);
    if (!dir) return;
    const store = this.storeForDir(dir);
    if (!store.isSessionEnabled(id)) return;

    if (event.type === 'turn/start') {
      this.turnBuffers.set(id, { user: [], assistant: [], files: [] });
      return;
    }

    if (event.type === 'user/message') {
      const content = event.data && event.data.content;
      const text = extractText(content);
      const buffer = this.turnBuffers.get(id) || { user: [], assistant: [], files: [] };
      if (text) buffer.user.push(text);
      if (Array.isArray(content)) {
        for (const fileId of this.captureAttachments(session, content, store)) {
          if (!buffer.files.includes(fileId)) buffer.files.push(fileId);
        }
      }
      this.turnBuffers.set(id, buffer);
      return;
    }

    if (event.type === 'assistant/message') {
      if (event.data && event.data.interrupted) return;
      const message = event.data && event.data.message;
      const text = extractText(message && message.content);
      if (!text) return;
      const buffer = this.turnBuffers.get(id) || { user: [], assistant: [], files: [] };
      buffer.assistant.push(text);
      this.turnBuffers.set(id, buffer);
      return;
    }

    if (event.type !== 'turn/end') return;
    const buffer = this.turnBuffers.get(id);
    this.turnBuffers.delete(id);
    if (!buffer) return;
    const user = clip(buffer.user.join('\n\n').trim(), 5000);
    const assistant = replyExcerpt(buffer.assistant.join('\n\n'), 900);
    if (!user && !assistant) return;
    store.appendJournal({
      time: event.time || Date.now(),
      sessionId: id,
      user,
      assistant,
      files: buffer.files || [],
    });
  }

  captureAttachments(session, content, store) {
    const ids = [];
    if (!store.files?.settings?.enabled) return ids;
    const attachments = this.ctx.get('attachments');
    if (!attachments) return ids;
    for (const block of content) {
      if (!block || !block.attachment) continue;
      const ref = block.attachment;
      let name = '';
      let source = '';
      try {
        if (block.type === 'image') {
          const mediaType = ref.mediaType || ref.mimeType;
          const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : mediaType === 'image/gif' ? 'gif' : 'jpg';
          name = ref.name || `image-${ref.attachmentId}.${ext}`;
          source = attachments.imageHostPath(ref) || '';
        } else if (block.type === 'file') {
          name = ref.name || `file-${ref.attachmentId}`;
          source = attachments.fileHostPath(ref) || '';
        }
      } catch {
        continue;
      }
      if (!source || !exists(source)) continue;
      try {
        const file = store.saveFile(source, { name, sessionId: session.id });
        if (file?.id) ids.push(file.id);
      } catch (error) {
        if (error && error.code === 'NEEDS_CONFIRMATION') {
          store.addPendingFile({ name, bytes: error.bytes, path: source, sessionId: session.id });
        }
      }
    }
    return ids;
  }

  // ---------------------------------------------------------------- guard

  registerGuard() {
    this.ctx.effect(() =>
      this.ctx.tools.guard((exec) => {
        if (!exec || (exec.name !== 'write' && exec.name !== 'edit')) return undefined;
        const args = exec.arguments || {};
        const candidate = args.file_path || args.path || args.target;
        if (typeof candidate !== 'string' || !candidate) return undefined;
        const normalized = candidate.replace(/\\/g, '/').toLowerCase();
        if (!/(^|\/)\.dsh-memory\//.test(normalized)) return undefined;
        return '记忆库文件由插件维护，不能直接用 write/edit 修改：规则请用 memory_propose_rule（需用户确认），条目请用 memory_write / memory_read。';
      }),
    );
  }

  // ---------------------------------------------------------------- UI API

  registerApi() {
    try {
      if (typeof this.ctx.inject !== 'function') return;
      this.ctx.inject(['webServer'], (ctx) => {
        const server = ctx.webServer;
        if (!server || typeof server.register !== 'function') return;
        const token = randomBytes(16).toString('hex');
        this.apiToken = token;
        ctx.effect(() =>
          server.tapIndex((html) => {
            const script = `<script>window.__DSH_MEMORY_TOKEN__=${JSON.stringify(token)};</script>`;
            return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`;
          }),
        );
        ctx.effect(() =>
          server.register({
            kind: 'prefix',
            path: '/dsh-memory-api',
            handler: (req, res) => {
              void this.handleApi(req, res, token);
            },
          }),
        );
      });
    } catch (error) {
      console.error('[memory-library] ui api registration failed', error);
    }
  }

  async handleApi(req, res, token) {
    try {
      const hasToken = req && req.headers && req.headers['x-dsh-memory-token'] === token;
      if (!req || (!hasToken && !isSameOrigin(req) && !isLoopbackRequest(req))) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/dsh-memory-api/session') {
        const sessionId = String(url.searchParams.get('id') || '');
        const session = this.ctx.sessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, { error: 'session-not-live' });
          return;
        }
        const dir = this.resolveDirForSession(session);
        if (!dir) {
          sendJson(res, 409, { error: 'no-workspace' });
          return;
        }
        const store = this.storeForDir(dir);
        sendJson(res, 200, {
          sessionId,
          enabled: store.isSessionEnabled(sessionId),
          mode: this.readMode(dir).mode,
          dir: store.dir,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/dsh-memory-api/session') {
        const body = await readJsonBody(req);
        const sessionId = String(body.sessionId || '');
        const enabled = body.enabled === true;
        const session = this.ctx.sessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, { error: 'session-not-live' });
          return;
        }
        const dir = this.resolveDirForSession(session);
        if (!dir) {
          sendJson(res, 409, { error: 'no-workspace' });
          return;
        }
        const store = this.storeForDir(dir);
        store.setSessionEnabled(sessionId, enabled);
        if (enabled) {
          const last = lastUserText(session);
          this.turnBuffers.set(sessionId, { user: last ? [last] : [], assistant: [] });
        } else {
          this.turnBuffers.delete(sessionId);
        }
        sendJson(res, 200, { sessionId, enabled: store.isSessionEnabled(sessionId), dir: store.dir });
        return;
      }
      sendJson(res, 404, { error: 'not-found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  }

  // ---------------------------------------------------------------- tools

  registerTools() {
    const self = this;

    const definitions = [
      tool(
        'memory_session',
        'Show or change whether memory is enabled for THIS conversation. Memory is OFF by default in every conversation; only conversations the user explicitly enables are captured, injected, or allowed to use other memory tools. Turning it on requires the user to confirm the approval prompt. Never call action=on unless the user explicitly asked to enable memory for this conversation.',
        {
          action: { type: 'string', enum: ['status', 'on', 'off'], description: 'status | on | off.' },
        },
        async (args, exec) => {
          const store = self.storeForAgent(exec.agent);
          const id = exec.agent.id;
          if (args.action === 'status') {
            return `本会话记忆：${store.isSessionEnabled(id) ? '已开启' : '未开启'}\n记忆库：${store.dir}`;
          }
          if (args.action === 'off') {
            if (!store.isSessionEnabled(id)) return '本会话记忆本来就是关闭的。';
            store.setSessionEnabled(id, false);
            self.turnBuffers.delete(id);
            return '已关闭本会话记忆：后续不再捕获，也不再注入。记忆库内容保留。';
          }
          const approval = self.ctx.get('approval');
          if (!approval) throw new Error('当前环境不支持审批，无法开启记忆');
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: 'memory_session',
            callId: exec.callId,
            reason: `允许在本对话中开启记忆？\n开启后会捕获本对话内容，并在后续轮次注入记忆索引。\n记忆库：${store.dir}`,
            displayReason: {
              en: `Enable memory for this conversation?\nIt will capture this chat and inject the memory index into later turns.\nLibrary: ${store.dir}`,
              zh: `允许在本对话中开启记忆？\n开启后会捕获本对话内容，并在后续轮次注入记忆索引。\n记忆库：${store.dir}`,
            },
            signal: exec.signal,
          });
          if (outcome !== 'allowed-once') return `未开启本会话记忆（审批结果：${outcome}）`;
          store.setSessionEnabled(id, true);
          const session = self.ctx.sessions.get(id);
          const last = session ? lastUserText(session) : '';
          self.turnBuffers.set(id, { user: last ? [last] : [], assistant: [], files: [] });
          return `已开启本会话记忆。\n记忆库：${store.dir}\n本轮之后的对话会被捕获，下一轮开始注入记忆索引。`;
        },
        { required: ['action'], timeoutMs: 300000 },
      ),

      tool(
        'memory_search',
        'Search this workspace\'s memory library by keyword over card titles, one-line summaries, and tags. Returns compact hits with id, title, summary, importance, confidence, and clarity. Use memory_read for the full card.',
        {
          query: { type: 'string', description: 'Keywords (Chinese or English).' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum hits, default 8.' },
          minImportance: { type: 'integer', minimum: 1, maximum: 5, description: 'Only cards at or above this importance.' },
          tag: { type: 'string', description: 'Only cards carrying this tag.' },
          confidence: { type: 'string', enum: ['quote', 'summary', 'guess', 'conflict'], description: 'Only cards with this certainty.' },
        },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const hits = store.search(args.query, args.limit || 8, {
            minImportance: args.minImportance,
            tag: args.tag,
            confidence: args.confidence,
          });
          if (!hits.length) return `没有匹配「${args.query}」的记忆卡。`;
          return hits
            .map(({ entry }) => {
              const key = entry.linkKey || entry.id;
              const source = entry.linked ? `（外链：${entry.mountLabel}，只读）` : '';
              const confidence = entry.confidence === 'quote' ? '原话' : entry.confidence === 'guess' ? '推测' : entry.confidence === 'conflict' ? '有冲突' : '整理';
              const strength = Math.round(entry.strength ?? effectiveStrength(entry));
              return `- ${stars(entry.importance)} ${entry.title} [${key}] ${confidence} · ${strength}/100${source}\n  ${entry.summary || '（无简介）'}`;
            })
            .join('\n');
        },
        { required: ['query'], isConcurrencySafe: true },
      ),

      tool(
        'memory_read',
        'Read one memory item in full by id (from the injected index or memory_search). Also accepts "journal:YYYY-MM-DD" for that day\'s raw journal, "index" for the whole index, and "rules" for the rules file. Reading a library item marks it reviewed, which slows its forgetting.',
        {
          id: { type: 'string', description: 'Memory id, journal:YYYY-MM-DD, index, or rules.' },
        },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const text = store.read(args.id);
          if (!text) throw new Error(`未找到记忆：${args.id}（可用 memory_search 查找）`);
          return text;
        },
        { required: ['id'], isConcurrencySafe: true },
      ),

      tool(
        'memory_write',
        'Save a durable memory card: title, one-line summary, content, importance 1-5, certainty, optional tags and related card ids. Use it when the user states a long-lived preference, makes a decision, or gives a fact worth remembering across sessions. Do not store transient chatter. Writing the same title updates the existing card.',
        {
          title: { type: 'string', description: 'Short library title (<=30 chars).' },
          summary: { type: 'string', description: 'One-line summary used in the catalog (<=70 chars).' },
          content: { type: 'string', description: 'Full content, 200-1200 chars.' },
          importance: { type: 'integer', minimum: 1, maximum: 5, description: '5 = permanent, 3 = normal, 1 = trivial.' },
          confidence: { type: 'string', enum: ['quote', 'summary', 'guess', 'conflict'], description: 'quote = user said it; summary = distilled; guess = inferred; conflict = conflicting reports.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
          links: { type: 'array', items: { type: 'string' }, description: 'Optional related card ids.' },
        },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const result = store.write({
            title: args.title,
            summary: args.summary,
            content: args.content,
            importance: args.importance,
            confidence: args.confidence,
            tags: args.tags,
            links: args.links,
          });
          return `${result.created ? '已创建' : '已更新'}记忆卡「${result.entry.title}」[${result.entry.id}]，重要度 ${stars(result.entry.importance)}。`;
        },
        { required: ['title', 'summary', 'content'] },
      ),

      tool(
        'memory_forget',
        'Intentionally forget one memory card. This is the human act of not wanting to remember; use it when the user asks to delete a wrong or unwanted memory. Related files become unreferenced but are not deleted automatically.',
        { id: { type: 'string', description: 'Card id to forget.' } },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const entry = store.resolveId(args.id);
          if (!entry) throw new Error(`未找到记忆卡：${args.id}`);
          store.forgetEntry(entry.id);
          return `已忘掉「${entry.title}」（${entry.id}）。`;
        },
        { required: ['id'], timeoutMs: 60000 },
      ),

      tool(
        'memory_pin',
        'Pin or unpin a memory card. Pinned cards do not fade automatically and stay near the top of recall.',
        {
          id: { type: 'string', description: 'Card id.' },
          pinned: { type: 'boolean', description: 'true = pin, false = unpin.' },
        },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const entry = store.pinEntry(args.id, args.pinned !== false);
          if (!entry) throw new Error(`未找到记忆卡：${args.id}`);
          return `${entry.pinned ? '已钉住' : '已取消钉住'}「${entry.title}」。`;
        },
        { required: ['id'], timeoutMs: 60000 },
      ),

      tool(
        'memory_status',
        'Show the memory library location, storage usage against the configured cap, entry counts, journal days, rules size, and the last consolidation time.',
        {},
        async (_args, exec) => {
          const targetDir = self.targetDirFor(exec.agent);
          const store = self.storeForAgent(exec.agent);
          const mode = self.readMode(targetDir);
          const lines = [];
          if (mode.mode === 'shared') {
            lines.push(`模式：共用记忆库（源 ${mode.source}）`);
            if (!exists(mode.source)) lines.push('⚠ 源不可用，当前回退到本地库');
          } else if (store.mounts.length) {
            lines.push(`模式：只读接取 ${store.mounts.length} 个外链 + 本地新库`);
          } else {
            lines.push('模式：完全独立');
          }
          lines.push(`本会话记忆：${store.isSessionEnabled(exec.agent.id) ? '已开启' : '未开启（需用户手动开启：memory_session action=on）'}`);
          lines.push(store.status());
          return lines.join('\n');
        },
        { isConcurrencySafe: true },
      ),

      tool(
        'memory_configure',
        'Change this workspace\'s memory settings: maxStorageBytes (default 5 GiB), slowdown, promptMaxChars, saveFiles (default false), and confirmOverMb (default 100). Values persist in .dsh-memory/settings.json and override the plugin defaults.',
        {
          maxStorageBytes: { type: 'integer', minimum: 67108864, description: 'Storage cap in bytes (default 5368709120 = 5 GiB).' },
          slowdown: { type: 'number', minimum: 1, maximum: 20, description: 'Forgetting slowdown multiplier (default 2.5).' },
          promptMaxChars: { type: 'integer', minimum: 1200, maximum: 20000, description: 'Maximum characters injected into the prompt (default 4200).' },
          saveFiles: { type: 'boolean', description: 'When true, chat attachments are copied into the memory library automatically.' },
          confirmOverMb: { type: 'integer', minimum: 1, maximum: 4096, description: 'Files larger than this need a separate confirmation (default 100 MB).' },
        },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const payload = { ...args };
          if (args.saveFiles !== undefined || args.confirmOverMb !== undefined) {
            payload.files = {
              enabled: args.saveFiles,
              confirmOverMb: args.confirmOverMb,
            };
          }
          delete payload.saveFiles;
          delete payload.confirmOverMb;
          if (!Object.keys(payload).length) throw new Error('没有提供可修改的设置');
          return store.configure(payload);
        },
      ),

      tool(
        'memory_file_save',
        'Copy one workspace file into the memory library\'s shared files area, optionally attaching it to a card. File saving is off by default for chat attachments, but this explicit call always works. Files over the configured threshold require user approval.',
        {
          path: { type: 'string', description: 'Absolute path, or a path relative to the workspace root.' },
          cardId: { type: 'string', description: 'Optional card id to attach this file to.' },
          name: { type: 'string', description: 'Optional display filename.' },
        },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const source = path.isAbsolute(args.path) ? args.path : path.join(path.dirname(store.dir), args.path);
          try {
            const file = store.saveFile(source, { cardId: args.cardId, name: args.name, sessionId: exec.agent.id });
            return `已保存文件「${file.name}」[${file.id}]，${file.bytes} 字节。\n路径：${file.absolute}`;
          } catch (error) {
            if (!error || error.code !== 'NEEDS_CONFIRMATION') throw error;
            const approval = self.ctx.get('approval');
            if (!approval) throw new Error('当前环境不支持审批，无法保存大文件');
            const outcome = await approval.request({
              agent: exec.agent,
              toolName: 'memory_file_save',
              callId: exec.callId,
              reason: `文件「${error.name}」约 ${Math.round(error.bytes / 1024 / 1024)} MB，超过单独确认阈值。允许保存到记忆库吗？`,
              displayReason: {
                en: `File "${error.name}" is about ${Math.round(error.bytes / 1024 / 1024)} MB, above the confirmation threshold. Save it to the memory library?`,
                zh: `文件「${error.name}」约 ${Math.round(error.bytes / 1024 / 1024)} MB，超过单独确认阈值。允许保存到记忆库吗？`,
              },
              signal: exec.signal,
            });
            if (outcome !== 'allowed-once') return `未保存大文件（审批结果：${outcome}）`;
            const file = store.saveFile(source, { cardId: args.cardId, name: args.name, sessionId: exec.agent.id, confirmed: true });
            return `已保存大文件「${file.name}」[${file.id}]，${file.bytes} 字节。\n路径：${file.absolute}`;
          }
        },
        { required: ['path'], timeoutMs: 300000 },
      ),

      tool(
        'memory_file_list',
        'List files stored in this memory library, optionally only those attached to one card.',
        { cardId: { type: 'string', description: 'Optional card id.' } },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const rows = store.listFiles(args.cardId);
          if (!rows.length) return '记忆库里还没有文件。';
          return rows.map((row) => `- ${row.name} [${row.id}] ${row.bytes} 字节${row.card_id ? `（卡片 ${row.card_id}）` : '（未关联卡片）'}`).join('\n');
        },
        { isConcurrencySafe: true },
      ),

      tool(
        'memory_file_read',
        'Read metadata and the host path of one stored file. Use read_image for images, or read for text files.',
        { id: { type: 'string', description: 'File id.' } },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const row = store.listFiles().find((file) => file.id === args.id);
          if (!row) throw new Error(`未找到文件：${args.id}`);
          const absolute = store.files.absolute(row);
          return `name: ${row.name}\nid: ${row.id}\nbytes: ${row.bytes}\nmime: ${row.mime}\npath: ${absolute || '（不可访问）'}\ncard: ${row.card_id || '（未关联）'}`;
        },
        { required: ['id'], isConcurrencySafe: true },
      ),

      tool(
        'memory_file_forget',
        'Delete one stored file. If a card still references it, pass force=true only after the user agrees.',
        {
          id: { type: 'string', description: 'File id.' },
          force: { type: 'boolean', description: 'Delete even if a card references it.' },
        },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const ok = store.forgetFile(args.id, { force: args.force === true });
          return ok ? `已删除文件 ${args.id}。` : `未找到文件 ${args.id}。`;
        },
        { required: ['id'], timeoutMs: 60000 },
      ),

      tool(
        'memory_link',
        'Mount another workspace\'s memory library for read-only, filtered access, or unmount one. Mounted entries appear in the injected index and memory_search and can be read, but this workspace can never write back to the source. Filters: tags (any match), minImportance, limit. Adding a mount requires explicit user approval.',
        {
          action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'list = show mounts; add = mount a source; remove = unmount.' },
          source: { type: 'string', description: 'Source workspace root or its .dsh-memory directory.' },
          label: { type: 'string', description: 'Display label for this mount.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Only expose entries carrying at least one of these tags.' },
          minImportance: { type: 'integer', minimum: 1, maximum: 5, description: 'Only expose entries at or above this importance.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum entries exposed from this mount (default 40).' },
          id: { type: 'string', description: 'Mount id for remove.' },
        },
        async (args, exec) => {
          const targetDir = self.targetDirFor(exec.agent);
          const mode = self.readMode(targetDir);
          if (mode.mode === 'shared' && args.action !== 'list') {
            throw new Error('当前工作区处于共用模式，外链由源库统一管理；请先在源工作区操作，或切回只读/独立模式');
          }
          const store = self.storeForAgent(exec.agent);
          if (!store.isSessionEnabled(exec.agent.id) && args.action !== 'list') {
            throw new Error('本会话尚未开启记忆。请由用户确认后开启：memory_session action=on');
          }
          if (args.action === 'list') return store.listMounts();
          if (args.action === 'remove') {
            const removed = store.unlink(args.id || args.source);
            if (!removed) throw new Error('未找到对应的外链，可用 action=list 查看当前接取');
            return `已断开外链「${removed.label}」：${removed.source}`;
          }
          if (!args.source) throw new Error('action=add 需要提供 source（源工作区路径）');
          const approval = self.ctx.get('approval');
          if (!approval) throw new Error('当前环境不支持审批，无法建立外链');
          const tags = Array.isArray(args.tags) ? args.tags.filter(Boolean) : [];
          const filters = [
            `标签 ${tags.length ? tags.join('/') : '不限'}`,
            `最低重要度 ${args.minImportance || 1}`,
            `最多 ${args.limit || 40} 条`,
          ];
          const reason = `允许当前工作区只读接取另一个项目的记忆库？\n源：${args.source}\n过滤：${filters.join('；')}\n接取后只能读取，不能写回源库。`;
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: 'memory_link',
            callId: exec.callId,
            reason,
            displayReason: {
              en: `Allow this workspace to mount another project's memory read-only?\nSource: ${args.source}\nFilters: ${filters.join('; ')}`,
              zh: reason,
            },
            signal: exec.signal,
          });
          if (outcome !== 'allowed-once') return `未建立接取（审批结果：${outcome}）`;
          const result = store.link(args);
          return `${result.updated ? '已更新' : '已建立'}只读外链「${result.mount.label}」[${result.mount.id}] ← ${result.mount.source}\n过滤：${filters.join('；')}`;
        },
        { required: ['action'], timeoutMs: 300000 },
      ),

      tool(
        'memory_mode',
        'Choose how this workspace uses memory. shared = read/write one common library together with another workspace (entries, journal, rules, consolidation all shared); readonly = mount an old library read-only (optional tags/minImportance/limit) while this workspace keeps writing its own new library; isolated = fresh independent library with no mounts. shared/readonly require explicit user approval. mode="status" inspects the current choice.',
        {
          mode: { type: 'string', enum: ['shared', 'readonly', 'isolated', 'status'], description: 'shared | readonly | isolated | status.' },
          source: { type: 'string', description: 'Source workspace root or its .dsh-memory directory (shared/readonly).' },
          label: { type: 'string', description: 'Display label for the readonly mount.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'readonly: only entries carrying at least one of these tags.' },
          minImportance: { type: 'integer', minimum: 1, maximum: 5, description: 'readonly: only entries at or above this importance.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'readonly: maximum entries exposed (default 40).' },
        },
        async (args, exec) => {
          const targetDir = self.targetDirFor(exec.agent);
          const currentStore = self.storeForDir(targetDir);
          if (args.mode !== 'status' && !currentStore.isSessionEnabled(exec.agent.id)) {
            throw new Error('本会话尚未开启记忆。请由用户确认后开启：memory_session action=on');
          }
          if (args.mode === 'status') return self.modeDescription(targetDir, currentStore);
          if (args.mode === 'isolated') {
            removeFile(path.join(targetDir, 'mode.json'));
            const local = self.storeForDir(targetDir);
            if (local.mounts.length) {
              local.mounts = [];
              local.saveMounts();
            }
            return `已切换为完全独立记忆库。\n本地库：${local.dir}\n外部接取：已清空`;
          }
          if (!args.source) throw new Error('shared/readonly 需要提供 source（源工作区路径）');
          const sourceDir = self.sourceDirOf(args.source);
          if (path.resolve(sourceDir) === path.resolve(targetDir)) throw new Error('源不能是当前工作区自己的记忆库');
          const sourceMode = self.readMode(sourceDir);
          if (sourceMode.mode === 'shared') throw new Error('源工作区本身处于共用模式，请直接共用它的源库，避免链式共用');
          const approval = self.ctx.get('approval');
          if (!approval) throw new Error('当前环境不支持审批，无法切换模式');
          const tags = Array.isArray(args.tags) ? args.tags.filter(Boolean) : [];
          const filters = [
            `标签 ${tags.length ? tags.join('/') : '不限'}`,
            `最低重要度 ${args.minImportance || 1}`,
            `最多 ${args.limit || 40} 条`,
          ];
          const isShared = args.mode === 'shared';
          const reason = isShared
            ? `允许把当前工作区切换为“共用记忆库”？\n源：${sourceDir}\n注意：之后本项目的条目、日志、规则、整理都会写入源库，两个项目共用同一套记忆。`
            : `允许切换为“只读接取 + 本地新库”模式？\n源：${sourceDir}\n过滤：${filters.join('；')}\n老库只读，本项目继续写入自己的新库。`;
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: 'memory_mode',
            callId: exec.callId,
            reason,
            displayReason: {
              en: isShared
                ? `Switch this workspace to a shared memory library?\nSource: ${sourceDir}\nThis project will then read and write the source library (entries, journal, rules).`
                : `Switch to read-only mount + new local library?\nSource: ${sourceDir}\nFilters: ${filters.join('; ')}`,
              zh: reason,
            },
            signal: exec.signal,
          });
          if (outcome !== 'allowed-once') return `未切换模式（审批结果：${outcome}）`;
          if (isShared) {
            writeTextFile(
              path.join(targetDir, 'mode.json'),
              `${JSON.stringify({ mode: 'shared', source: sourceDir, updatedAt: new Date().toISOString() }, null, 2)}\n`,
            );
            return `已切换为共用记忆库。\n读写源：${sourceDir}\n本项目原有本地库保留，但暂不使用。`;
          }
          removeFile(path.join(targetDir, 'mode.json'));
          const local = self.storeForDir(targetDir);
          const result = local.link({ source: sourceDir, label: args.label, tags, minImportance: args.minImportance, limit: args.limit });
          return `已切换为只读接取模式。\n${result.updated ? '已更新' : '已建立'}外链「${result.mount.label}」[${result.mount.id}] ← ${result.mount.source}\n本项目新记忆继续写入：${local.dir}`;
        },
        { required: ['mode'], timeoutMs: 300000 },
      ),

      tool(
        'memory_consolidate',
        'Run the memory consolidation pass immediately: distill recent journal into library entries, compress items due under the forgetting curve, and enforce the storage cap. Normally runs automatically 2-3 times a day; call this only when the user asks.',
        {},
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const result = await store.consolidate({ force: true });
          if (result.skipped) return `未执行：${result.skipped}`;
          const lines = [
            `整理完成：新建 ${result.created} 条，更新 ${result.updated} 条，压缩 ${result.compressed} 条，归档 ${result.archived} 条。`,
            `用量：${result.usedBytes} 字节`,
          ];
          if (result.modelError) lines.push(`模型调用失败：${result.modelError}（内容保留，稍后重试）`);
          if (result.capacity) lines.push(`容量整理：${result.capacity.actions.join('；') || '无需处理'}`);
          if (result.errors && result.errors.length) lines.push(`部分错误：${result.errors.slice(0, 3).join('；')}`);
          return lines.join('\n');
        },
        { timeoutMs: 180000 },
      ),

      tool(
        'memory_propose_rule',
        'Propose adding a rule to the workspace rules file (RULES.md). The rule is written only after the user explicitly approves the request in the UI; the assistant can never write the rules file directly. Use this for standing instructions, corrections, or special constraints the user wants remembered.',
        {
          section: { type: 'string', enum: ['basic', 'special'], description: 'basic = general rules; special = one-off constraints.' },
          rule: { type: 'string', description: 'The rule text to add, one concise sentence.' },
          rationale: { type: 'string', description: 'Why this rule should exist.' },
        },
        async (args, exec) => {
          const store = self.requireStoreForAgent(exec.agent);
          const approval = self.ctx.get('approval');
          if (!approval) throw new Error('当前环境不支持审批，无法修改规则');
          const section = args.section === 'special' ? '特殊规则' : '基础规则';
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: 'memory_propose_rule',
            callId: exec.callId,
            reason: `AI 想添加一条${section}：\n${args.rule}\n\n${args.rationale ? `理由：${args.rationale}` : ''}`,
            displayReason: {
              en: `The assistant wants to add a ${args.section === 'special' ? 'special' : 'basic'} rule:\n${args.rule}\n\n${args.rationale || ''}`,
              zh: `AI 想添加一条${section}：\n${args.rule}\n\n${args.rationale || ''}`,
            },
            signal: exec.signal,
          });
          if (outcome !== 'allowed-once') {
            return `未写入规则（审批结果：${outcome}）。规则文件保持不变。`;
          }
          store.appendRule(args.section, args.rule, args.rationale);
          return `规则已写入 RULES.md（${section}）：${clip(args.rule, 200)}`;
        },
        { required: ['section', 'rule'], timeoutMs: 300000 },
      ),
    ];

    for (const definition of definitions) {
      this.ctx.effect(() => this.ctx.tools.register(definition));
    }
  }

  // ---------------------------------------------------------------- maintenance

  scanWorkspaces() {
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (!registry || typeof registry.list !== 'function') return;
      for (const workspace of registry.list()) {
        const dir = path.join(workspace.path, '.dsh-memory');
        if (exists(dir)) this.storeForDir(dir);
      }
    } catch (error) {
      console.error('[memory-library] workspace scan failed', error);
    }
  }

  startMaintenance() {
    const interval = Math.max(15000, Number(this.config.maintenanceIntervalMs) || 60000);
    const start = (fn, ms) => {
      if (typeof this.ctx.interval === 'function') return this.ctx.interval(fn, ms);
      const handle = setInterval(fn, ms);
      if (handle && typeof handle.unref === 'function') handle.unref();
      return () => clearInterval(handle);
    };
    this.ctx.effect(() => start(() => void this.tick(), interval));
    this.ctx.effect(() => {
      const handle = setTimeout(() => void this.tick(), 4000);
      if (handle && typeof handle.unref === 'function') handle.unref();
      return () => clearTimeout(handle);
    });
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const perDay = Math.max(1, Number(this.config.consolidationsPerDay) || 3);
      const window = DAY / perDay;
      for (const store of [...this.stores.values()]) {
        try {
          const lastCheck = this.lastCapacityCheck.get(store.dir) || 0;
          if (Date.now() - lastCheck > 10 * 60000) {
            this.lastCapacityCheck.set(store.dir, Date.now());
            if (store.usage(true) > store.maxBytes()) store.enforceCapacity();
          }
          store.purgeExpiredArchive();
          const last = store.state.lastConsolidatedAt || 0;
          if (!last || Date.now() - last >= window) {
            const journal = store.hasJournalSince(last);
            const due = store.dueEntries();
            if ((journal || due.length > 0) && !store.consolidating) await store.consolidate();
          }
        } catch (error) {
          store.lastError = error instanceof Error ? error.message : String(error);
          console.error('[memory-library] maintenance failed', store.dir, error);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
