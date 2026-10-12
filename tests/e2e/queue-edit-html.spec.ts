import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByLabel('发送给 Codex 的消息')).toBeVisible();
}

test('queued messages load the full body, save in place, survive reload and send the edited text', async ({
  page,
}) => {
  await login(page);
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill('慢速任务等待后续修改');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const original = '排队正文'.repeat(100);
  await composer.fill(original);
  await page.getByRole('button', { name: '加入队列', exact: true }).click();
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect(page.locator('.message-queue')).toContainText('已暂停');
  await page.getByRole('button', { name: '编辑排队消息 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑待发送消息' });
  await expect(dialog.getByLabel('消息正文')).toHaveValue(original);
  await dialog.getByLabel('消息正文').fill('编辑后最终发送的消息');
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.queue-item')).toHaveCount(1);
  await expect(page.locator('.message-queue')).toContainText('编辑后最终发送的消息');
  await page.reload();
  await expect(page.locator('.message-queue')).toContainText('编辑后最终发送的消息');
  await page.getByRole('button', { name: '继续此会话队列', exact: true }).click();
  await expect(page.locator('.message-queue')).toHaveCount(0);
  await expect(page.locator('.user-message').last()).toContainText('编辑后最终发送的消息');
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`HTML preview loads local styles, images and modules in an isolated interactive frame at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await page.getByLabel('发送给 Codex 的消息').fill('预览页面验证');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '查看文件和改动', exact: true }).click();
    const panel = page.locator('.file-panel');
    await panel.getByRole('button', { name: 'preview-demo', exact: true }).click();
    await panel.getByRole('button', { name: 'index.html', exact: true }).click();
    const frame = page.frameLocator('iframe[title="HTML 预览：preview-demo/index.html"]');
    await expect(frame.getByRole('heading', { name: 'HTML 预览样例' })).toBeVisible();
    await expect(frame.getByRole('heading')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(frame.getByText('工作台已隔离', { exact: true })).toBeVisible();
    await expect(frame.getByText('模块已加载', { exact: true })).toBeVisible();
    await expect(frame.getByRole('img', { name: '本地图片' })).toHaveJSProperty('naturalWidth', 40);
    await frame.getByRole('button', { name: '计数 0' }).click();
    await expect(frame.getByRole('button', { name: '计数 1' })).toBeVisible();
    await expect(panel.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/html-preview-${width}.png`,
      animations: 'disabled',
    });
    await panel.getByRole('button', { name: '源码', exact: true }).click();
    await expect(panel.locator('.source-preview')).toContainText('<h1>HTML 预览样例</h1>');
    await panel.getByRole('button', { name: '预览', exact: true }).click();
    await expect(frame.getByRole('button', { name: '计数 0' })).toBeVisible();
    await panel.getByRole('button', { name: '刷新文件', exact: true }).click();
    await expect(frame.getByText('模块已加载', { exact: true })).toBeVisible();
  });
}
