import { test, expect } from '@playwright/test';

test.afterEach(async ({ page }) => {
  await page.request.put('/api/features', {
    headers: { origin: 'http://127.0.0.1:18479' },
    data: { memory: false, collaboration: false },
  });
});

for (const width of [1280, 390, 320]) {
  test(`memory and collaboration pages work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
    await page.getByRole('button', { name: '进入工作台' }).click();
    await expect(page.getByLabel('发送给 Codex 的消息')).toBeVisible();
    const origin = 'http://127.0.0.1:18479';
    const disabled = await page.request.put('/api/features', {
      headers: { origin },
      data: { memory: false, collaboration: false },
    });
    expect(disabled.ok(), await disabled.text()).toBe(true);
    await page.reload();
    if (width < 760) await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('main', { name: '工作台设置' });
    const memorySwitch = settings.getByRole('checkbox', { name: /跨会话及项目记忆/ });
    const collaborationSwitch = settings.getByRole('checkbox', { name: /多会话及项目协作/ });
    await expect(memorySwitch).not.toBeChecked();
    await expect(collaborationSwitch).not.toBeChecked();
    await memorySwitch.click();
    await expect(memorySwitch).toBeChecked();
    await collaborationSwitch.click();
    await expect(collaborationSwitch).toBeChecked();
    await settings.getByRole('button', { name: '返回工作台' }).click();

    const projects = await (await page.request.get('/api/projects')).json();
    const threadIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await page.request.post('/api/threads', {
        headers: { origin },
        data: { projectId: projects[0].id },
      });
      expect(response.ok()).toBe(true);
      threadIds.push((await response.json()).thread.id);
    }

    if (width < 760) await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: '记忆库' }).click();
    const memories = page.getByRole('main', { name: '记忆库' });
    await expect(memories).toBeVisible();
    const memoryText = `移动布局记忆 ${width}-${Date.now()} ${'W'.repeat(120)}`;
    await memories.getByRole('textbox', { name: '记忆内容' }).fill(memoryText);
    await memories.getByRole('button', { name: '保存记忆' }).click();
    await expect(memories.getByRole('article').getByText(memoryText)).toBeVisible();
    await memories
      .getByRole('article')
      .filter({ hasText: memoryText })
      .getByRole('button', { name: '编辑', exact: true })
      .click();
    await memories.getByRole('combobox', { name: '使用范围' }).selectOption('global');
    await memories.getByRole('button', { name: '保存修改' }).click();
    await expect(
      memories
        .getByRole('article')
        .filter({ hasText: memoryText })
        .getByText('跨项目', { exact: true }),
    ).toBeVisible();
    const savedMemories = await (await page.request.get('/api/memories')).json();
    expect(
      savedMemories.find((item: { content: string }) => item.content === memoryText).projectId,
    ).toBeNull();
    expect(await memories.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    if (width < 760) await memories.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: '协作', exact: true }).click();
    const collaboration = page.getByRole('main', { name: '会话协作' });
    await expect(collaboration).toBeVisible();
    const groupName = `讨论组 ${width}-${Date.now()} ${'W'.repeat(80)}`;
    await collaboration.getByRole('textbox', { name: '名称' }).fill(groupName);
    await collaboration.getByRole('textbox', { name: '共同目标' }).fill('整理周末活动方案');
    const memberSelects = collaboration.getByRole('combobox', { name: '会话', exact: true });
    await memberSelects.nth(0).selectOption(threadIds[0]);
    await memberSelects.nth(1).selectOption(threadIds[1]);
    await collaboration.getByRole('button', { name: '保存协作组' }).click();
    await expect(collaboration.getByText(groupName, { exact: true })).toBeVisible();
    await collaboration.getByRole('textbox', { name: '本次任务' }).fill('讨论周末活动');
    await collaboration.getByRole('button', { name: '启动协作' }).click();
    await expect(collaboration.getByText('状态：已完成')).toBeVisible({ timeout: 15000 });
    expect(
      await collaboration.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/continuity-${width}.png`, animations: 'disabled' });
  });
}

test('switching collaboration groups ignores a delayed response from the previous group', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByLabel('发送给 Codex 的消息')).toBeVisible();
  const origin = 'http://127.0.0.1:18479';
  await page.request.put('/api/features', { headers: { origin }, data: { collaboration: true } });
  const projects = await (await page.request.get('/api/projects')).json();
  const members = [];
  for (let i = 0; i < 2; i++) {
    const created = await page.request.post('/api/threads', {
      headers: { origin },
      data: { projectId: projects[0].id },
    });
    members.push({ threadId: (await created.json()).thread.id, instruction: '' });
  }
  const groups = [];
  for (const suffix of ['A', 'B']) {
    const created = await page.request.post('/api/collaborations', {
      headers: { origin },
      data: { name: `切换验证 ${suffix}-${Date.now()}`, goal: '核对状态', members, maxSteps: 2 },
    });
    groups.push(await created.json());
  }
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route('**/api/collaboration-runs/*/handoffs', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/collaborations/*/runs', async (route) => {
    const first = route.request().url().includes(groups[0].id);
    if (first) {
      entered();
      await blocked;
    }
    await route.fulfill({
      json: [
        {
          id: first ? 'stale-run' : 'current-run',
          status: 'completed',
          stepsDone: first ? 1 : 2,
          stepIndex: 0,
          currentThreadId: null,
          error: null,
          updatedAt: Date.now(),
        },
      ],
    });
  });
  await page.reload();
  await page.getByRole('button', { name: '协作', exact: true }).click();
  const collaboration = page.getByRole('main', { name: '会话协作' });
  await collaboration.getByRole('button', { name: new RegExp(groups[0].name) }).click();
  await requested;
  await collaboration.getByRole('button', { name: new RegExp(groups[1].name) }).click();
  await expect(collaboration.getByRole('combobox', { name: '选择运行' })).toHaveValue(
    'current-run',
  );
  const response = page.waitForResponse((item) => item.url().includes(groups[0].id + '/runs'));
  release();
  await response;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(collaboration.getByRole('combobox', { name: '选择运行' })).toHaveValue(
    'current-run',
  );
  await expect(collaboration.getByText('已执行 1 步', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: '全部会话', exact: true }).click();
  await expect(collaboration).toHaveCount(0);
  await expect(page.getByLabel('发送给 Codex 的消息')).toBeVisible();
});
