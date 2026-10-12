import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test('conversation menu exports TXT, Markdown and offline HTML on mobile, with retry after failure', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByLabel('发送给 Codex 的消息').fill('完整会话导出样例');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  for (const [format, extension] of [
    ['TXT', 'txt'],
    ['Markdown', 'md'],
    ['HTML', 'html'],
  ]) {
    await page.getByRole('button', { name: '会话菜单', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '强制终止执行器', exact: true }).locator('svg'),
    ).toHaveClass(/lucide-octagon-x/);
    await page.getByRole('button', { name: '导出当前会话', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导出当前会话' });
    await dialog.getByRole('radio', { name: new RegExp('^' + format) }).check();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (format === 'TXT') {
      await page.route(
        '**/export?format=txt',
        (route) => route.fulfill({ status: 502, json: { error: '模拟历史读取失败' } }),
        { times: 1 },
      );
      await dialog.getByRole('button', { name: '导出文件', exact: true }).click();
      await expect(dialog.getByRole('alert')).toHaveText('模拟历史读取失败');
    }
    const downloaded = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '导出文件', exact: true }).click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${extension}$`));
    const body = await fs.readFile((await file.path())!, 'utf8');
    expect(body).toContain('完整会话导出样例');
    expect(body).toContain('已完成你的任务。');
    if (format === 'HTML') {
      const offline = await page.context().newPage();
      await offline.setContent(body);
      await expect(offline.getByText('已完成你的任务。', { exact: true })).toBeVisible();
      await offline.close();
    }
    await expect(dialog).toHaveCount(0);
  }
});
