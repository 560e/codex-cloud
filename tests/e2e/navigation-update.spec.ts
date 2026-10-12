import { test, expect } from '@playwright/test';

test('compact mobile drawer has a full-width new conversation action, categorized settings and CLI update controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByRole('button', { name: '打开侧栏' }).click();
  const sidebar = page.locator('.sidebar');
  await expect(sidebar.locator('.user-row')).toHaveCount(0);
  await expect(sidebar.locator('.sidebar-footer > button')).toHaveCount(1);
  await expect(sidebar.getByRole('button', { name: '退出登录' })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Token 统计', exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: '搜索会话' })).toHaveCount(0);
  const createRow = await sidebar.locator('.sidebar-create-row').boundingBox();
  const createButton = await sidebar.getByRole('button', { name: '新建会话' }).boundingBox();
  expect(createButton!.width).toBeCloseTo(createRow!.width, 2);
  for (const height of [844, 568, 390]) {
    await page.setViewportSize({ width: 390, height });
    const footer = await sidebar.locator('.sidebar-footer').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(height);
    await expect(sidebar.getByRole('button', { name: '设置', exact: true })).toBeInViewport();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await sidebar.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('main', { name: '工作台设置' });
  await expect(settings.getByRole('tab')).toHaveCount(8);
  await settings.getByRole('tab', { name: '账户', exact: true }).click();
  await expect(settings.getByRole('button', { name: '退出登录' })).toBeVisible();
  await settings.getByRole('tab', { name: '数据', exact: true }).click();
  await expect(settings.getByRole('button', { name: '查看 Token 统计' })).toBeVisible();
  await settings.getByRole('tab', { name: '执行环境', exact: true }).click();
  await page.route('**/api/cli', (route) =>
    route.fulfill({ json: { latest: '1.2.3', current: 'test' } }),
  );
  await page.route('**/api/cli/update', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ version: '1.2.3', confirm: true });
    await route.fulfill({ json: { ok: true, version: '1.2.3' } });
  });
  await settings.getByRole('button', { name: '检查 CLI 更新' }).click();
  await settings.getByRole('button', { name: '更新至 1.2.3' }).click();
  await expect(settings.getByText('已更新至 1.2.3', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '返回工作台' }).click();
  await expect(page.locator('.send-button')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});
