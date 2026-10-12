import { test, expect } from '@playwright/test';

test('admin settings retain drafts across keyboard navigation and adapt to desktop and mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('main', { name: '工作台设置' });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await settings.getByLabel('个人模型列表（每行一个 ID）').fill('draft-model');
  await settings.getByRole('tab', { name: '常规', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(settings.getByRole('tab', { name: '项目', exact: true })).toBeFocused();
  await expect(settings.getByLabel('项目系统提示词内容')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(settings.getByLabel('个人模型列表（每行一个 ID）')).toHaveValue('draft-model');
  const navigation = await settings.locator('.settings-navigation').boundingBox();
  const content = await settings.locator('.settings-content').boundingBox();
  expect(navigation!.x + navigation!.width).toBeLessThan(content!.x);
  expect(content!.width).toBeGreaterThan(700);
  await settings.getByRole('heading', { name: '常规设置' }).click();
  await page.screenshot({ path: 'test-results/settings-page-desktop.png', animations: 'disabled' });
  await settings.getByRole('button', { name: '保存默认设置' }).click();
  await expect(settings.getByText('默认设置已保存')).toBeVisible();
  await settings.getByRole('button', { name: '切换至暗色主题' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(settings.getByLabel('个人模型列表（每行一个 ID）')).toHaveValue('draft-model');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of [
    '项目',
    '归档会话',
    '供应商',
    '扩展与迁移',
    '执行环境',
    '数据',
    '账户',
    '常规',
  ]) {
    await settings.getByRole('tab', { name, exact: true }).click();
    await expect(settings.getByRole('tabpanel')).toHaveCount(1);
    expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.screenshot({ path: 'test-results/settings-page-mobile.png', animations: 'disabled' });
});
