import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByText('今天，想完成什么？')).toBeVisible();
}

test('partial uploads remain visible, reload restores drafts, and removal deletes the pending file', async ({
  page,
}) => {
  await login(page);
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill('附件草稿保留');
  let uploads = 0;
  await page.route('**/api/threads/*/attachments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    uploads++;
    if (uploads === 2)
      return route.fulfill({
        status: 413,
        contentType: 'application/json',
        body: JSON.stringify({ error: '第二个文件上传失败' }),
      });
    return route.continue();
  });
  await page.locator('input[type=file]').setInputFiles([
    { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first') },
    { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second') },
  ]);
  await expect(page.getByText('第二个文件上传失败', { exact: true })).toBeVisible();
  await expect(page.locator('.attachments')).toContainText('first.txt');
  await expect(composer).toHaveValue('附件草稿保留');
  await page.reload();
  await expect(composer).toHaveValue('附件草稿保留');
  await expect(page.locator('.attachments')).toContainText('first.txt');
  const id = await page.evaluate(() => sessionStorage.getItem('selectedThread'));
  await page.getByRole('button', { name: '移除 first.txt', exact: true }).click();
  await expect(page.locator('.attachments')).toHaveCount(0);
  expect(await (await page.request.get(`/api/threads/${id}/attachments`)).json()).toEqual([]);
  // A removal by another device must not be revived by sessionStorage on reload.
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'remote.txt', mimeType: 'text/plain', buffer: Buffer.from('remote') });
  await expect(page.locator('.attachments')).toContainText('remote.txt');
  const pending = await (await page.request.get(`/api/threads/${id}/attachments`)).json();
  const removed = await page.request.delete(`/api/threads/${id}/attachments/${pending[0].id}`, {
    headers: { origin: new URL(page.url()).origin },
  });
  expect(removed.ok()).toBeTruthy();
  await page.reload();
  await expect(composer).toHaveValue('附件草稿保留');
  await expect(page.locator('.attachments')).toHaveCount(0);
});

test('conversation drafts survive switching and reload, and logout clears local drafts', async ({
  page,
}) => {
  await login(page);
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill('草稿测试会话 A');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  const firstId = await page.evaluate(() => sessionStorage.getItem('selectedThread'));
  await composer.fill('A 尚未发送的内容');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(composer).toHaveValue('');
  await composer.fill('草稿测试会话 B');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  const secondId = await page.evaluate(() => sessionStorage.getItem('selectedThread'));
  await composer.fill('B 尚未发送的内容');
  await page
    .locator('.thread-entry')
    .filter({ hasText: firstId!.slice(-8) })
    .first()
    .click();
  await expect(composer).toHaveValue('A 尚未发送的内容');
  await page.reload();
  await expect(composer).toHaveValue('A 尚未发送的内容');
  await page
    .locator('.thread-entry')
    .filter({ hasText: secondId!.slice(-8) })
    .first()
    .click();
  await expect(composer).toHaveValue('B 尚未发送的内容');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('main', { name: '工作台设置' })).toBeVisible();
  await page.getByRole('button', { name: '返回工作台' }).click();
  if (!(await page.getByRole('main', { name: '工作台设置' }).isVisible()))
    await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByLabel('工作台密码', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('workbench-drafts'))).toBeNull();
});

test('large file tree shows its total and loads the next page', async ({ page }) => {
  await login(page);
  await page.getByLabel('发送给 Codex 的消息').fill('大目录测试');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  const offsets: number[] = [];
  await page.route('**/api/files?**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('mode') !== 'list') return route.continue();
    const offset = Number(query.get('offset') || 0);
    offsets.push(offset);
    const entries = Array.from({ length: offset ? 1 : 1000 }, (_, i) => ({
      name: `file-${offset + i}.txt`,
      path: `file-${offset + i}.txt`,
      directory: false,
    }));
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ entries, total: 1001, nextOffset: offset ? null : 1000 }),
    });
  });
  await page.getByRole('button', { name: '查看文件和改动' }).click();
  await expect(page.getByText('已显示 1000 / 1001 项')).toBeVisible();
  await page.getByRole('button', { name: '加载更多文件', exact: true }).click();
  await expect(page.getByText('已显示 1001 / 1001 项')).toBeVisible();
  await expect(page.getByRole('button', { name: 'file-1000.txt', exact: true })).toBeVisible();
  expect(offsets).toEqual([0, 1000]);
});
