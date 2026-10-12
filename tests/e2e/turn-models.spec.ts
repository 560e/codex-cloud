import { test, expect, type Page } from '@playwright/test';

async function selectModel(page: Page, name: string) {
  await page.getByRole('combobox', { name: '模型', exact: true }).click();
  await page.getByRole('option', { name: '自定义模型 ID…' }).click();
  await page.getByRole('textbox', { name: '模型 ID', exact: true }).fill(name);
  await page.getByRole('button', { name: '使用此模型' }).click();
}

test('progress and final replies retain their own model when the composer changes and history reloads', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await selectModel(page, 'model-a');
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill('慢速界面验证气泡验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const first = page.locator('.turn').first();
  await expect(first.locator('.assistant-progress').getByLabel('回复模型')).toHaveText('model-a');
  await selectModel(page, 'model-b');
  await expect(first.locator('.assistant-progress').getByLabel('回复模型')).toHaveText('model-a');
  await expect(first.getByLabel('任务执行状态')).toContainText('已完成');
  await expect(first.getByLabel('回复模型')).toHaveText(['model-a', 'model-a']);
  await composer.fill('界面验证气泡验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const second = page.locator('.turn').nth(1);
  await expect(second.getByLabel('任务执行状态')).toContainText('已完成');
  await expect(second.getByLabel('回复模型')).toHaveText(['model-b', 'model-b']);
  await selectModel(page, 'model-c');
  await page.reload();
  await expect(first.getByLabel('回复模型')).toHaveText(['model-a', 'model-a']);
  await expect(second.getByLabel('回复模型')).toHaveText(['model-b', 'model-b']);
  await expect(page.locator('.assistant-role').filter({ hasText: '工作进展' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(first.getByLabel('回复模型').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/turn-models-mobile.png', animations: 'disabled' });
});
