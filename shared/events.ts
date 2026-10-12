import type { Thread, WorkEvent, Turn, Item } from './types.js';
export function applyThreadEvent(current: Thread, event: WorkEvent): Thread {
  const p = event.params;
  const method = event.method;
  if (
    method !== 'workbench/disconnected' &&
    p.threadId !== current.id &&
    p.thread?.id !== current.id
  )
    return current;
  if (method === 'thread/status/changed')
    return p.status ? { ...current, status: p.status } : current;
  if (method === 'thread/name/updated') return { ...current, name: p.threadName ?? p.name };
  if (method === 'workbench/turnModelUpdated') {
    return {
      ...current,
      turns: current.turns.map((turn) =>
        turn.id === p.turnId && typeof p.model === 'string' ? { ...turn, model: p.model } : turn,
      ),
    };
  }
  if (method === 'workbench/balanceUpdated') {
    return {
      ...current,
      turns: current.turns.map((turn) =>
        turn.id === p.turnId && p.upstreamBalance
          ? { ...turn, upstreamBalance: p.upstreamBalance }
          : turn,
      ),
    };
  }
  if (method === 'thread/tokenUsage/updated') {
    const turnId = p.turnId || current.turns.at(-1)?.id;
    return {
      ...current,
      tokenUsage: p.tokenUsage,
      turns: p.turnTokenUsage
        ? current.turns.map((turn) =>
            turn.id === turnId
              ? { ...turn, tokenUsage: p.turnTokenUsage, tokenUsagePartial: p.tokenUsagePartial }
              : turn,
          )
        : current.turns,
    };
  }
  if (
    method === 'workbench/disconnected' &&
    !current.turns.some((turn) => turn.status === 'inProgress') &&
    current.status.type !== 'active'
  )
    return current;
  if (method === 'workbench/disconnected')
    return {
      ...current,
      status: { type: 'idle' },
      interrupted: true,
      turns: current.turns.map((turn) =>
        turn.status === 'inProgress'
          ? {
              ...turn,
              status: 'interrupted',
              completedAt: event.at / 1000,
              durationMs:
                typeof turn.startedAt === 'number'
                  ? Math.max(0, event.at - turn.startedAt * 1000)
                  : null,
            }
          : turn,
      ),
    };
  // Unhandled notifications must not rebuild history or fabricate empty turns.
  if (
    ![
      'turn/started',
      'turn/completed',
      'item/started',
      'item/completed',
      'error',
      'item/fileChange/patchUpdated',
      'turn/diff/updated',
      'turn/plan/updated',
      'thread/compacted',
      'item/reasoning/summaryTextDelta',
      'item/reasoning/textDelta',
      'item/reasoning/summaryPartAdded',
      'item/commandExecution/terminalInteraction',
    ].includes(method) &&
    !method.endsWith('/delta') &&
    !method.endsWith('/outputDelta')
  )
    return current;
  const turnId = p.turnId || p.turn?.id;
  if (!turnId) return current;
  const turns = [...(current.turns || [])];
  let index = turns.findIndex((t) => t.id === turnId);
  if (index < 0) {
    index = turns.length;
    turns.push({ id: turnId, status: 'inProgress', items: [] });
  }
  let turn: Turn = { ...turns[index], items: [...turns[index].items] };
  if (method === 'turn/started' || method === 'turn/completed') {
    const incoming = p.turn;
    if (!incoming) return current;
    // Turn notifications can contain only a subset of the items already streamed.
    // Replace matching items canonically without dropping user messages or tools.
    const items = new Map(turn.items.map((item) => [item.id, item]));
    for (const item of incoming.items || []) {
      const previous = items.get(item.id);
      items.set(
        item.id,
        item.type === 'fileChange' && previous?.changes && !item.changes
          ? { ...item, changes: previous.changes }
          : item,
      );
    }
    turn = { ...turn, ...incoming, items: [...items.values()] };
    if (method === 'turn/completed')
      turn.items = turn.items.map((item) => {
        const previous = turns[index].items.find((old) => old.id === item.id);
        return {
          ...item,
          workbenchStatus:
            previous?.workbenchStatus === 'completed'
              ? 'completed'
              : incoming.status === 'interrupted'
                ? 'interrupted'
                : incoming.status === 'failed'
                  ? 'failed'
                  : 'completed',
          ...(previous?.terminalInput ? { terminalInput: previous.terminalInput } : {}),
        };
      });
  } else if (method === 'item/started' || method === 'item/completed') {
    const incoming = p.item;
    if (!incoming) return current;
    const i = turn.items.findIndex((item) => item.id === incoming.id);
    const item = {
      ...incoming,
      workbenchStatus: method === 'item/started' ? 'inProgress' : 'completed',
    };
    if (i < 0) turn.items.push(item);
    else
      turn.items[i] = {
        ...item,
        ...(item.type === 'fileChange' && !item.changes && turn.items[i].changes
          ? { changes: turn.items[i].changes }
          : {}),
        ...(turn.items[i].terminalInput ? { terminalInput: turn.items[i].terminalInput } : {}),
      };
  } else if (
    p.itemId &&
    (method.endsWith('/delta') ||
      method.endsWith('/outputDelta') ||
      method.startsWith('item/reasoning/') ||
      method === 'item/commandExecution/terminalInteraction' ||
      method === 'item/fileChange/patchUpdated')
  ) {
    let i = turn.items.findIndex((item) => item.id === p.itemId);
    if (i < 0) {
      i = turn.items.length;
      turn.items.push({
        id: p.itemId,
        type: method.includes('commandExecution')
          ? 'commandExecution'
          : method.includes('reasoning')
            ? 'reasoning'
            : method.includes('/plan/')
              ? 'plan'
              : method.includes('fileChange')
                ? 'fileChange'
                : 'agentMessage',
      });
    }
    const item: Item = { ...turn.items[i] };
    item.workbenchStatus = 'inProgress';
    if (method.includes('reasoning')) {
      const field = method === 'item/reasoning/textDelta' ? 'content' : 'summary';
      const parts = (item[field] || []).filter((part): part is string => typeof part === 'string');
      const part = field === 'content' ? (p.contentIndex ?? 0) : (p.summaryIndex ?? 0);
      parts[part] = (parts[part] || '') + (p.delta || '');
      item[field] = parts;
    } else if (method === 'item/commandExecution/terminalInteraction') {
      item.terminalInput = (item.terminalInput || '') + (p.stdin || '');
      item.processId = p.processId;
    } else if (method.includes('outputDelta'))
      item.aggregatedOutput = (item.aggregatedOutput || '') + (p.delta || '');
    else if (method === 'item/fileChange/patchUpdated') item.changes = p.changes;
    else item.text = (item.text || '') + (p.delta || '');
    turn.items[i] = item;
  } else if (method === 'error') turn.error = p.error;
  else if (method === 'turn/plan/updated') {
    turn.plan = p.plan;
    turn.planExplanation = p.explanation;
  } else if (method === 'turn/diff/updated') turn.diff = p.diff;
  else if (method === 'thread/compacted') {
    const i = turn.items.findIndex((item) => item.type === 'contextCompaction');
    if (i >= 0) turn.items[i] = { ...turn.items[i], workbenchStatus: 'completed' };
    else
      turn.items.push({
        id: `compaction-${turnId}`,
        type: 'contextCompaction',
        workbenchStatus: 'completed',
      });
  }
  turns[index] = turn;
  return {
    ...current,
    turns,
    ...(method === 'turn/diff/updated' ? { latestDiff: p.diff } : {}),
    ...(method === 'turn/plan/updated' ? { plan: p.plan } : {}),
    ...(method === 'turn/started' ? { status: { type: 'active' }, interrupted: false } : {}),
    ...(method === 'turn/completed' ? { status: { type: 'idle' } } : {}),
  };
}

export function overlayLive(thread: Thread, live?: Thread): Thread {
  if (!live) return thread;
  const turns = [...thread.turns];
  for (const lt of live.turns) {
    const i = turns.findIndex((t) => t.id === lt.id);
    if (i < 0) turns.push(lt);
    else {
      const items = new Map(turns[i].items.map((item) => [item.id, item]));
      for (const item of lt.items) items.set(item.id, item);
      turns[i] = { ...turns[i], ...lt, items: [...items.values()] };
    }
  }
  return {
    ...thread,
    turns,
    latestDiff: live.latestDiff,
    plan: live.plan,
    tokenUsage: live.tokenUsage,
  };
}
