import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByLabel('发送给 Codex 的消息')).toBeVisible();
}

test('native turn tokens survive reload and appear in a dedicated statistics page without losing drafts', async ({
  page,
}) => {
  await login(page);
  const composer = page.getByLabel('发送给 Codex 的消息');
  const prompt = `界面验证用量统计 ${Date.now()}`;
  await composer.fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const usage = page.getByLabel('本轮 Token 用量');
  await expect(usage).toHaveText(/Token\s*3,800/);
  await page.reload();
  await expect(usage).toHaveText(/Token\s*3,800/);
  await composer.fill('用量页面保留的草稿');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '数据', exact: true }).click();
  await page.getByRole('button', { name: '查看 Token 统计', exact: true }).click();
  const stats = page.getByRole('main', { name: 'Token 统计', exact: true });
  await expect(stats).toBeVisible();
  const row = stats.getByRole('row').filter({ hasText: prompt });
  await expect(row).toContainText('3,800');
  await expect(row).toContainText('3,200');
  await expect(row.locator('[data-label="其中缓存 Token"]')).toHaveText('2,400');
  await expect(row.locator('[data-label="缓存命中率"]')).toHaveText('75.00%');
  await expect(stats.locator('.usage-card').filter({ hasText: '整体缓存命中率' })).toContainText(
    '75.00%',
  );
  await stats.getByRole('button', { name: '今天', exact: true }).click();
  await expect(row).toContainText('3,800');
  await page.reload();
  await expect(stats).toBeVisible();
  await expect(row.locator('[data-label="其中缓存 Token"]')).toHaveText('2,400');
  await stats.getByRole('button', { name: '返回工作台' }).click();
  await page
    .getByRole('main', { name: '工作台设置' })
    .getByRole('button', { name: '返回工作台' })
    .click();
  await expect(composer).toHaveValue('用量页面保留的草稿');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '数据', exact: true }).click();
  await page.getByRole('button', { name: '查看 Token 统计', exact: true }).click();
  await expect(stats).toBeVisible();
  await expect(row).toContainText('3,800');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results/token-statistics-mobile.png',
    animations: 'disabled',
  });
});

test('pasting image and file uploads attachments once and ordinary text still pastes into the draft', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill('保留粘贴前的草稿');
  let uploads = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/attachments$/.test(new URL(request.url()).pathname))
      uploads++;
  });
  await composer.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(
      new File(
        [
          Uint8Array.from(
            atob(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII=',
            ),
            (char) => char.charCodeAt(0),
          ),
        ],
        'clipboard.png',
        { type: 'image/png' },
      ),
    );
    data.items.add(new File(['hello clipboard'], 'pasted.txt', { type: 'text/plain' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator('.attachments')).toContainText('clipboard.png');
  await expect(page.locator('.attachments')).toContainText('pasted.txt');
  expect(uploads).toBe(2);
  await expect(composer).toHaveValue('保留粘贴前的草稿');
  await composer.fill('');
  await page.evaluate(() => navigator.clipboard.writeText('普通文本粘贴'));
  await composer.focus();
  await page.keyboard.press('Control+V');
  await expect(composer).toHaveValue('普通文本粘贴');
  await page.reload();
  await expect(page.locator('.attachments')).toContainText('clipboard.png');
  await expect(page.locator('.attachments')).toContainText('pasted.txt');
  await expect(composer).toHaveValue('普通文本粘贴');
});

test('drafts over ten lines collapse, expand for editing, and send their complete edited contents', async ({
  page,
}) => {
  await login(page);
  const composer = page.getByLabel('发送给 Codex 的消息');
  const ten = Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 行`).join('\n');
  await composer.fill(ten);
  await expect(composer).toBeVisible();
  await expect(page.getByRole('button', { name: '展开编辑长消息' })).toHaveCount(0);
  const eleven = ten + '\n最后一行';
  await composer.fill(eleven);
  await expect(page.getByRole('button', { name: '展开编辑长消息' })).toBeVisible();
  await expect(composer).toHaveCount(0);
  await page.getByRole('button', { name: '展开编辑长消息' }).click();
  await expect(composer).toHaveValue(eleven);
  const edited = eleven + '，已修改';
  await composer.fill(edited);
  await expect(composer).toBeVisible();
  await page.getByRole('button', { name: '收起长消息' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '展开编辑长消息' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/long-draft-mobile.png', animations: 'disabled' });
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && /\/messages$/.test(new URL(request.url()).pathname),
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  expect((await sent).postDataJSON().text).toBe(edited);
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue('');
  await expect(page.locator('.user-message-bubble')).toContainText('最后一行，已修改');
});

test('statistics show separate round costs and filter by conversation and project', async ({
  page,
  context,
}) => {
  await login(page);
  const composer = page.getByLabel('发送给 Codex 的消息');
  const firstPrompt = `界面验证逐轮统计第一轮 ${Date.now()}`;
  const secondPrompt = `界面验证逐轮统计第二轮 ${Date.now()}`;
  await composer.fill(firstPrompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByLabel('上游余额', { exact: true }).first()).toContainText(
    '本轮消费≈ $0.1250',
  );
  const threadId = await page.evaluate(() => sessionStorage.getItem('selectedThread'));
  await composer.fill(secondPrompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByLabel('上游余额', { exact: true })).toHaveCount(2);
  await expect(page.getByLabel('上游余额', { exact: true }).last()).toContainText(
    '本轮消费≈ $0.1250',
  );
  const native = await (await context.request.get(`/api/threads/${threadId}`)).json();
  const projects = await (await context.request.get('/api/projects')).json();
  const project = projects.find((item: { path: string }) => item.path === native.thread.cwd);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '数据', exact: true }).click();
  await page.getByRole('button', { name: '查看 Token 统计' }).click();
  const stats = page.getByRole('main', { name: 'Token 统计' });
  await stats.getByLabel('会话筛选', { exact: true }).selectOption(threadId!);
  await expect(stats.locator('tbody tr')).toHaveCount(2);
  const first = stats
    .locator('tbody tr')
    .filter({ has: page.locator('.usage-prompt', { hasText: firstPrompt }) });
  const second = stats
    .locator('tbody tr')
    .filter({ has: page.locator('.usage-prompt', { hasText: secondPrompt }) });
  await expect(first).toContainText('第 1 轮');
  await expect(second).toContainText('第 2 轮');
  await expect(first.locator('td').nth(3)).toHaveText('3,800');
  await expect(second.locator('td').nth(3)).toHaveText('3,800');
  await expect(first.locator('td').nth(4)).toHaveText('3,200');
  await expect(first.locator('[data-label="其中缓存 Token"]')).toHaveText('2,400');
  await expect(first.locator('[data-label="缓存命中率"]')).toHaveText('75.00%');
  await expect(first.locator('[data-label="输出 Token"]')).toHaveText('600');
  await expect(first.locator('[data-label="其中思考 Token"]')).toHaveText('200');
  await expect(first.locator('[data-label="余额消费"]')).toHaveText('0.125 $');
  await expect(stats.locator('.usage-expenses')).toContainText('0.25 $');
  await stats.getByLabel('项目筛选', { exact: true }).selectOption(project.id);
  await stats.getByLabel('会话筛选', { exact: true }).selectOption(threadId!);
  await expect(stats.locator('tbody tr')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results/usage-round-details-mobile.png',
    animations: 'disabled',
  });
});
