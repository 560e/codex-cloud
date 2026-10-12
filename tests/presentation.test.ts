import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyThreadEvent } from '../shared/events.js';
import { parseDiff } from '../shared/diff.js';
import { MockCodex } from './mock-codex.js';

test('reasoning indices, command input, plans and compaction survive completion', () => {
  let thread = new MockCodex().makeThread();
  let seq = 0;
  const notify = (method: string, params: any = {}) => {
    thread = applyThreadEvent(thread, {
      seq: ++seq,
      method,
      at: 0,
      params: { threadId: thread.id, turnId: 'turn', ...params },
    });
  };
  notify('item/reasoning/summaryTextDelta', { itemId: 'reason', summaryIndex: 0, delta: 'first' });
  notify('item/reasoning/summaryPartAdded', { itemId: 'reason', summaryIndex: 1 });
  notify('item/reasoning/summaryTextDelta', { itemId: 'reason', summaryIndex: 1, delta: 'second' });
  notify('item/reasoning/textDelta', { itemId: 'reason', contentIndex: 0, delta: 'detail ' });
  notify('item/reasoning/textDelta', { itemId: 'reason', contentIndex: 0, delta: 'body' });
  assert.deepEqual(thread.turns[0].items[0].summary, ['first', 'second']);
  assert.deepEqual(thread.turns[0].items[0].content, ['detail body']);
  notify('item/commandExecution/terminalInteraction', {
    itemId: 'command',
    processId: 'process',
    stdin: 'yes\n',
  });
  notify('turn/plan/updated', {
    plan: [{ step: 'check', status: 'completed' }],
    explanation: 'verified',
  });
  notify('turn/diff/updated', { diff: '@@ -1 +1 @@\n-old\n+new' });
  notify('item/started', { item: { id: 'compact', type: 'contextCompaction' } });
  assert.equal(thread.turns[0].items.at(-1)?.workbenchStatus, 'inProgress');
  notify('item/completed', { item: { id: 'compact', type: 'contextCompaction' } });
  notify('thread/compacted');
  assert.equal(thread.turns[0].items.filter((i) => i.type === 'contextCompaction').length, 1);
  notify('turn/completed', {
    turn: {
      id: 'turn',
      status: 'completed',
      items: [
        { id: 'reason', type: 'reasoning', summary: ['canonical'], content: [] },
        { id: 'command', type: 'commandExecution', status: 'completed', exitCode: 0 },
        { id: 'compact', type: 'contextCompaction' },
      ],
    },
  });
  assert.deepEqual(thread.turns[0].items[0].summary, ['canonical']);
  assert.equal(thread.turns[0].items[1].terminalInput, 'yes\n');
  assert.equal(thread.turns[0].plan[0].step, 'check');
  assert.equal(thread.turns[0].planExplanation, 'verified');
  assert.match(thread.turns[0].diff, /\+new/);
  notify('turn/started', { turnId: 'next', turn: { id: 'next', status: 'inProgress', items: [] } });
  assert.equal(thread.turns[1].plan, undefined);
  notify('item/started', {
    turnId: 'next',
    item: { id: 'failed-compact', type: 'contextCompaction' },
  });
  notify('turn/completed', { turnId: 'next', turn: { id: 'next', status: 'failed', items: [] } });
  assert.equal(thread.turns[1].items[0].workbenchStatus, 'failed');
});

test('diff line numbers handle multiple files, empty ranges and header-like code', () => {
  const result = parseDiff(
    '--- a/a\n+++ b/a\n@@ -2,2 +2,2 @@\n--- old code\n+++ new code\n stable\n' +
      '--- /dev/null\n+++ b/b\n@@ -0,0 +1,2 @@\n+first\n+second\n\\ No newline at end of file',
  );
  assert.deepEqual(
    result.filter((l) => l.kind === 'remove'),
    [{ kind: 'remove', text: '-- old code', oldLine: 2 }],
  );
  assert.deepEqual(
    result.filter((l) => l.kind === 'add').map((l) => l.newLine),
    [2, 1, 2],
  );
  assert.deepEqual(
    result.find((l) => l.kind === 'context'),
    { kind: 'context', text: 'stable', oldLine: 3, newLine: 3 },
  );
  assert.equal(result.at(-1)?.kind, 'meta');
});

test('file diff summaries preserve operations, filenames and changed line numbers', async () => {
  const { diffFiles, diffCounts } = await import('../shared/diff.js');
  const text =
    'diff --git a/new file.txt b/new file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new file.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n' +
    'diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n' +
    'diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n@@ -10 +10 @@\n-before\n+after\n';
  const files = diffFiles(text);
  assert.deepEqual(
    files.map((file) => [file.path, file.kind?.type]),
    [
      ['new file.txt', 'add'],
      ['old.txt', 'delete'],
      ['code.ts', 'update'],
    ],
  );
  assert.deepEqual(diffCounts(text), { added: 3, removed: 2 });
  assert.equal(parseDiff(files[2].diff!).find((line) => line.kind === 'add')?.newLine, 10);
  const headerLike =
    '--- a/first.ts\n+++ b/first.ts\n@@ -2,2 +2,2 @@\n--- old code\n+++ new code\n stable\n--- /dev/null\n+++ b/second.ts\n@@ -0,0 +1 @@\n+new\n';
  assert.deepEqual(
    diffFiles(headerLike).map((file) => file.path),
    ['first.ts', 'second.ts'],
  );
});

test('partial file-change completion retains streamed patches through turn completion', () => {
  let thread = new MockCodex().makeThread();
  const changes = [
    { path: 'example.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
  ];
  const notify = (method: string, params: any) => {
    thread = applyThreadEvent(thread, {
      seq: 1,
      method,
      at: Date.now(),
      params: { threadId: thread.id, turnId: 'patch-turn', ...params },
    });
  };
  notify('item/fileChange/patchUpdated', { itemId: 'patch', changes });
  notify('item/completed', { item: { id: 'patch', type: 'fileChange', status: 'completed' } });
  assert.deepEqual(thread.turns[0].items[0].changes, changes);
  notify('turn/completed', {
    turn: {
      id: 'patch-turn',
      status: 'completed',
      items: [{ id: 'patch', type: 'fileChange', status: 'completed' }],
    },
  });
  assert.deepEqual(thread.turns[0].items[0].changes, changes);
});
