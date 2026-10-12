import { test, expect } from '@playwright/test';

test('ordinary project shows honest empty state and Codex local changes without GitHub', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.locator('.project-entry > button').first().click();
  await page.getByRole('button', { name: '查看文件和改动' }).click();
  const panel = page.locator('.file-panel');
  await panel.getByRole('button', { name: '改动', exact: true }).click();
  await expect(panel).toContainText('打开项目中的一个会话');
  await expect(panel).toContainText('普通文件夹项目');
  await expect(panel.locator('.error-box')).toHaveCount(0);
  await expect(panel).not.toContainText('工作区没有待提交改动');
  await panel.getByRole('button', { name: '关闭详情' }).click();
  await page.getByLabel('发送给 Codex 的消息').fill('界面验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('heading', { name: '检查结果' })).toBeVisible();
  await page.getByRole('button', { name: '查看文件和改动' }).click();
  await panel.getByRole('button', { name: '改动', exact: true }).click();
  await expect(panel.locator('.diff-view')).toContainText('export const value');
  await expect(panel.locator('.diff-counts')).toContainText('+1');
  await expect(panel).toContainText('普通文件夹项目');
  await panel.getByRole('button', { name: '刷新文件' }).click();
  await expect(panel.getByText('正在加载', { exact: true })).toHaveCount(0);
  await expect(panel.locator('.diff-view')).toContainText('export const value');
  await expect(panel.locator('.error-box')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/local-changes.png', animations: 'disabled' });
  await page.route(/\/api\/threads\/[^/?]+(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    for (const turn of data.thread?.turns || []) delete turn.diff;
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await page.getByRole('button', { name: '查看文件和改动' }).click();
  await panel.getByRole('button', { name: '改动', exact: true }).click();
  // Historical fileChange items still work if the protocol has no saved turn-level aggregate diff.
  await expect(panel.getByText('修改了 2 个文件', { exact: true })).toBeVisible();
  await panel.getByText('修改了 2 个文件', { exact: true }).click();
  await panel.getByText('src/hello.ts', { exact: true }).click();
  await expect(panel.locator('.diff-view')).toContainText('export const value');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('conversation exposes changed files and line comparisons without opening the side panel', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByLabel('发送给 Codex 的消息').fill('界面验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const changes = page.locator('.conversation .file-changes, .turn .file-changes').last();
  await expect(changes).not.toHaveAttribute('open');
  await expect(page.locator('.turn-diff')).not.toHaveAttribute('open');
  await changes.locator(':scope > summary').click();
  await expect(changes.getByText('src/hello.ts', { exact: true })).toBeVisible();
  await expect(changes.getByText('docs/notes.md', { exact: true })).toBeVisible();
  await expect(changes.getByText('新增', { exact: true })).toBeVisible();
  const file = changes.locator('.file-change-detail').filter({ hasText: 'src/hello.ts' });
  await expect(file.locator('.change-counts')).toContainText('+1');
  await expect(file.locator('.change-counts')).toContainText('−1');
  expect(
    await file.locator('summary').evaluate((summary) => {
      const counts = summary.querySelector('.change-counts');
      const badge = summary.querySelector('.badge');
      return (
        !!counts &&
        !!badge &&
        !!(counts.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    }),
  ).toBe(true);
  await file.locator('summary').click();
  await expect(file.locator('.diff-view')).toContainText('export const value');
  await expect(file.locator('.line-number').filter({ hasText: /^1$/ }).first()).toBeVisible();
  await page.reload();
  await expect(changes).not.toHaveAttribute('open');
  await expect(page.locator('.turn-diff')).not.toHaveAttribute('open');
  await changes.locator(':scope > summary').click();
  await expect(
    page.locator('.turn .file-changes').last().getByText('docs/notes.md', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
