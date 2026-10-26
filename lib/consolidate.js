const SYSTEM_PROMPT = `你是“记忆图书馆”的整理员。
你负责把对话日志提炼成长期可检索的记忆条目，合并重复内容，并对到期条目做压缩降级。
你只输出 JSON，不输出解释、标题或 Markdown 代码围栏。`;

function clip(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function buildInput(input) {
  return {
    journal: input.journal.map((item) => ({
      date: item.date,
      time: item.time,
      session: item.session,
      user: clip(item.user, 1200),
      assistant: clip(item.assistant, 700),
    })),
    library: input.library.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      importance: item.importance,
      confidence: item.confidence,
      level: item.level,
      strength: Math.round(item.strength ?? 0),
      tags: item.tags,
      links: item.links,
    })),
    due: input.due.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      importance: item.importance,
      confidence: item.confidence,
      level: item.level,
      strength: Math.round(item.strength ?? 0),
      content: item.level === 0 ? clip(item.content, 1200) : '',
    })),
  };
}

function instruction() {
  return `任务：
1. 从 journal 中提炼出长期有用的记忆卡：用户偏好、身份信息、明确决定、项目事实、反复出现的约束、未完成的待办。
2. 与 library 中已有卡片重复或相关的，用 op="update" 合并，保留原 id；能合并的才合并。
3. due 中到期的卡片，按清晰度给出更短的版本：to=1（摘要）、to=2（短摘要）、to=3（仅标题）、to=4（归档）。
4. 如果新说法与旧卡片冲突，不要覆盖；新建一张 confidence="conflict" 的卡片，并用 links 指向旧卡。
5. 不要为寒暄、一次性命令、临时调试输出建立卡片。

重要度：
5 = 用户明确要求永久记住的规则、身份或长期偏好（永不自动压缩）
4 = 长期重要，会影响之后很多对话
3 = 一般项目事实（默认）
2 = 次要细节
1 = 琐碎，尽快遗忘

确定程度：
- "quote"：用户原话
- "summary"：从对话整理（默认）
- "guess"：推断
- "conflict"：与已有卡片冲突

硬性要求：
- 不虚构，只使用 journal 中出现的事实；数字、路径、名称、用户原话中的偏好必须保留。
- 每张卡：title ≤ 30 字，summary ≤ 70 字，content 200-1200 字；tags 1-5 个。
- 最多 12 个 entries、12 个 compressions；宁少勿滥。
- 仅输出以下形状的 JSON：
{"entries":[{"op":"create","id":"仅 update 时填写","title":"","summary":"","content":"","importance":3,"confidence":"summary","tags":[""],"links":[""]}],"compressions":[{"id":"","to":1,"summary":""}],"notes":""}`;
}

export function buildPrompt(input) {
  const payload = buildInput(input);
  let body = JSON.stringify(payload);
  if (body.length > 20000) {
    body = JSON.stringify({
      ...payload,
      journal: payload.journal.slice(-8).map((item) => ({ ...item, assistant: clip(item.assistant, 300) })),
      due: payload.due.map((item) => ({ ...item, content: clip(item.content, 400) })),
    });
  }
  if (body.length > 26000) body = JSON.stringify({ ...payload, journal: payload.journal.slice(-4), due: [] });
  return `${instruction()}\n\n输入：\n${body}`;
}

export function parseModelJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

export async function runConsolidationModel(ctx, config, input) {
  const llm = ctx.get('llm');
  if (!llm) throw new Error('LLM 服务不可用');
  let selection;
  if (config.provider && config.model) {
    selection = { provider: config.provider, model: config.model };
  } else {
    const defaults = ctx.get('agentDefaultModel');
    selection = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined;
  }
  if (!selection || !selection.provider || !selection.model) throw new Error('没有可用的默认模型');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.llmTimeoutMs) || 120000);
  let text = '';
  let failure = null;
  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(input) }] }],
      maxTokens: Number(config.consolidationMaxTokens) || 2400,
      temperature: 0.2,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') failure = chunk.reason.failure;
    }
  } finally {
    clearTimeout(timer);
  }
  if (failure) throw new Error(failure.message || failure.code || '模型调用失败');
  const parsed = parseModelJson(text);
  if (!parsed) throw new Error('模型未返回可解析的 JSON');
  return parsed;
}
