import { test, expect } from '@playwright/test';

test('unified task summary refreshes token, duration and balance and survives reload on mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill(`余额验证 ${Date.now()}`);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const balances = page.getByLabel('上游余额', { exact: true });
  await expect(balances).toHaveCount(1);
  await expect(balances.first().locator('.task-cost .task-metric-value')).toHaveText('≈ $0.1250');
  await expect(balances.first().locator('.task-remaining .task-metric-value')).toHaveText(
    /^\$-?\d+\.\d{2}$/,
  );
  const summary = page.getByLabel('任务执行状态').first();
  await expect(summary).toContainText('已完成');
  await expect(summary.getByLabel('本轮 Token 用量')).toHaveCount(1);
  await expect(summary.locator('.task-cost')).toContainText('本轮消费');
  await expect(summary.locator('.task-remaining')).toContainText('剩余余额');
  const first = (await balances.first().textContent())!;
  await expect(summary.locator('.task-summary-header .task-time')).toContainText('总用时');
  await composer.fill('再次查询余额');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(balances).toHaveCount(2);
  await expect(balances.last().locator('.task-cost .task-metric-value')).toHaveText('≈ $0.1250');
  expect(await balances.last().textContent()).not.toBe(first);
  await page.reload();
  await expect(balances).toHaveCount(2);
  await expect(balances.first()).toHaveText(first);
  await page.getByLabel('任务执行状态').last().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'test-results/task-summary-desktop.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(balances.last()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results/upstream-balance-mobile.png',
    animations: 'disabled',
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({
    path: 'test-results/task-summary-mobile-dark.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
