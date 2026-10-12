import { test, expect } from '@playwright/test';

test('conversation search finds repeated text and moves between matches', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill('重复定位词 第一次');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await composer.fill('重复定位词 第二次');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.user-message-bubble')).toHaveCount(2);

  await page.getByRole('button', { name: '搜索当前会话' }).click();
  const dialog = page.getByRole('dialog', { name: '搜索当前会话' });
  await dialog.getByRole('textbox', { name: '搜索关键词' }).fill('重复定位词');
  await expect(dialog).toContainText('1 / 2');
  await dialog.getByRole('button', { name: '下一个匹配' }).click();
  await expect(dialog).toContainText('2 / 2');
  await dialog.getByRole('textbox', { name: '搜索关键词' }).press('Shift+Enter');
  await expect(dialog).toContainText('1 / 2');
  await dialog.getByRole('textbox', { name: '搜索关键词' }).fill('不存在的关键词');
  await expect(dialog).toContainText('无匹配');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const panel = await dialog.boundingBox();
    const input = await dialog.getByRole('textbox').boundingBox();
    const next = await dialog.getByRole('button', { name: '下一个匹配' }).boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(width);
    expect(input!.width).toBeGreaterThan(180);
    expect(next!.y).toBeGreaterThanOrEqual(input!.y + input!.height);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/search-ui-${width}.png` });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: '关闭搜索' }).click();
  await expect(dialog).toHaveCount(0);
});
