import { test, expect } from '@playwright/test';

test('long history renders in pages, fetches once per selection and rejects stale selections', async ({
  page,
}) => {
  const makeThread = (id: string) => ({
    id,
    name: id,
    preview: '',
    cwd: 'D:\\test',
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    turns: Array.from({ length: 60 }, (_, i) => ({
      id: `${id}-${i}`,
      status: 'completed',
      items: [
        {
          id: `user-${i}`,
          type: 'userMessage',
          content: [{ type: 'text', text: `question ${i}` }],
        },
        {
          id: `answer-${i}`,
          type: 'agentMessage',
          text: `**${id} reply ${i}**\n\n` + '```ts\nconst value = 1;\n```\n'.repeat(8),
        },
        {
          id: `tool-${i}`,
          type: 'commandExecution',
          command: 'test-command',
          status: 'completed',
          aggregatedOutput: 'DEFERRED_TOOL_OUTPUT',
        },
      ],
    })),
  });
  const first = makeThread('performance-first');
  const second = makeThread('performance-second');
  const reads: string[] = [];
  await page.route('**/api/threads?*', (route) =>
    route.fulfill({
      json: {
        data: [first, second].map((t) => ({ ...t, turns: [] })),
        nextCursor: null,
      },
    }),
  );
  await page.route('**/api/threads/performance-*', async (route) => {
    const isFirst = route.request().url().endsWith(first.id);
    reads.push(isFirst ? first.id : second.id);
    if (isFirst) await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      json: { thread: isFirst ? first : second, cursor: 0, nextCursor: null },
    });
  });
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.locator('.thread-entry').filter({ hasText: first.id }).click();
  await expect(page.locator('.turn')).toHaveCount(12);
  expect(reads).toEqual([first.id]);
  await expect(page.getByText('DEFERRED_TOOL_OUTPUT', { exact: true })).toHaveCount(0);
  await page.locator('.turn').last().locator('.tool-card summary').click();
  await expect(page.getByText('DEFERRED_TOOL_OUTPUT', { exact: true })).toBeVisible();
  await page.getByLabel('发送给 Codex 的消息').fill('typing while viewing a long history');
  await page.getByRole('button', { name: '加载更早的消息' }).click();
  await expect(page.locator('.turn')).toHaveCount(24);
  expect(reads).toEqual([first.id]);
  await page.locator('.thread-entry').filter({ hasText: second.id }).click();
  await expect(page.locator('.turn')).toHaveCount(12);
  await expect(page.getByText(`${second.id} reply 59`, { exact: true })).toBeVisible();
  await page.locator('.thread-entry').filter({ hasText: first.id }).click();
  await expect.poll(() => reads.length).toBe(3);
  await page.locator('.thread-entry').filter({ hasText: second.id }).click();
  await expect.poll(() => reads.length).toBe(4);
  await expect(page.getByText(`${second.id} reply 59`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${first.id} reply 59`, { exact: true })).toHaveCount(0);
});
