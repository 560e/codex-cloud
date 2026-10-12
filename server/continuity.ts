import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Workbench } from './workbench.js';
import { fail } from './workbench.js';
import type { Turn, WorkEvent } from '../shared/types.js';

export type CollaborationMember = { threadId: string; instruction: string; nextThreadId?: string };
export type CollaborationGroup = {
  id: string;
  name: string;
  goal: string;
  members: CollaborationMember[];
  maxSteps: number;
  createdAt: number;
  updatedAt: number;
};
type Run = {
  id: string;
  groupId: string;
  status: string;
  stepIndex: number;
  stepsDone: number;
  nextInput: string;
  currentThreadId: string | null;
  currentTurnId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export class Continuity {
  private disposed = false;
  private submissions = new Map<string, symbol>();
  private readonly onEvent = (event: WorkEvent) => {
    if (event.method === 'workbench/disconnected') {
      this.store.db.exec(
        "UPDATE collaboration_runs SET status='paused',error='执行器连接已断开，请核对会话历史后继续',updated_at=unixepoch()*1000 WHERE status IN ('ready','starting','running')",
      );
      this.changed();
      return;
    }
    if (event.method !== 'turn/completed' || !event.params.turn || !event.params.threadId) return;
    const turnId = event.params.turn.id;
    const rows = this.store.db
      .prepare(
        "SELECT id,status FROM collaboration_runs WHERE status IN ('running','stopping') AND current_thread_id=? AND current_turn_id=?",
      )
      .all(event.params.threadId, event.params.turn.id);
    for (const row of rows) {
      if (row.status === 'stopping') this.markCancelled(String(row.id));
      else
        void this.complete(String(row.id), event.params.turn).catch((error) => {
          if (this.disposed) return;
          const current = this.store.db
            .prepare('SELECT status,current_turn_id FROM collaboration_runs WHERE id=?')
            .get(row.id);
          if (current?.status === 'running' && current.current_turn_id === turnId)
            this.pause(String(row.id), (error as Error).message);
        });
    }
  };

  constructor(
    private store: Store,
    private workbench: Workbench,
  ) {
    this.store.db.exec(
      "UPDATE collaboration_runs SET status='paused',error=CASE WHEN status='stopping' THEN '停止结果待核对，请再次结束运行' ELSE '服务已重启，请核对会话历史后继续' END WHERE status IN ('ready','starting','running','stopping')",
    );
    workbench.on('event', this.onEvent);
  }
  dispose() {
    this.disposed = true;
    this.workbench.off('event', this.onEvent);
  }
  settings() {
    return {
      memory: this.store.get('feature:memory') === 'true',
      collaboration: this.store.get('feature:collaboration') === 'true',
    };
  }
  setFeature(feature: 'memory' | 'collaboration', enabled: boolean) {
    this.store.set(`feature:${feature}`, String(enabled));
    if (feature === 'collaboration' && !enabled)
      this.store.db.exec(
        "UPDATE collaboration_runs SET status='paused',error='协作功能已关闭',updated_at=unixepoch()*1000 WHERE status IN ('ready','starting','running')",
      );
    this.workbench.publish('workbench/featuresChanged', this.settings());
    return this.settings();
  }
  requireFeature(feature: 'memory' | 'collaboration') {
    if (!this.settings()[feature])
      throw fail(`${feature === 'memory' ? '跨对话记忆' : '多会话协同'}尚未在设置中开启`, 409);
  }
  memories(projectId?: string) {
    this.requireFeature('memory');
    return this.store.db
      .prepare(
        `SELECT id,project_id AS projectId,content,source_thread_id AS sourceThreadId,
        enabled,created_at AS createdAt,updated_at AS updatedAt FROM memories
        WHERE (? IS NULL OR project_id=? OR project_id IS NULL) ORDER BY updated_at DESC LIMIT 500`,
      )
      .all(projectId ?? null, projectId ?? null);
  }
  addMemory(projectId: string | null, content: string, sourceThreadId: string | null = null) {
    this.requireFeature('memory');
    if (projectId && !this.store.projects().some((p) => p.id === projectId))
      throw fail('项目不存在', 404);
    const id = randomUUID();
    const now = Date.now();
    this.store.db
      .prepare('INSERT INTO memories VALUES(?,?,?,?,1,?,?)')
      .run(id, projectId, content, sourceThreadId, now, now);
    this.workbench.publish('workbench/memoriesChanged', {});
    return this.memory(id);
  }
  memory(id: string) {
    return this.store.db
      .prepare(
        'SELECT id,project_id AS projectId,content,source_thread_id AS sourceThreadId,enabled,created_at AS createdAt,updated_at AS updatedAt FROM memories WHERE id=?',
      )
      .get(id);
  }
  updateMemory(
    id: string,
    input: { content?: string; enabled?: boolean; projectId?: string | null },
  ) {
    this.requireFeature('memory');
    if (!this.memory(id)) throw fail('记忆不存在', 404);
    if (input.projectId && !this.store.projects().some((p) => p.id === input.projectId))
      throw fail('项目不存在', 404);
    this.store.db
      .prepare(
        'UPDATE memories SET content=COALESCE(?,content),enabled=COALESCE(?,enabled),project_id=CASE WHEN ? THEN ? ELSE project_id END,updated_at=? WHERE id=?',
      )
      .run(
        input.content ?? null,
        input.enabled === undefined ? null : +input.enabled,
        +(input.projectId !== undefined),
        input.projectId ?? null,
        Date.now(),
        id,
      );
    this.workbench.publish('workbench/memoriesChanged', {});
    return this.memory(id);
  }
  deleteMemory(id: string) {
    this.requireFeature('memory');
    if (!this.store.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes)
      throw fail('记忆不存在', 404);
    this.workbench.publish('workbench/memoriesChanged', {});
    return { ok: true };
  }
  relevantMemories(cwd: string, query: string) {
    if (!this.settings().memory) return [];
    const project = this.store.projectForDirectory(cwd);
    if (!project) return [];
    const terms = [
      ...new Set(
        (query.toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/gu) || [])
          .flatMap((word) =>
            /^[\p{Script=Han}]+$/u.test(word) && word.length > 2
              ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))
              : [word],
          )
          .slice(0, 40),
      ),
    ];
    const rows = this.store.db
      .prepare(
        'SELECT id,content FROM memories WHERE enabled=1 AND (project_id=? OR project_id IS NULL) ORDER BY updated_at DESC LIMIT 200',
      )
      .all(project.id) as { id: string; content: string }[];
    const ranked = rows
      .map((row) => ({
        ...row,
        score: terms.filter((term) => row.content.toLowerCase().includes(term)).length,
      }))
      .filter((row) => !terms.length || row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    let remaining = 4000;
    return ranked.flatMap((row) => {
      if (row.content.length > remaining) return [];
      remaining -= row.content.length + 1;
      return [row];
    });
  }
  recordMemoryUse(threadId: string, turnId: string, ids: string[]) {
    if (!ids.length) return;
    this.store.db
      .prepare('INSERT OR REPLACE INTO memory_uses VALUES(?,?,?)')
      .run(threadId, turnId, JSON.stringify(ids));
  }
  memoryUse(threadId: string, turnId: string) {
    this.requireFeature('memory');
    const row = this.store.db
      .prepare('SELECT memory_ids FROM memory_uses WHERE thread_id=? AND turn_id=?')
      .get(threadId, turnId);
    return row ? JSON.parse(String(row.memory_ids)) : [];
  }
  groups(): CollaborationGroup[] {
    this.requireFeature('collaboration');
    return this.store.db
      .prepare('SELECT * FROM collaboration_groups ORDER BY updated_at DESC')
      .all()
      .map((row) => this.groupRow(row));
  }
  private groupRow(row: Record<string, unknown>): CollaborationGroup {
    return {
      id: String(row.id),
      name: String(row.name),
      goal: String(row.goal),
      members: JSON.parse(String(row.members)),
      maxSteps: Number(row.max_steps),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  group(id: string) {
    this.requireFeature('collaboration');
    const row = this.store.db.prepare('SELECT * FROM collaboration_groups WHERE id=?').get(id);
    if (!row) throw fail('协作组不存在', 404);
    return this.groupRow(row);
  }
  async validateMembers(members: CollaborationMember[]) {
    if (new Set(members.map((m) => m.threadId)).size !== members.length)
      throw fail('同一会话只能在协作组中出现一次');
    if (
      members.some(
        (member) =>
          member.nextThreadId && !members.some((other) => other.threadId === member.nextThreadId),
      )
    )
      throw fail('交接目标必须是协作组中的会话');
    for (const member of members) {
      const cwd = await this.workbench.threadDirectory(member.threadId);
      if (!this.store.projectForDirectory(cwd)) throw fail('参与会话所属项目已移除', 409);
    }
  }
  async saveGroup(input: Omit<CollaborationGroup, 'id' | 'createdAt' | 'updatedAt'>, id?: string) {
    this.requireFeature('collaboration');
    await this.validateMembers(input.members);
    this.requireFeature('collaboration');
    const now = Date.now();
    if (id) {
      this.group(id);
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM collaboration_runs WHERE group_id=? AND status IN ('ready','starting','running','paused','stopping')",
          )
          .get(id)
      )
        throw fail('协作组有未结束运行，请先结束运行后编辑', 409);
      this.store.db
        .prepare(
          'UPDATE collaboration_groups SET name=?,goal=?,members=?,max_steps=?,updated_at=? WHERE id=?',
        )
        .run(input.name, input.goal, JSON.stringify(input.members), input.maxSteps, now, id);
    } else {
      id = randomUUID();
      this.store.db
        .prepare('INSERT INTO collaboration_groups VALUES(?,?,?,?,?,?,?)')
        .run(id, input.name, input.goal, JSON.stringify(input.members), input.maxSteps, now, now);
    }
    this.workbench.publish('workbench/collaborationChanged', {});
    return this.group(id);
  }
  deleteGroup(id: string) {
    this.group(id);
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM collaboration_runs WHERE group_id=? AND status IN ('ready','starting','running','paused','stopping')",
        )
        .get(id)
    )
      throw fail('请先结束协作运行', 409);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db
        .prepare(
          'DELETE FROM collaboration_handoffs WHERE run_id IN (SELECT id FROM collaboration_runs WHERE group_id=?)',
        )
        .run(id);
      this.store.db.prepare('DELETE FROM collaboration_runs WHERE group_id=?').run(id);
      this.store.db.prepare('DELETE FROM collaboration_groups WHERE id=?').run(id);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.workbench.publish('workbench/collaborationChanged', {});
    return { ok: true };
  }
  private runRow(row: Record<string, unknown>): Run {
    return {
      id: String(row.id),
      groupId: String(row.group_id),
      status: String(row.status),
      stepIndex: Number(row.step_index),
      stepsDone: Number(row.steps_done),
      nextInput: String(row.next_input),
      currentThreadId: row.current_thread_id ? String(row.current_thread_id) : null,
      currentTurnId: row.current_turn_id ? String(row.current_turn_id) : null,
      error: row.error ? String(row.error) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  run(id: string): Run {
    this.requireFeature('collaboration');
    const row = this.store.db.prepare('SELECT * FROM collaboration_runs WHERE id=?').get(id);
    if (!row) throw fail('运行不存在', 404);
    return this.runRow(row);
  }
  runs(groupId: string) {
    this.group(groupId);
    return this.store.db
      .prepare(
        'SELECT * FROM collaboration_runs WHERE group_id=? ORDER BY created_at DESC LIMIT 100',
      )
      .all(groupId)
      .map((row) => this.runRow(row));
  }
  handoffs(runId: string) {
    this.run(runId);
    return this.store.db
      .prepare('SELECT * FROM collaboration_handoffs WHERE run_id=? ORDER BY created_at,step_index')
      .all(runId);
  }
  assertSubmit(threadId: string, runId?: string) {
    if (runId) {
      const run = this.run(runId);
      if (run.status !== 'starting' || run.currentThreadId !== threadId)
        throw fail('协作已暂停或结束，本轮尚未提交', 409);
    }
    const rows = this.store.db
      .prepare(
        "SELECT id,group_id FROM collaboration_runs WHERE status IN ('ready','starting','running','stopping')",
      )
      .all();
    for (const row of rows) {
      const members = this.groupRow(
        this.store.db.prepare('SELECT * FROM collaboration_groups WHERE id=?').get(row.group_id)!,
      ).members;
      if (members.some((m) => m.threadId === threadId) && row.id !== runId)
        throw fail('会话正在参与协作运行，请先暂停或结束协作', 409);
    }
  }
  async start(groupId: string, prompt: string) {
    const group = this.group(groupId);
    await this.validateMembers(group.members);
    if (JSON.stringify(this.group(groupId)) !== JSON.stringify(group))
      throw fail('协作组已更新，请重新启动', 409);
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM collaboration_runs WHERE group_id=? AND status NOT IN ('completed','cancelled')",
        )
        .get(groupId)
    )
      throw fail('协作组已有未结束运行，请继续或结束原运行', 409);
    for (const member of group.members) {
      this.assertSubmit(member.threadId);
      if (
        this.workbench.active.has(member.threadId) ||
        this.workbench.hasPendingOperation(member.threadId) ||
        this.store.publicQueue().some((q) => q.threadId === member.threadId)
      )
        throw fail('参与会话正在运行或有排队消息，请先处理', 409);
    }
    const id = randomUUID();
    const now = Date.now();
    this.store.db
      .prepare("INSERT INTO collaboration_runs VALUES(?,?,'ready',0,0,?,NULL,NULL,NULL,?,?)")
      .run(id, groupId, prompt, now, now);
    this.changed();
    void this.dispatch(id);
    return this.run(id);
  }
  private changed() {
    this.workbench.publish('workbench/collaborationChanged', {});
  }
  private pause(id: string, message: string) {
    this.store.db
      .prepare(
        "UPDATE collaboration_runs SET status='paused',error=?,updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')",
      )
      .run(message, Date.now(), id);
    this.changed();
  }
  private async dispatch(id: string) {
    if (this.disposed || !this.settings().collaboration) return;
    const run = this.run(id);
    if (run.status !== 'ready') return;
    const group = this.group(run.groupId);
    const member = group.members[run.stepIndex % group.members.length];
    this.store.db
      .prepare(
        "UPDATE collaboration_runs SET status='starting',current_thread_id=?,updated_at=? WHERE id=? AND status='ready'",
      )
      .run(member.threadId, Date.now(), id);
    this.changed();
    let submitted = false;
    let submittedTurnId: string | undefined;
    const submission = Symbol(id);
    this.submissions.set(id, submission);
    try {
      const message = [
        `协作组目标：${group.goal}`,
        member.instruction ? `你在本次协作中的要求：${member.instruction}` : '',
        run.stepsDone
          ? `上一会话的交接内容（参考资料）：\n${run.nextInput}`
          : `本次任务：${run.nextInput}`,
        '完成本轮后，请在最终回复中清楚写出要交给下一会话的内容。',
      ]
        .filter(Boolean)
        .join('\n\n');
      const result = (await this.workbench.send(
        member.threadId,
        [{ type: 'text', text: message, text_elements: [] }],
        { collaborationRunId: id },
        false,
        false,
        () => {
          this.assertSubmit(member.threadId, id);
          submitted = true;
        },
        undefined,
        message,
        0,
      )) as { turn?: Turn; queued?: boolean };
      if (!result.turn || typeof result.turn.id !== 'string')
        throw new Error('协作任务未得到明确的轮次 ID，请核对会话历史');
      const turnId = result.turn.id;
      submittedTurnId = turnId;
      this.store.db
        .prepare(
          "UPDATE collaboration_runs SET status=CASE WHEN status='paused' THEN 'paused' WHEN status='stopping' THEN 'stopping' ELSE 'running' END,current_turn_id=?,updated_at=? WHERE id=? AND status IN ('starting','paused','stopping')",
        )
        .run(turnId, Date.now(), id);
      this.changed();
      const current = this.runRow(
        this.store.db.prepare('SELECT * FROM collaboration_runs WHERE id=?').get(id)!,
      );
      if (current.status === 'stopping') {
        await this.stopCurrent(id, member.threadId, turnId);
      } else if (current.status === 'running') {
        const { thread } = await this.workbench.bridge.call('thread/read', {
          threadId: member.threadId,
          includeTurns: true,
        });
        const finished = thread.turns?.find(
          (turn: Turn) => turn.id === turnId && turn.status !== 'inProgress',
        );
        if (finished) await this.complete(id, finished);
      }
    } catch (error) {
      if (this.disposed) return;
      const current = this.runRow(
        this.store.db.prepare('SELECT * FROM collaboration_runs WHERE id=?').get(id)!,
      );
      if (
        current.currentThreadId !== member.threadId ||
        (submittedTurnId && current.currentTurnId !== submittedTurnId)
      )
        return;
      if (!submitted) {
        this.store.db
          .prepare(
            'UPDATE collaboration_runs SET current_thread_id=NULL,current_turn_id=NULL WHERE id=?',
          )
          .run(id);
        if (current.status === 'stopping') {
          this.markCancelled(id);
          return;
        }
      }
      this.pause(
        id,
        `${submitted ? '发送状态待核对' : '本轮尚未提交'}：${(error as Error).message}`,
      );
    } finally {
      if (this.submissions.get(id) === submission) this.submissions.delete(id);
    }
  }
  private async complete(id: string, turn: Turn) {
    let run = this.run(id);
    if (run.status !== 'running' || run.currentTurnId !== turn.id) return;
    if (turn.status !== 'completed')
      return this.pause(id, '本轮中断或失败；请核对已执行的操作，点击“继续”将重新提交本步');
    const finalReply = (value: Turn) => {
      const messages = value.items.filter((item) => item.type === 'agentMessage' && item.text);
      const finals = messages.filter((item) => item.phase === 'final_answer');
      return (finals.length ? finals : messages.filter((item) => !item.phase))
        .map((item) => item.text)
        .join('\n\n')
        .slice(-6000);
    };
    let reply = finalReply(this.workbench.cachedTurn(run.currentThreadId!, turn.id) || turn);
    if (!reply.trim()) {
      const { thread } = await this.workbench.bridge.call('thread/read', {
        threadId: run.currentThreadId,
        includeTurns: true,
      });
      const saved = thread.turns?.find((item: Turn) => item.id === turn.id);
      if (saved) reply = finalReply(saved);
      if (this.disposed || !this.settings().collaboration) return;
      run = this.run(id);
      if (run.status !== 'running' || run.currentTurnId !== turn.id) return;
    }
    if (!reply.trim()) return this.pause(id, '本轮没有可交接的最终回复');
    const group = this.group(run.groupId);
    const next = run.stepsDone + 1;
    const source = group.members[run.stepIndex % group.members.length];
    const nextIndex = source.nextThreadId
      ? group.members.findIndex((member) => member.threadId === source.nextThreadId)
      : (run.stepIndex + 1) % group.members.length;
    const target = next < group.maxSteps ? group.members[nextIndex].threadId : null;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db
        .prepare('INSERT OR IGNORE INTO collaboration_handoffs VALUES(?,?,?,?,?,?,?,?)')
        .run(
          randomUUID(),
          id,
          run.stepsDone,
          run.currentThreadId,
          turn.id,
          target,
          reply,
          Date.now(),
        );
      this.store.db
        .prepare(
          "UPDATE collaboration_runs SET status=?,step_index=?,steps_done=?,next_input=?,current_thread_id=NULL,current_turn_id=NULL,error=NULL,updated_at=? WHERE id=? AND status='running' AND current_turn_id=?",
        )
        .run(target ? 'ready' : 'completed', nextIndex, next, reply, Date.now(), id, turn.id);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.changed();
    if (target) setImmediate(() => void this.dispatch(id));
  }
  private markCancelled(id: string) {
    this.store.db
      .prepare(
        "UPDATE collaboration_runs SET status='cancelled',error=NULL,updated_at=? WHERE id=? AND status='stopping'",
      )
      .run(Date.now(), id);
    this.changed();
  }
  private async stopCurrent(id: string, threadId: string, turnId: string) {
    try {
      const { thread } = await this.workbench.bridge.call('thread/read', {
        threadId,
        includeTurns: true,
      });
      const turn = thread.turns?.find((item: Turn) => item.id === turnId);
      if (turn?.status && turn.status !== 'inProgress') {
        this.markCancelled(id);
        return;
      }
      if (!turn) throw fail('原轮次状态不明，请核对会话历史', 409);
      await this.workbench.bridge.call('turn/interrupt', { threadId, turnId });
    } catch (error) {
      this.store.db
        .prepare(
          "UPDATE collaboration_runs SET error=?,updated_at=? WHERE id=? AND status='stopping'",
        )
        .run(`停止尚未确认：${(error as Error).message}`, Date.now(), id);
      this.changed();
    }
  }
  async action(id: string, action: 'pause' | 'resume' | 'stop') {
    const run = this.run(id);
    if (action === 'stop') {
      if (['completed', 'cancelled'].includes(run.status)) throw fail('运行已经结束', 409);
      const pending = this.submissions.has(id);
      this.store.db
        .prepare('UPDATE collaboration_runs SET status=?,updated_at=? WHERE id=?')
        .run(run.currentTurnId || pending ? 'stopping' : 'cancelled', Date.now(), id);
      if (run.currentThreadId && !run.currentTurnId && !pending)
        this.store.db
          .prepare('UPDATE collaboration_runs SET error=? WHERE id=?')
          .run('自动交接已结束，提交结果仍需在原会话历史中核对。', id);
      this.changed();
      if (run.currentTurnId && run.currentThreadId)
        await this.stopCurrent(id, run.currentThreadId, run.currentTurnId);
    } else if (action === 'pause') {
      if (!['ready', 'starting', 'running'].includes(run.status))
        throw fail('当前状态无法暂停', 409);
      this.pause(id, '用户已暂停协作');
    } else if (run.status === 'paused') {
      if (run.error?.includes('停止')) throw fail('停止结果待核对，请再次结束运行', 409);
      const group = this.group(run.groupId);
      const ensureAvailable = () => {
        this.requireFeature('collaboration');
        if (this.run(id).status !== 'paused') throw fail('运行状态已变化，请刷新后重试', 409);
        for (const member of group.members) {
          this.assertSubmit(member.threadId);
          const active = this.workbench.active.get(member.threadId);
          if (
            this.workbench.hasPendingOperation(member.threadId) ||
            (active &&
              (member.threadId !== run.currentThreadId || active.turnId !== run.currentTurnId))
          )
            throw fail('参与会话正在处理其他任务，请等待完成', 409);
        }
        if (
          this.store
            .publicQueue()
            .some((row) => group.members.some((member) => member.threadId === row.threadId))
        )
          throw fail('参与会话有排队消息，请先处理再继续协作', 409);
      };
      ensureAvailable();
      if (run.currentTurnId && run.currentThreadId) {
        const { thread } = await this.workbench.bridge.call('thread/read', {
          threadId: run.currentThreadId,
          includeTurns: true,
        });
        const turn = thread.turns?.find((item: Turn) => item.id === run.currentTurnId);
        if (!turn) throw fail('原轮次状态不明，请核对历史', 409);
        ensureAvailable();
        if (turn.status === 'failed' || turn.status === 'interrupted') {
          // The user explicitly resumed a confirmed terminal turn. Retry the same
          // step/input; uncertain submissions must retain their original IDs.
          this.store.db
            .prepare(
              "UPDATE collaboration_runs SET status='ready',current_thread_id=NULL,current_turn_id=NULL,error=NULL,updated_at=? WHERE id=? AND status='paused'",
            )
            .run(Date.now(), id);
          this.changed();
          void this.dispatch(id);
          return this.run(id);
        }
        if (turn.status !== 'inProgress' && turn.status !== 'completed')
          throw fail('原轮次状态不明，请核对会话历史', 409);
        this.store.db
          .prepare(
            "UPDATE collaboration_runs SET status='running',error=NULL,updated_at=? WHERE id=? AND status='paused'",
          )
          .run(Date.now(), id);
        if (turn.status !== 'inProgress') await this.complete(id, turn);
      } else if (run.currentThreadId) {
        throw fail('提交状态不明，请核对会话历史后手动结束运行', 409);
      } else {
        this.store.db
          .prepare(
            "UPDATE collaboration_runs SET status='ready',error=NULL,updated_at=? WHERE id=?",
          )
          .run(Date.now(), id);
        void this.dispatch(id);
      }
      this.changed();
    } else throw fail('当前状态无法执行此操作', 409);
    return this.run(id);
  }
}
