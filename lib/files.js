import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MB = 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.pdf', '.mp3', '.wav', '.m4a', '.ogg', '.flac',
  '.mp4', '.webm', '.mov', '.mkv',
  '.md', '.txt', '.json', '.csv', '.log',
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
]);

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.log': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
};

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 120);
  return base || 'file';
}

function hashFile(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Content-addressed file area inside one memory library. Files live next to the
 * cards so shared libraries share them too; the catalog only stores metadata.
 */
export class FileStore {
  constructor(dir, catalog, config) {
    this.dir = dir;
    this.filesDir = path.join(dir, 'files');
    this.catalog = catalog;
    this.config = config;
    this.error = null;
  }

  get settings() {
    return {
      enabled: this.config.files?.enabled === true,
      confirmOverMb: Number(this.config.files?.confirmOverMb ?? 100) || 100,
    };
  }

  allowed(name) {
    return ALLOWED_EXTENSIONS.has(path.extname(String(name || '')).toLowerCase());
  }

  mimeOf(name) {
    return MIME_BY_EXT[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream';
  }

  needsConfirmation(bytes) {
    return Number(bytes) > this.settings.confirmOverMb * MB;
  }

  list(cardId) {
    return this.catalog.listFiles(cardId);
  }

  get(id) {
    return this.catalog.getFile(id);
  }

  absolute(row) {
    if (!row || !row.path) return undefined;
    const resolved = path.resolve(this.dir, row.path);
    if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) return undefined;
    return resolved;
  }

  saveFromPath(source, options = {}) {
    const absolute = path.resolve(String(source || ''));
    if (!fs.existsSync(absolute)) throw new Error(`文件不存在：${absolute}`);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error('只能保存文件，不能保存目录');
    const name = safeName(options.name || path.basename(absolute));
    if (!options.force && !this.allowed(name)) {
      throw new Error(`不支持的文件类型：${path.extname(name) || '（无扩展名）'}`);
    }
    if (this.needsConfirmation(stat.size) && !options.confirmed) {
      const error = new Error(`文件大于 ${this.settings.confirmOverMb} MB，需要单独确认`);
      error.code = 'NEEDS_CONFIRMATION';
      error.bytes = stat.size;
      error.name = name;
      throw error;
    }
    const sha256 = hashFile(absolute);
    const id = `f-${sha256.slice(0, 16)}`;
    const existing = this.catalog.getFile(id);
    const cardId = options.cardId ?? existing?.card_id ?? null;
    const dest = path.join('files', sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}-${name}`);
    const destAbsolute = path.join(this.dir, dest);
    fs.mkdirSync(path.dirname(destAbsolute), { recursive: true });
    if (!fs.existsSync(destAbsolute)) fs.copyFileSync(absolute, destAbsolute);
    const now = new Date().toISOString();
    const row = {
      id,
      cardId,
      name,
      mime: options.mime || this.mimeOf(name),
      bytes: stat.size,
      sha256,
      path: dest,
      created: existing?.created || now,
      lastUsed: now,
      sourceSession: options.sessionId || existing?.source_session || '',
    };
    this.catalog.upsertFile(row);
    return { ...row, absolute: destAbsolute };
  }

  forget(id, options = {}) {
    const row = this.catalog.getFile(id);
    if (!row) return false;
    if (row.card_id && !options.force) {
      throw new Error('该文件仍被某张记忆卡引用；先解除关联或使用 force');
    }
    const absolute = this.absolute(row);
    if (absolute && fs.existsSync(absolute)) fs.unlinkSync(absolute);
    this.catalog.removeFile(id);
    return true;
  }

  totalBytes() {
    return this.catalog.fileStats().bytes;
  }
}
