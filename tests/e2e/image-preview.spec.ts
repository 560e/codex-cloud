import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('file drawer previews images and zooms without leaving the workbench on desktop and mobile', async ({
  page,
}) => {
  const folder = path.resolve('.test-data/e2e/sample-project');
  const name = '预览 #1.svg';
  await fs.writeFile(
    path.join(folder, name),
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#1677ff"/><text x="100" y="200" font-size="80" fill="white">Image preview</text></svg>',
  );
  await fs.writeFile(path.join(folder, 'broken.png'), 'invalid image');
  try {
    await page.goto('/');
    await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
    await page.getByRole('button', { name: '进入工作台' }).click();
    await page.locator('.project-entry > button').first().click();
    await page.getByRole('button', { name: '查看文件和改动' }).click();
    const panel = page.locator('.file-panel');
    await panel.getByRole('button', { name, exact: true }).click();
    await expect(panel.getByText('1600 × 900')).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await panel.getByRole('button', { name: '放大查看图片', exact: true }).click();
      const dialog = page.getByRole('dialog', { name });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: '原始大小' }).click();
      await expect(dialog.getByLabel('缩放比例')).toHaveText('100%');
      await dialog.getByRole('button', { name: '放大图片', exact: true }).click();
      await expect(dialog.getByLabel('缩放比例')).toHaveText('125%');
      await dialog.getByRole('button', { name: '缩小图片', exact: true }).click();
      await expect(dialog.getByLabel('缩放比例')).toHaveText('100%');
      await dialog.getByRole('button', { name: '适应窗口' }).click();
      await expect(dialog.getByLabel('缩放比例')).not.toHaveText('100%');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `test-results/image-preview-${width}.png` });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(panel.getByRole('button', { name: '放大查看图片' })).toBeFocused();
    }
    await panel.getByRole('button', { name: '上一级' }).click();
    await panel.getByRole('button', { name: 'broken.png', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('无法解码');
    await expect(panel.getByRole('link', { name: '下载文件' })).toBeVisible();
    await panel.getByRole('button', { name: '上一级' }).click();
    await panel.getByRole('button', { name: 'hello.ts', exact: true }).click();
    await expect(panel.locator('.source-preview')).toContainText('export const hello');
  } finally {
    await fs.rm(path.join(folder, name), { force: true });
    await fs.rm(path.join(folder, 'broken.png'), { force: true });
  }
});
