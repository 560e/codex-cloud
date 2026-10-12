import { test, expect } from '@playwright/test';

test('empty and whitespace-only reasoning stays hidden after completion and reload', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByLabel('发送给 Codex 的消息').fill('空思考验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByLabel('任务执行状态')).toContainText('已完成');
  await expect(page.locator('.reasoning')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('任务执行状态')).toContainText('已完成');
  await expect(page.locator('.reasoning')).toHaveCount(0);
});
