import { test, expect, type Page } from '@playwright/test';

test.afterEach(async ({ context }, info) => {
  if (info.status !== info.expectedStatus)
    await context.request.post('/api/runtime/force-stop', {
      headers: { origin: 'http://127.0.0.1:18479' },
      data: {},
    });
});

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByText('今天，想完成什么？')).toBeVisible();
}

test('custom model and reference card keep question separate from quoted context', async ({
  page,
}) => {
  await login(page);
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  await model.click();
  await page.getByRole('option', { name: '自定义模型 ID…' }).click();
  await page.getByLabel('模型 ID', { exact: true }).fill('configured-model');
  await page.getByRole('button', { name: '使用此模型' }).click();
  await expect(model).toContainText('configured-model');
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  await effort.click();
  await expect(page.getByRole('option', { name: '极高', exact: false })).toBeVisible();
  await page.getByRole('option', { name: /^高 high/ }).click();
  await expect(effort).toContainText('高');
  await page.reload();
  await expect(model).toContainText('configured-model');
  await expect(effort).toContainText('高');
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill('引用验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await composer.fill('保留我的问题');
  await page.getByRole('button', { name: '引用追问' }).click();
  await expect(composer).toHaveValue('保留我的问题');
  await expect(page.locator('.reference-card')).toContainText('已完成');
  const sent = page.waitForRequest((r) => r.url().endsWith('/messages') && r.method() === 'POST');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const payload = (await sent).postDataJSON();
  expect(payload.text).toBe('保留我的问题');
  expect(payload.references[0]).toContain('已完成你的任务。');
  expect(payload.model).toBe('configured-model');
  expect(payload.effort).toBe('high');
  await expect(page.locator('.reference-card')).toHaveCount(0);
  await expect(page.locator('.assistant-message')).toHaveCount(2);
  await model.click();
  await page.getByRole('option', { name: /^Test Codex test-model/ }).click();
  await expect(effort).toContainText('默认强度');
  await effort.click();
  await expect(page.getByRole('option', { name: /^中 medium/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /^高 high/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('server queue survives reload, supports pause/cancel/resume and explicit global force stop', async ({
  page,
}) => {
  await login(page);
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill('慢速队列验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '执行中发送方式' })).toContainText('排队发送');
  await composer.fill('排队的第二个任务');
  await page.getByRole('button', { name: '加入队列' }).click();
  await expect(page.locator('.message-queue')).toContainText('排队的第二个任务');
  await page.reload();
  await expect(page.locator('.message-queue')).toContainText('排队的第二个任务');
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect(page.locator('.message-queue')).toContainText('已暂停');
  await composer.fill('将被取消的任务');
  await page.getByRole('button', { name: '加入队列' }).click();
  await expect(page.locator('.queue-item')).toHaveCount(2);
  await page.getByRole('button', { name: '取消排队消息 2' }).click();
  await expect(page.locator('.queue-item')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/paused-queue.png', animations: 'disabled' });
  await page.getByRole('button', { name: '继续此会话队列' }).click();
  await expect(page.locator('.message-queue')).toHaveCount(0);
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await composer.fill('慢速强制停止验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('combobox', { name: '执行中发送方式' }).click();
  await page.getByRole('option', { name: '立即补充' }).click();
  await composer.fill('补充到当前任务');
  await page.getByRole('button', { name: '补充指令', exact: true }).click();
  await expect(page.locator('.user-message').last()).toContainText('补充到当前任务');
  await page.getByRole('button', { name: '会话菜单', exact: true }).click();
  await page.getByRole('button', { name: '强制终止执行器', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('全部 1 个运行任务');
  await expect(page.getByRole('dialog')).toContainText('不会回滚');
  await page.getByRole('button', { name: '终止全部运行任务' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0);
});

test('queued work continues after closing the sending page', async ({ page, context }) => {
  let first = true;
  await page.route('**/api/threads/*/messages', async (route) => {
    if (!first) {
      await route.continue();
      return;
    }
    first = false;
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ response });
  });
  await login(page);
  await page.getByLabel('发送给 Codex 的消息').fill('慢速离线排队');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '加入队列' })).toBeVisible();
  await page.getByLabel('发送给 Codex 的消息').fill('离线后的第二条');
  await page.getByRole('button', { name: '加入队列' }).click();
  await expect(page.locator('.message-queue')).toContainText('离线后的第二条');
  const id = await page.evaluate(() => sessionStorage.getItem('selectedThread'));
  await page.close();
  const next = await context.newPage();
  await next.addInitScript((threadId) => sessionStorage.setItem('selectedThread', threadId!), id);
  await next.goto('/');
  await expect(next.locator('.assistant-message')).toHaveCount(2, { timeout: 10000 });
  await expect(next.locator('.user-message').last()).toContainText('离线后的第二条');
  await expect(next.locator('.message-queue')).toHaveCount(0);
});

test('two pages run same-project conversations concurrently and stop independently', async ({
  page,
  context,
}) => {
  await login(page);
  const headers = { origin: 'http://127.0.0.1:18479' };
  const projects = await (await page.request.get('/api/projects')).json();
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await page.request.post('/api/threads', {
      headers,
      data: { projectId: projects[0].id },
    });
    expect(response.ok()).toBe(true);
    ids.push((await response.json()).thread.id);
  }
  await page.evaluate((id) => sessionStorage.setItem('selectedThread', id), ids[0]);
  await page.reload();
  const other = await context.newPage();
  await other.addInitScript((id) => sessionStorage.setItem('selectedThread', id), ids[1]);
  await other.goto('/');
  try {
    await page.getByLabel('发送给 Codex 的消息').fill('慢速 parallel conversation one');
    await other.getByLabel('发送给 Codex 的消息').fill('慢速 parallel conversation two');
    await Promise.all(
      [page, other].map((tab) =>
        tab.getByRole('button', { name: '发送消息', exact: true }).click(),
      ),
    );
    await expect
      .poll(async () => {
        const status = await (await page.request.get('/api/status')).json();
        return status.active.map((run: { threadId: string }) => run.threadId).sort();
      })
      .toEqual([...ids].sort());
    for (const tab of [page, other]) {
      await expect(tab.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
      await expect(tab.locator('.message-queue')).toHaveCount(0);
    }
    await page.getByRole('button', { name: '停止任务', exact: true }).click();
    await expect
      .poll(async () => {
        const status = await (await page.request.get('/api/status')).json();
        return status.active.map((run: { threadId: string }) => run.threadId);
      })
      .toEqual([ids[1]]);
    await expect(other.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
  } finally {
    await page.request.post('/api/runtime/force-stop', { headers, data: {} });
    await other.close();
  }
});
