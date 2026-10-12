import { test, expect } from '@playwright/test';

test('conversation links open project files, line targets and directories on desktop and mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByLabel('发送给 Codex 的消息').fill('链接验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('link', { name: '文件 URI', exact: true })).toBeVisible();
  const panel = page.locator('.file-panel');
  for (const name of ['相对路径', '绝对路径', '文件 URI']) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(panel.locator('.source-preview')).toContainText('export const hello');
    await expect(panel.locator('[data-line="1"]')).toContainText('export const hello');
    await expect(panel.getByText('已定位第 1 行', { exact: true })).toBeVisible();
  }
  await page.getByRole('link', { name: '项目目录', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'hello.ts', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '缺失文件', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('不存在');
  await page.getByRole('link', { name: '越界文件', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('项目外');
  await expect(page.getByRole('link', { name: '外部网站', exact: true })).toHaveAttribute(
    'href',
    'https://example.com/guide',
  );
  await expect(page.getByRole('link', { name: '外部网站', exact: true })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await expect(page.getByRole('link', { name: '危险链接', exact: true })).toHaveCount(0);
  expect(page.context().pages()).toHaveLength(1);
  await panel.getByRole('button', { name: '关闭详情' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: '文件 URI', exact: true }).click();
  await expect(panel.locator('.source-preview')).toContainText('export const hello');
  await page.screenshot({ path: 'test-results/file-link-mobile.png', animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole('button', { name: '关闭详情' }).click();
  await page.reload();
  await page.getByRole('link', { name: '相对路径', exact: true }).click();
  await expect(panel.locator('.source-preview')).toContainText('export const hello');
});
