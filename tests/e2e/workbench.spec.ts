import { test, expect, type Page } from '@playwright/test';
async function switchTheme(page: Page, theme: '亮色' | '暗色') {
  const sidebar = page.getByRole('button', { name: '打开侧栏' });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: `切换至${theme}主题` }).click();
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
}
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByText('今天，想完成什么？')).toBeVisible();
}
test('password gate, desktop workspace, streamed message and files', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Codex Cloud · 私人工作台');
  await expect(page.getByRole('heading', { name: '回到你的工作台' })).toBeVisible();
  await expect(page.getByAltText('Arran 的头像')).toBeVisible();
  await expect(page.getByAltText('Codex Cloud Logo')).toBeVisible();
  const initialResources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((r) => r.name),
  );
  expect(initialResources.some((url) => /\/Markdown-[^/]+\.js/.test(url))).toBe(false);
  expect(
    await page
      .getByAltText('Arran 的头像')
      .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/login.png', fullPage: true, animations: 'disabled' });
  await expect(page.getByRole('button', { name: /切换至.*色主题/ })).toHaveCount(0);
  await page.getByLabel('工作台密码', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByRole('alert')).toContainText('密码不正确');
  await login(page);
  await expect(page.locator('.brand')).toContainText('Codex Cloud');
  await expect(page.getByRole('status')).toContainText('均为模拟数据');
  await expect(page.locator('.user-row')).toHaveCount(0);
  await page.screenshot({
    path: 'test-results/workspace.png',
    fullPage: true,
    animations: 'disabled',
  });
  await switchTheme(page, '暗色');
  await page.screenshot({
    path: 'test-results/workspace-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
  const otherTab = await page.context().newPage();
  await otherTab.goto('/');
  await expect(otherTab.locator('html')).toHaveAttribute('data-theme', 'dark');
  await switchTheme(otherTab, '亮色');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await otherTab.close();
  await page.getByLabel('发送给 Codex 的消息').fill('你好，检查项目');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Codex 消息' }).first()).toBeVisible();
  await page.getByRole('button', { name: '查看文件和改动' }).click();
  await page.getByRole('button', { name: 'hello.ts', exact: true }).click();
  await expect(page.locator('.source-preview')).toContainText('export const hello');
  await page.screenshot({
    path: 'test-results/conversation.png',
    fullPage: true,
    animations: 'disabled',
  });
  await switchTheme(page, '暗色');
  await page.screenshot({
    path: 'test-results/conversation-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
  if (!(await page.getByRole('main', { name: '工作台设置' }).isVisible()))
    await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '回到你的工作台' })).toBeVisible();
});
test('approval survives refresh and new device; duplicate approval cannot run twice', async ({
  page,
  browser,
}) => {
  await login(page);
  await page.getByLabel('发送给 Codex 的消息').fill('请触发审批');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('等待你的批准', { exact: true })).toBeVisible();
  const threadId = await page.evaluate(() => sessionStorage.getItem('selectedThread'));
  await page.reload();
  await expect(page.getByText('等待你的批准', { exact: true })).toBeVisible();
  const other = await browser.newContext();
  const second = await other.newPage();
  await login(second);
  await second
    .locator('.thread-entry')
    .filter({ hasText: threadId!.slice(-8) })
    .first()
    .click();
  await expect(second.getByText('等待你的批准', { exact: true })).toBeVisible();
  await second.getByRole('button', { name: '批准本次' }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await expect(page.getByText('等待你的批准', { exact: true })).toHaveCount(0);
  await other.close();
});
test('background execution continues after browser page closes', async ({ page, context }) => {
  await login(page);
  await page.getByLabel('发送给 Codex 的消息').fill('慢速任务继续运行');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Codex 正在工作', { exact: true })).toBeVisible();
  const threadId = await page.evaluate(() => sessionStorage.getItem('selectedThread'));
  await page.close();
  const next = await context.newPage();
  await next.goto('/');
  await next
    .locator('.thread-entry')
    .filter({ hasText: threadId!.slice(-8) })
    .first()
    .click();
  await expect(next.getByText('已完成你的任务。', { exact: true })).toBeVisible({ timeout: 15000 });
});
test('mobile layout, question input, interruption and session revocation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results/mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await switchTheme(page, '暗色');
  await page.screenshot({
    path: 'test-results/mobile-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
  await switchTheme(page, '亮色');
  await page.getByLabel('发送给 Codex 的消息').fill('提问');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Codex 需要你的回答')).toBeVisible();
  await page.getByRole('button', { name: /Windows.*原生运行/ }).click();
  await page.getByRole('button', { name: '提交回答' }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await page.getByLabel('发送给 Codex 的消息').fill('慢速');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect(page.getByText('本次执行已停止')).toBeVisible();
  await page.getByRole('button', { name: '打开侧栏' }).click();
  if (!(await page.getByRole('main', { name: '工作台设置' }).isVisible()))
    await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '回到你的工作台' })).toBeVisible();
});
test('attachment, rename, pin, fork and archive', async ({ page }) => {
  await login(page);
  await page.getByLabel('发送给 Codex 的消息').fill('读取附件');
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('dialog', { name: '添加文件' })
    .getByRole('button', { name: '上传新文件', exact: false })
    .click();
  await (
    await chooser
  ).setFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A private attachment'),
  });
  await expect(page.locator('.attachments')).toContainText('notes.txt');
  await expect(page.getByLabel('发送给 Codex 的消息')).toHaveValue('读取附件');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '会话菜单' }).click();
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByLabel('会话名称').fill('附件会话测试');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.breadcrumb')).toContainText('附件会话测试');
  await page.getByRole('button', { name: '会话菜单' }).click();
  await page.getByRole('button', { name: '置顶会话', exact: true }).click();
  await page.getByRole('button', { name: '会话菜单' }).click();
  await expect(page.getByRole('button', { name: '取消置顶', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '分叉会话', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '会话菜单' }).click();
  await page.getByRole('button', { name: '归档会话', exact: true }).last().click();
  await expect(page.getByText('今天，想完成什么？')).toBeVisible();
  await expect(
    page.locator('.sidebar-footer').getByRole('button', { name: '归档会话', exact: true }),
  ).toHaveCount(0);
});
