import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByLabel('发送给 Codex 的消息')).toBeVisible();
}
test('resync keeps replies received while a stale history response is in flight', async ({
  page,
}) => {
  await login(page);
  await page.getByLabel('发送给 Codex 的消息').fill('慢速历史同步竞态');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.task-meta')).toContainText('执行中');
  const id = await page.evaluate(() => sessionStorage.getItem('selectedThread'));
  let release!: () => void;
  let captured!: () => void;
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/threads/${id}`, async (route) => {
    const response = await route.fetch();
    const stale = await response.json();
    captured();
    await gate;
    const latest = await (await page.request.get(`/api/threads/${id}`)).json();
    await route.fulfill({ response, json: { ...stale, cursor: latest.cursor } });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await ready;
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  const delivered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/threads/${id}` &&
      response.request().method() === 'GET',
  );
  release();
  await delivered;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
});

test('failed list refresh after reconnect keeps existing conversations visible', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByLabel('发送给 Codex 的消息').fill('重连保留会话列表');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('selectedThread')))
    .not.toBeNull();
  const threadId = await page.evaluate(() => sessionStorage.getItem('selectedThread'));
  const entry = page.locator('.thread-entry').filter({ hasText: threadId!.slice(-8) });
  await expect(entry).toBeVisible();
  await page.route('**/api/threads?**', (route) =>
    route.fulfill({ status: 500, json: { error: '测试列表读取失败' } }),
  );
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: '立即重连' })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('测试列表读取失败', { exact: true })).toBeVisible();
  await expect(entry).toBeVisible();
});

test('offline execution reconnects and failed history has a recovery action instead of an empty page', async ({
  page,
  context,
}) => {
  await login(page);
  let submissions = 0;
  page.on('request', (r) => {
    if (/\/messages$/.test(r.url()) && r.method() === 'POST') submissions++;
  });
  await page.getByLabel('发送给 Codex 的消息').fill('慢速网络恢复验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.task-meta')).toContainText('执行中');
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: '立即重连' })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible({ timeout: 12000 });
  expect(submissions).toBe(1);
  let broken = true;
  await page.route('**/api/threads/*', (route) => {
    if (
      route.request().method() === 'GET' &&
      /^\/api\/threads\/[^/]+$/.test(new URL(route.request().url()).pathname) &&
      broken
    )
      return route.abort('failed');
    return route.continue();
  });
  await page.reload();
  await expect(page.getByText('会话暂时读取失败')).toBeVisible();
  await expect(page.getByLabel('发送给 Codex 的消息')).toBeVisible();
  broken = false;
  await page.getByRole('button', { name: '重新读取会话' }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await expect(page.getByText('会话暂时读取失败')).toHaveCount(0);
  expect(submissions).toBe(1);
});
test('stopped tasks continue explicitly while preserving drafts and completed work', async ({
  page,
}) => {
  await login(page);
  await page.getByLabel('发送给 Codex 的消息').fill('慢速中断恢复验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续执行', exact: true })).toBeVisible();
  await page.getByLabel('发送给 Codex 的消息').fill('保留我的新草稿');
  const continued = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/messages$/.test(r.url()),
  );
  await page.getByRole('button', { name: '继续执行', exact: true }).click();
  expect((await continued).postDataJSON().text).toContain('先检查会话历史和当前工作区');
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('发送给 Codex 的消息')).toHaveValue('保留我的新草稿');
  await expect(page.locator('.task-meta').last()).toContainText('总用时');
  await page.screenshot({ path: 'test-results/task-timing-desktop.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/task-timing-mobile.png', animations: 'disabled' });
});
test('failed Markdown chunk stays within the message and refresh restores conversation', async ({
  page,
}) => {
  await login(page);
  await page.route('**/assets/Markdown-*.js', (r) => r.abort('failed'));
  await page.getByLabel('发送给 Codex 的消息').fill('消息显示恢复验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.render-recovery').first()).toBeVisible();
  await expect(page.getByLabel('发送给 Codex 的消息')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeVisible();
  await page.unroute('**/assets/Markdown-*.js');
  await page.reload();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await expect(page.locator('.render-recovery')).toHaveCount(0);
});
test('project picker presets server roots and submits only joined child paths', async ({
  page,
}) => {
  await login(page);
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    result.settings.projectRoots = ['/srv/projects'];
    await route.fulfill({ response, json: result });
  });
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '添加项目' });
  await expect(modal.getByLabel('项目根目录')).toHaveValue('/srv/projects');
  await expect(
    modal.getByRole('checkbox', { name: '创建新目录（支持自动创建多级父目录）' }),
  ).toBeDisabled();
  await modal.getByLabel('项目名称', { exact: true }).fill('课堂项目');
  await modal.getByLabel('子目录（留空使用根目录）').fill('../secret');
  await modal.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(modal).toContainText('子目录不能包含');
  await modal.getByLabel('子目录（留空使用根目录）').fill('classroom');
  await expect(modal.locator('.error-box')).toHaveCount(0);
  await modal.getByRole('checkbox', { name: '创建新目录（支持自动创建多级父目录）' }).check();
  let payload: { path?: string; create?: boolean } = {};
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    payload = route.request().postDataJSON();
    await route.fulfill({
      json: {
        id: 'test-classroom',
        name: '课堂项目',
        path: '/srv/projects/classroom',
        createdAt: Date.now(),
      },
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/project-root-mobile.png', animations: 'disabled' });
  await modal.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(payload).toMatchObject({ path: '/srv/projects/classroom', create: true });
});

test('project picker browses server directories and creates a nested project', async ({ page }) => {
  await login(page);
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    result.settings.projectRoots = ['/'];
    await route.fulfill({ response, json: result });
  });
  await page.route('**/api/project-directories?*', async (route) => {
    const current = new URL(route.request().url()).searchParams.get('path');
    const entries =
      current === '/'
        ? [{ name: 'srv', path: '/srv' }]
        : current === '/srv'
          ? [{ name: 'projects', path: '/srv/projects' }]
          : [];
    await route.fulfill({
      json: {
        path: current,
        parent: current === '/' ? null : current === '/srv' ? '/' : '/srv',
        entries,
      },
    });
  });
  let payload: { path?: string; create?: boolean } = {};
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    payload = route.request().postDataJSON();
    await route.fulfill({
      json: { id: 'nested-project', name: '多级项目', path: payload.path, createdAt: Date.now() },
    });
  });
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '添加项目' });
  await expect(modal.getByLabel('项目根目录').locator('option[value="/srv"]')).toHaveCount(1);
  await modal.getByLabel('项目根目录').selectOption('/srv');
  await expect(modal.getByLabel('项目根目录').locator('option[value="/srv/projects"]')).toHaveCount(
    1,
  );
  await modal.getByLabel('项目根目录').selectOption('/srv/projects');
  await expect(modal.getByLabel('项目根目录')).toHaveValue('/srv/projects');
  await modal.getByLabel('项目根目录').selectOption('/srv');
  await expect(modal.getByLabel('项目根目录')).toHaveValue('/srv');
  await modal.getByRole('button', { name: 'projects', exact: true }).click();
  await modal.getByLabel('项目名称', { exact: true }).fill('多级项目');
  await modal.getByLabel('子目录（留空使用根目录）').fill('课程/练习/my-app');
  await modal.getByRole('checkbox', { name: '创建新目录（支持自动创建多级父目录）' }).check();
  await modal.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(payload).toMatchObject({ path: '/srv/projects/课程/练习/my-app', create: true });
});
