import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('touch layout fits narrow and landscape screens and follows the visible keyboard viewport', async ({
  page,
}) => {
  await page.goto('/');
  const password = page.getByLabel('工作台密码', { exact: true });
  await expect(password).toHaveCSS('font-size', '16px');
  await password.fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  const composer = page.getByLabel('发送给 Codex 的消息');
  await expect(composer).toHaveCSS('font-size', '16px');

  for (const size of [
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    await expect(page.locator('.sidebar')).toHaveCSS('position', 'fixed');
    await expect(page.locator('.sidebar')).toHaveCSS('transform', /matrix\(1, 0, 0, 1, -/);
    await expect(page.getByRole('button', { name: '添加附件', exact: true })).toHaveCSS(
      'width',
      '44px',
    );
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(size.width);
    const send = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
    expect(send!.x + send!.width).toBeLessThanOrEqual(size.width);
    await page.screenshot({ path: `test-results/touch-${size.width}.png`, animations: 'disabled' });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await composer.fill('手机键盘布局验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.thread-composer')).toBeVisible();
  // Emulate a keyboard resize without a layout viewport resize (Safari/Android behavior).
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport!, {
      height: { configurable: true, value: 360 },
      offsetTop: { configurable: true, value: 40 },
    });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.workspace')).toHaveCSS('height', '360px');
  await expect(page.locator('.workspace')).toHaveCSS('top', '40px');
  const send = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
  expect(send!.y + send!.height).toBeLessThanOrEqual(400);
  await page.getByRole('combobox', { name: '模型', exact: true }).click();
  const popup = await page.getByRole('listbox', { name: '模型', exact: true }).boundingBox();
  expect(popup!.y).toBeGreaterThanOrEqual(40);
  expect(popup!.y + popup!.height).toBeLessThanOrEqual(400);
  await page.getByRole('combobox', { name: '模型', exact: true }).press('Escape');

  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport!, {
      height: { configurable: true, value: 180 },
      scale: { configurable: true, value: 2 },
    });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.workspace')).toHaveCSS('height', '360px');
  await page.evaluate(() => {
    for (const key of ['height', 'offsetTop', 'scale'])
      Reflect.deleteProperty(window.visualViewport!, key);
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.workspace')).toHaveCSS('height', '844px');
  await expect(page.locator('.workspace')).toHaveCSS('top', '0px');
});
