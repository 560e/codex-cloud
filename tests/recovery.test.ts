import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDirectory } from '../shared/project-directory.js';
import { applyThreadEvent } from '../shared/events.js';
import type { Thread } from '../shared/types.js';

test('project subdirectories remain under Linux or Windows roots regardless of browser OS', () => {
  assert.equal(projectDirectory('/srv/projects', '课程/my-app'), '/srv/projects/课程/my-app');
  assert.equal(projectDirectory('/srv/projects/', ''), '/srv/projects/');
  assert.equal(projectDirectory('D:\\Projects', 'course/app'), 'D:\\Projects\\course\\app');
  for (const child of ['../secret', '/etc', 'D:\\secret', 'app/../../secret', './app', '\\etc'])
    assert.throws(() => projectDirectory('/srv/projects', child));
});
test('executor disconnect stops the displayed timer and marks only active conversations interrupted', () => {
  const thread = {
    id: 'thread',
    status: { type: 'active' },
    turns: [{ id: 'turn', status: 'inProgress', startedAt: 100, items: [] }],
  } as Thread;
  const event = {
    seq: 1,
    at: 104000,
    method: 'workbench/disconnected',
    params: { message: 'process exited' },
  };
  const next = applyThreadEvent(thread, event);
  assert.equal(next.interrupted, true);
  assert.equal(next.turns[0].status, 'interrupted');
  assert.equal(next.turns[0].durationMs, 4000);
  const idle = {
    ...thread,
    status: { type: 'idle' },
    turns: [{ ...thread.turns[0], status: 'completed' }],
  };
  assert.equal(applyThreadEvent(idle, event), idle);
});
