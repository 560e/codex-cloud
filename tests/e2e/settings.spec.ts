import { test, expect } from '@playwright/test';

test('settings page persists defaults, preserves drafts, filters models and displays native task time', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill('设置页保留的草稿');
  await expect(page.locator('.topbar .theme-toggle')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('main', { name: '工作台设置' });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: '切换至暗色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await settings.getByLabel('审批', { exact: true }).selectOption('untrusted');
  await settings.getByLabel('文件访问', { exact: true }).selectOption('read-only');
  await settings.getByLabel('默认思考强度').selectOption('high');
  await settings
    .getByLabel('个人模型列表（每行一个 ID）')
    .fill('relay-fast\nrelay-deep\nrelay-fast');
  await settings.getByRole('button', { name: '保存默认设置' }).click();
  await expect(settings.getByText('默认设置已保存')).toBeVisible();
  await page.reload();
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel('文件访问', { exact: true })).toHaveValue('read-only');
  await expect(settings.getByRole('button', { name: '切换至亮色主题' })).toBeVisible();
  await settings.getByRole('button', { name: '返回工作台' }).click();
  await expect(composer).toHaveValue('设置页保留的草稿');
  await page.getByRole('combobox', { name: '模型', exact: true }).click();
  await page.getByRole('option', { name: 'relay-deep', exact: false }).click();
  await page.getByRole('combobox', { name: '推理强度', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await composer.fill('慢速设置计时验证');
  const created = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/threads',
  );
  const sent = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/messages$/.test(new URL(r.url()).pathname),
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  expect((await created).postDataJSON()).toMatchObject({
    approvalPolicy: 'untrusted',
    sandbox: 'read-only',
    model: 'relay-deep',
  });
  expect((await sent).postDataJSON()).toMatchObject({ effort: 'high', model: 'relay-deep' });
  await expect(page.getByLabel('任务执行状态')).toContainText('执行中');
  await page.reload();
  await expect(page.getByLabel('任务执行状态')).toContainText('总用时', { timeout: 10000 });
  const elapsed = (await page.getByLabel('任务执行状态').textContent()) || '';
  expect(elapsed).not.toContain('暂无');
  await page.reload();
  await expect(page.getByLabel('任务执行状态')).toHaveText(elapsed);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(settings).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/settings-page-mobile.png', animations: 'disabled' });
  await page.goBack();
  await expect(page.getByLabel('任务执行状态')).toHaveText(elapsed);
});
