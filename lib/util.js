import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

export function writeTextFile(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function appendTextFile(file, text) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, text, 'utf8');
}

export function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

export function extractText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

export function clip(text, max) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** First meaningful sentences of an assistant reply, used as the journal's "key points" excerpt. */
export function replyExcerpt(text, max = 900) {
  let value = normalizeWhitespace(text);
  if (!value) return '';
  value = value.replace(/```[\s\S]*?```/g, '[代码片段略]').trim();
  if (!value) return '';
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  if (stop > max * 0.5) return `${cut.slice(0, stop + 1)}…`;
  return `${cut}…`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

export function pad2(value) {
  return String(value).padStart(2, '0');
}

export function localDate(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function localTime(ms) {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function newId() {
  return `mem-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function stars(importance) {
  const n = clampInt(importance, 1, 5, 3);
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function dirSize(dir) {
  let total = 0;
  for (const file of walkFiles(dir)) {
    try {
      total += fs.statSync(file).size;
    } catch {
      /* raced */
    }
  }
  return total;
}
