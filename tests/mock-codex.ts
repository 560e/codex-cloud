import { CodexBridge } from '../server/codex.js';
import type { Json, Thread } from '../shared/types.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Deterministic protocol peer. No network/model/real shell execution in tests.
export class MockCodex extends CodexBridge {
  override readonly isTest = true;
  override async forceStop() {
    this.stop();
  }
  threads = new Map<string, Thread>();
  titleThreads = new Set<string>();
  archived = new Set<string>();
  responses: { id: string | number; result: Json }[] = [];
  callbacks = new Map<string | number, () => void>();
  timers = new Set<NodeJS.Timeout>();
  skillEnabled = new Map<string, boolean>();
  cwd: string;
  constructor(cwd = process.cwd()) {
    super();
    this.cwd = cwd;
  }
  override async start() {
    if (!this.ready) {
      this.ready = true;
      this.version = 'codex-cli 0.155.1 (test fixture)';
      this.emit('connected');
    }
  }
  notify(method: string, params: Json) {
    if (method === 'turn/started') params.turn.startedAt = Date.now() / 1000;
    if (method === 'turn/completed') {
      params.turn.completedAt = Date.now() / 1000;
      params.turn.durationMs =
        params.turn.startedAt == null
          ? null
          : Math.max(0, (params.turn.completedAt - params.turn.startedAt) * 1000);
    }
    this.emit('notification', { method, params });
  }
  later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }
  makeThread(cwd = this.cwd) {
    const thread: Thread = {
      id: randomUUID(),
      name: null,
      preview: '',
      cwd,
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
      turns: [],
      status: { type: 'idle' },
      historyMode: 'legacy',
    };
    this.threads.set(thread.id, thread);
    return thread;
  }
  override async call(method: string, p: Json = {}): Promise<Json> {
    if (method === 'skills/list') {
      const root = path.join(process.env.CODEX_HOME || this.cwd, 'skills');
      const names = await fs.readdir(root).catch(() => [] as string[]);
      const skills: Json[] = [];
      for (const name of names) {
        const file = path.join(root, name, 'SKILL.md');
        const text = await fs.readFile(file, 'utf8').catch(() => '');
        if (text)
          skills.push({
            name,
            description: /^description:\s*(.*)$/m.exec(text)?.[1] || '',
            path: file,
            scope: 'user',
            enabled: this.skillEnabled.get(file) !== false,
          });
      }
      return { data: (p.cwds || [this.cwd]).map((cwd: string) => ({ cwd, skills, errors: [] })) };
    }
    if (method === 'skills/config/write') {
      this.skillEnabled.set(p.path, p.enabled);
      return {};
    }
    if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
    if (method === 'fuzzyFileSearch') {
      const root = p.roots[0];
      const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
      return {
        files: entries
          .filter(
            (entry) => entry.isFile() && entry.name.toLowerCase().includes(p.query.toLowerCase()),
          )
          .slice(0, 50)
          .map((entry) => ({
            root,
            path: path.relative(root, path.join(entry.parentPath, entry.name)),
            file_name: entry.name,
            match_type: 'file',
            score: 1,
            indices: null,
          })),
      };
    }
    if (method === 'modelProvider/capabilities/read')
      return { namespaceTools: true, imageGeneration: false, webSearch: true };
    if (method === 'model/list')
      return {
        data: [
          {
            id: 'test-model',
            model: 'test-model',
            displayName: 'Test Codex',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
            defaultReasoningEffort: 'medium',
          },
        ],
      };
    if (method === 'account/read')
      return { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
    if (method === 'thread/list')
      return {
        data: [...this.threads.values()]
          .filter(
            (t) =>
              this.archived.has(t.id) === !!p.archived &&
              (!p.cwd || t.cwd === p.cwd) &&
              (!p.searchTerm || (t.name || t.preview).includes(p.searchTerm)),
          )
          .map((t) => ({ ...t, turns: [] })),
        nextCursor: null,
      };
    if (method === 'thread/start') {
      const thread = this.makeThread(p.cwd);
      if (
        typeof p.developerInstructions === 'string' &&
        p.developerInstructions.includes('给会话起标题')
      )
        this.titleThreads.add(thread.id);
      this.notify('thread/started', { thread });
      return { thread: structuredClone(thread) };
    }
    const thread = this.threads.get(p.threadId);
    if (!thread) throw new Error('Thread not found');
    if (method === 'review/start' || method === 'thread/compact/start') {
      const compact = method === 'thread/compact/start';
      const turn = {
        id: randomUUID(),
        status: 'inProgress',
        startedAt: Date.now() / 1000,
        items: [] as Json[],
      };
      const start = () => {
        thread.turns.push(turn);
        thread.status = { type: 'active' };
        this.notify('turn/started', { threadId: thread.id, turn: { ...turn, items: [] } });
        const item = {
          id: randomUUID(),
          type: compact ? 'contextCompaction' : 'enteredReviewMode',
          ...(compact ? {} : { review: '检查当前项目的代码修改。' }),
        };
        turn.items.push(item);
        this.notify('item/started', { threadId: thread.id, turnId: turn.id, item });
        this.later(() => {
          if (turn.status !== 'inProgress') return;
          this.notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
          if (!compact) {
            const result = {
              id: randomUUID(),
              type: 'exitedReviewMode',
              review: '模拟审查结果：请检查输入边界。',
            };
            turn.items.push(result);
            this.notify('item/completed', { threadId: thread.id, turnId: turn.id, item: result });
          }
          turn.status = 'completed';
          thread.status = { type: 'idle' };
          this.notify('turn/completed', { threadId: thread.id, turn });
        }, 800);
      };
      if (compact) {
        this.later(start, 150);
        return {};
      }
      start();
      return { turn: structuredClone(turn), reviewThreadId: thread.id };
    }
    if (method === 'thread/delete') {
      if (thread.status.type === 'active') throw new Error('Thread is active');
      this.threads.delete(thread.id);
      this.titleThreads.delete(thread.id);
      this.archived.delete(thread.id);
      return {};
    }
    if (method === 'thread/read' || method === 'thread/resume')
      return {
        thread: structuredClone({
          ...thread,
          turns: p.includeTurns || method === 'thread/resume' ? thread.turns : [],
        }),
      };
    if (method === 'thread/name/set') {
      thread.name = p.name;
      this.notify('thread/name/updated', { threadId: thread.id, threadName: p.name });
      return {};
    }
    if (method === 'thread/archive') {
      this.archived.add(thread.id);
      return {};
    }
    if (method === 'thread/unarchive') {
      this.archived.delete(thread.id);
      return {};
    }
    if (method === 'thread/fork') {
      const fork = this.makeThread(thread.cwd);
      fork.turns = structuredClone(thread.turns);
      fork.preview = thread.preview;
      this.notify('thread/started', { thread: fork });
      return { thread: fork };
    }
    if (method === 'turn/steer') {
      const turn = thread.turns.at(-1)!;
      const item = { id: randomUUID(), type: 'userMessage', content: p.input };
      turn.items.push(item);
      this.notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
      return { turnId: turn.id };
    }
    if (method === 'turn/interrupt') {
      const turn = thread.turns.at(-1)!;
      turn.status = 'interrupted';
      thread.status = { type: 'idle' };
      this.notify('turn/completed', { threadId: thread.id, turn });
      return {};
    }
    if (method === 'turn/start') {
      // Scenario selection follows the actual question, not quoted context or attachment metadata.
      const prompt =
        p.input
          .filter((i: Json) => i.type === 'text' && !i.text.startsWith('用户上传的文件：'))
          .at(-1)?.text || '';
      const text = p.input
        .filter((i: Json) => i.type === 'text')
        .map((i: Json) => i.text)
        .join('\n');
      thread.preview ||= text;
      thread.updatedAt = Date.now() / 1000;
      const turn = {
        id: randomUUID(),
        status: 'inProgress',
        startedAt: Date.now() / 1000,
        items: [{ id: randomUUID(), type: 'userMessage', content: p.input }] as Json[],
      };
      thread.turns.push(turn);
      thread.status = { type: 'active' };
      this.notify('turn/started', { threadId: thread.id, turn: { ...turn, items: [] } });
      this.notify('item/completed', { threadId: thread.id, turnId: turn.id, item: turn.items[0] });
      if (prompt.includes('气泡验证')) {
        const progress = {
          id: randomUUID(),
          type: 'agentMessage',
          phase: 'commentary',
          text: '我会先检查页面结构，再调整消息气泡。',
        };
        turn.items.push(progress);
        this.notify('item/completed', { threadId: thread.id, turnId: turn.id, item: progress });
      }
      const complete = () => {
        if (turn.status !== 'inProgress') return;
        if (prompt.includes('空思考验证')) {
          for (const parts of [[], ['', '   ', '\n']]) {
            const reasoning = {
              id: randomUUID(),
              type: 'reasoning',
              summary: parts,
              content: parts,
            };
            turn.items.push(reasoning);
            this.notify('item/started', { threadId: thread.id, turnId: turn.id, item: reasoning });
            this.notify('item/completed', {
              threadId: thread.id,
              turnId: turn.id,
              item: reasoning,
            });
          }
        }
        const rich = prompt.includes('界面验证');
        if (rich) {
          const diff =
            '--- a/hello.ts\n+++ b/hello.ts\n@@ -1,2 +1,2 @@\n-export const value = "old";\n+export const value = "' +
            'long_value_'.repeat(25) +
            '";\n // unchanged\n';
          const plan = [
            { step: '检查项目', status: 'completed' },
            { step: '验证修改', status: 'completed' },
          ];
          Object.assign(turn, { plan, diff });
          this.notify('turn/plan/updated', {
            threadId: thread.id,
            turnId: turn.id,
            plan,
            explanation: '逐项检查并验证结果。',
          });
          this.notify('turn/diff/updated', { threadId: thread.id, turnId: turn.id, diff });
          const reasoning = {
            id: randomUUID(),
            type: 'reasoning',
            summary: ['先检查结构，再验证行为。'],
            content: [
              '已核对目录和变更范围。\n\n```ts\nconst note = "' + 'thought_'.repeat(30) + '";\n```',
            ],
          };
          this.notify('item/started', {
            threadId: thread.id,
            turnId: turn.id,
            item: { ...reasoning, summary: [], content: [] },
          });
          this.notify('item/reasoning/summaryTextDelta', {
            threadId: thread.id,
            turnId: turn.id,
            itemId: reasoning.id,
            summaryIndex: 0,
            delta: reasoning.summary[0],
          });
          this.notify('item/reasoning/textDelta', {
            threadId: thread.id,
            turnId: turn.id,
            itemId: reasoning.id,
            contentIndex: 0,
            delta: reasoning.content[0],
          });
          const tools = [
            reasoning,
            {
              id: randomUUID(),
              type: 'commandExecution',
              command: 'node --version',
              cwd: thread.cwd,
              status: 'completed',
              exitCode: 0,
              durationMs: 1250,
              aggregatedOutput: 'v24.18.0\n' + 'output_'.repeat(45),
            },
            {
              id: randomUUID(),
              type: 'fileChange',
              status: 'completed',
              changes: [
                { path: 'src/hello.ts', kind: { type: 'update', move_path: null }, diff },
                {
                  path: 'docs/notes.md',
                  kind: { type: 'add' },
                  diff: '@@ -0,0 +1 @@\n+validated\n',
                },
              ],
            },
            { id: randomUUID(), type: 'contextCompaction' },
          ];
          for (const tool of tools) {
            turn.items.push(tool);
            this.notify('item/completed', { threadId: thread.id, turnId: turn.id, item: tool });
          }
          const previous = thread.tokenUsage?.total;
          thread.tokenUsage = {
            last: { inputTokens: 1200 },
            total: {
              inputTokens: (previous?.inputTokens || 0) + 3200,
              cachedInputTokens: (previous?.cachedInputTokens || 0) + 2400,
              outputTokens: (previous?.outputTokens || 0) + 600,
              reasoningOutputTokens: (previous?.reasoningOutputTokens || 0) + 200,
            },
            modelContextWindow: 128000,
          };
          this.notify('thread/tokenUsage/updated', {
            threadId: thread.id,
            turnId: turn.id,
            tokenUsage: thread.tokenUsage,
          });
        }
        const item = { id: randomUUID(), type: 'agentMessage', text: '' };
        turn.items.push(item);
        this.notify('item/started', {
          threadId: thread.id,
          turnId: turn.id,
          item: structuredClone(item),
        });
        const fileLinks = prompt.includes('链接验证');
        const reply = this.titleThreads.has(thread.id)
          ? '项目代码审查与问题修复方案'
          : fileLinks
            ? `[相对路径](hello.ts:1)\n\n[绝对路径](<${path.join(thread.cwd, 'hello.ts').replaceAll('\\', '/')}:1>)\n\n[文件 URI](${pathToFileURL(path.join(thread.cwd, 'hello.ts')).href}#L1)\n\n[项目目录](.)\n\n[缺失文件](missing-link.ts)\n\n[越界文件](../outside.txt)\n\n[外部网站](https://example.com/guide)\n\n[危险链接](javascript:alert(1))`
            : rich
              ? '# 检查结果\n\n**验证完成**，代码和说明如下。\n\n> 保留必要的验证信息。\n\n| 检查 | 结果 |\n| --- | --- |\n| 类型 | 通过 |\n\n```ts\nconst longValue = "' +
                'sample_'.repeat(45) +
                '";\nconsole.log(longValue);\n```\n\n- [x] 完成验证\n- [ ] 继续检查\n'
              : '已完成你的任务。';
        for (const delta of rich || fileLinks || this.titleThreads.has(thread.id)
          ? [reply.slice(0, 100), reply.slice(100)]
          : ['已完成', '你的任务。']) {
          item.text += delta;
          this.notify('item/agentMessage/delta', {
            threadId: thread.id,
            turnId: turn.id,
            itemId: item.id,
            delta,
          });
        }
        if (rich)
          Object.assign(item, {
            questions: [{ title: '接下来如何处理？', options: ['继续检查', '整理说明'] }],
          });
        this.notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
        turn.status = 'completed';
        thread.status = { type: 'idle' };
        this.notify('turn/completed', { threadId: thread.id, turn });
      };
      if (prompt.includes('审批'))
        this.later(() => {
          const id = randomUUID();
          this.callbacks.set(id, complete);
          this.emit('request', {
            id,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: thread.id,
              turnId: turn.id,
              itemId: 'command',
              command: 'Write-Output "test"',
              reason: '测试命令审批',
              cwd: thread.cwd,
            },
          });
        }, 100);
      else if (prompt.includes('提问'))
        this.later(() => {
          const id = randomUUID();
          this.callbacks.set(id, complete);
          this.emit('request', {
            id,
            method: 'item/tool/requestUserInput',
            params: {
              threadId: thread.id,
              turnId: turn.id,
              itemId: 'question',
              questions: [
                {
                  id: 'choice',
                  question: '选择部署方式',
                  options: [{ label: 'Windows', description: '原生运行' }],
                },
              ],
            },
          });
        }, 100);
      else this.later(complete, prompt.includes('慢速') ? 4500 : 300);
      return { turn: structuredClone(turn) };
    }
    throw new Error(`Unsupported mock method ${method}`);
  }
  override respond(id: string | number, result: Json) {
    this.responses.push({ id, result });
    const fn = this.callbacks.get(id);
    this.callbacks.delete(id);
    if (fn) this.later(fn, 50);
  }
  override rejectRequest() {}
  override stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.ready = false;
    this.emit('disconnect', 'Test process exited');
  }
}
