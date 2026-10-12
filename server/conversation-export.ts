import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Item, Thread, ThreadRead, Turn } from '../shared/types.js';

export type ExportFormat = 'txt' | 'markdown' | 'html';
const limit = 64 * 1024 * 1024;
const error = (message: string, statusCode = 502) =>
  Object.assign(new Error(message), { statusCode });

// Read every history page, retaining chronological order and the newest copy of overlaps.
export async function completeConversation(
  read: (cursor?: string) => Promise<ThreadRead>,
  signal?: AbortSignal,
): Promise<Thread> {
  const seen = new Set<string>();
  const turns = new Map<string, Turn>();
  const pages: Turn[][] = [];
  let thread: Thread | undefined;
  let cursor: string | undefined;
  let bytes = 0;
  do {
    signal?.throwIfAborted();
    if (pages.length >= 10000) throw error('会话分页数量超过导出限制，未生成截断文件', 413);
    const page = await read(cursor);
    thread ||= page.thread;
    bytes += Buffer.byteLength(JSON.stringify(page.thread));
    if (bytes > limit) throw error('会话内容超过 64 MiB，无法一次性导出；未生成截断文件', 413);
    pages.push(page.thread.turns);
    for (const turn of page.thread.turns) if (!turns.has(turn.id)) turns.set(turn.id, turn);
    cursor = page.nextCursor || undefined;
    if (cursor && seen.has(cursor)) throw error('会话历史分页异常，导出已取消，请重试');
    if (cursor) seen.add(cursor);
  } while (cursor);
  const ordered = new Set(pages.reverse().flatMap((page) => page.map((turn) => turn.id)));
  return { ...thread!, turns: [...ordered].map((id) => turns.get(id)!) };
}

const labels: Record<string, string> = {
  userMessage: '用户',
  agentMessage: '助手',
  reasoning: '思考内容',
  commandExecution: '执行命令',
  fileChange: '文件改动',
  plan: '执行计划',
  enteredReviewMode: '开始代码审查',
  exitedReviewMode: '代码审查结果',
  contextCompaction: '上下文压缩',
  webSearch: '网页搜索',
  imageView: '查看图片',
  mcpToolCall: '工具调用',
  collabAgentToolCall: '协作任务',
};
const markdownHtml = (body: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: body,
      remarkPlugins: [remarkGfm],
      components: {
        img: ({ alt }) => createElement('span', null, `[图片：${alt || '图片'}]`),
        a: ({ href, children }) =>
          /^(https?:|mailto:|#)/i.test(href || '')
            ? createElement('a', { href, rel: 'noopener noreferrer' }, children)
            : createElement('span', null, children),
      },
    }),
  );
const json = (value: unknown) => JSON.stringify(value, null, 2);
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const fence = (value: string) => {
  const ticks = '`'.repeat(
    [...value.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length + 1), 3),
  );
  return `${ticks}\n${value}\n${ticks}`;
};

function itemBody(item: Item): string {
  if (item.type === 'userMessage') {
    return (item.content || [])
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part.type === 'text') return part.text || '';
        // Export attachment descriptions, never inline binary/base64 payloads.
        const reference = [part.path, part.url, part.imageUrl, part.name]
          .filter((v): v is string => typeof v === 'string')
          .map((v) => (v.startsWith('data:') ? '内嵌附件（未嵌入文件）' : v));
        return `[附件：${part.type}] ${reference.join(' · ') || '未提供可导出的引用'}`;
      })
      .join('\n\n');
  }
  if (item.type === 'agentMessage')
    return [item.text, item.questions?.length ? `追问\n${json(item.questions)}` : '']
      .filter(Boolean)
      .join('\n\n');
  if (item.type === 'reasoning')
    return [
      ...(item.summary || []),
      ...(item.content || []).map((p) => (typeof p === 'string' ? p : p.text || json(p))),
    ].join('\n\n');
  if (item.type === 'commandExecution')
    return [
      item.command,
      item.cwd && `目录：${item.cwd}`,
      item.exitCode != null && `退出码：${item.exitCode}`,
      item.aggregatedOutput && `输出：\n${item.aggregatedOutput}`,
      item.terminalInput && `终端输入：\n${item.terminalInput}`,
    ]
      .filter((v): v is string => typeof v === 'string')
      .join('\n\n');
  if (item.type === 'fileChange')
    return [
      ...(item.changes || []).map((change) =>
        [change.path, json(change.kind), change.diff].filter(Boolean).join('\n'),
      ),
      item.aggregatedOutput,
    ]
      .filter(Boolean)
      .join('\n\n');
  if (item.type === 'plan') return item.text || '';
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode')
    return item.review || '';
  // Preserve unfamiliar tool records instead of silently dropping new item types.
  return json(item);
}

export function renderConversation(thread: Thread, format: ExportFormat, exportedAt = new Date()) {
  const title = thread.name || thread.preview || '新会话';
  const timestamp = (value: number) =>
    Number.isFinite(value) ? new Date(value * 1000).toISOString() : '未知';
  const meta = `会话 ID：${thread.id}\n项目目录：${thread.cwd}\n创建时间：${timestamp(thread.createdAt)}\n导出时间：${exportedAt.toISOString()}\n轮次：${thread.turns.length}\n状态：${thread.status.type}`;
  const note =
    '包含导出时可读取的完整历史；运行中的回复可能尚未完成。图片和附件仅保留引用，不嵌入原文件。';
  const sections: { heading: string; body: string; markdown?: boolean; level: number }[] = [
    { heading: title, body: `${meta}\n\n${note}`, level: 1 },
  ];
  for (const [index, turn] of thread.turns.entries()) {
    sections.push({
      heading: `第 ${index + 1} 轮`,
      level: 2,
      body: [
        `轮次 ID：${turn.id}`,
        `状态：${turn.status}`,
        turn.model && `模型：${turn.model}`,
        turn.startedAt != null && `开始时间：${timestamp(turn.startedAt)}`,
        turn.error && `错误：${turn.error.message}`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
    for (const item of turn.items)
      sections.push({
        heading: `${labels[item.type] || item.type}${item.phase === 'commentary' ? ' · 进度' : ''}${item.status ? ` · ${item.status}` : ''}`,
        body: itemBody(item),
        level: 3,
        markdown: ['agentMessage', 'plan', 'reasoning', 'exitedReviewMode'].includes(item.type),
      });
    if (turn.plan?.length) sections.push({ heading: '轮次计划', level: 3, body: json(turn.plan) });
    if (turn.planExplanation)
      sections.push({ heading: '计划说明', level: 3, body: turn.planExplanation });
    if (turn.diff) sections.push({ heading: '轮次差异', level: 3, body: turn.diff });
  }
  let content: string;
  if (format === 'html') {
    content = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>body{max-width:960px;margin:40px auto;padding:0 20px;color:#202124;background:#fff;font:16px/1.65 system-ui,sans-serif}section{margin:24px 0}h1,h2,h3{overflow-wrap:anywhere}h2{border-top:1px solid #ddd;padding-top:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f7f8;border-radius:8px;padding:16px;font:inherit}h3{font-size:16px;color:#465169}.message{overflow-wrap:anywhere}code{font-family:ui-monospace,monospace}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #ddd;padding:6px 10px}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:16px}@media print{body{margin:0;max-width:none}pre{background:none}}</style></head><body>${sections.map((section) => `<section><h${section.level}>${escape(section.heading)}</h${section.level}>${section.markdown ? `<div class="message">${markdownHtml(section.body)}</div>` : `<pre>${escape(section.body)}</pre>`}</section>`).join('\n')}</body></html>\n`;
  } else if (format === 'markdown') {
    content =
      sections
        .map(
          (s) =>
            `${'#'.repeat(s.level)} ${s.heading.replace(/[\r\n]/g, ' ').replace(/([\\`*_{}\[\]<>#])/g, '\\$1')}\n\n${s.markdown ? s.body : fence(s.body)}`,
        )
        .join('\n\n') + '\n';
  } else
    content =
      sections
        .map((s) => `${s.heading}\n${'='.repeat(s.level === 1 ? 40 : 20)}\n${s.body}`)
        .join('\n\n') + '\n';
  if (Buffer.byteLength(content) > limit) throw error('导出文件超过 64 MiB，未生成截断文件', 413);
  const ext = format === 'markdown' ? 'md' : format;
  // A fixed filename avoids invalid paths, control characters and long conversation titles.
  const filename = `conversation-${exportedAt.toISOString().replace(/[:.]/g, '-')}.${ext}`;
  return {
    content,
    filename,
    contentType:
      { txt: 'text/plain', markdown: 'text/markdown', html: 'text/html' }[format] +
      '; charset=utf-8',
  };
}
