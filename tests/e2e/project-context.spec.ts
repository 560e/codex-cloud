import { test, expect } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`project 1M context controls use five slider stops and persist at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
    await page.getByRole('button', { name: '进入工作台' }).click();
    await expect(page.getByLabel('发送给 Codex 的消息')).toBeVisible();
    const projects = await (await page.request.get('/api/projects')).json();
    const root = projects[0].path;
    await page.route('**/api/status', async (route) => {
      const response = await route.fetch();
      const result = await response.json();
      result.settings.projectRoots = [root];
      await route.fulfill({ response, json: result });
    });
    await page.getByRole('button', { name: '新增项目', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '添加项目' });
    const toggle = modal.getByRole('checkbox', { name: '启用 1M 上下文' });
    const slider = modal.getByRole('slider', { name: '自动压缩阈值' });
    await expect(toggle).not.toBeChecked();
    await expect(slider).toBeVisible();
    await expect(slider).toHaveValue('90');
    await expect(modal.locator('output')).toHaveText('90% · 当前模型窗口');
    await slider.fill('60');
    await expect(modal.locator('output')).toHaveText('60% · 当前模型窗口');
    await slider.fill('90');
    await toggle.check();
    await expect(slider).toHaveValue('90');
    await expect(modal.locator('output')).toHaveText('90% · 900,000 Token');
    await slider.focus();
    await slider.press('Home');
    await slider.press('ArrowLeft');
    for (const percent of [50, 60, 70, 80, 90]) {
      await expect(slider).toHaveValue(String(percent));
      await expect(modal.locator('output')).toHaveText(
        `${percent}% · ${(percent * 10_000).toLocaleString('en-US')} Token`,
      );
      await slider.press('ArrowRight');
    }
    await expect(slider).toHaveValue('90');
    const bounds = await slider.boundingBox();
    await slider.click({ position: { x: bounds!.width / 2, y: bounds!.height / 2 } });
    await expect(slider).toHaveValue('70');
    await toggle.uncheck();
    await expect(slider).toBeVisible();
    await expect(modal.locator('output')).toHaveText('70% · 当前模型窗口');
    if (width === 1280) await toggle.check();
    await expect(slider).toHaveValue('70');
    const contextBox = await modal.locator('.project-context-options').boundingBox();
    const nameBox = await modal.getByLabel('项目名称', { exact: true }).boundingBox();
    expect(contextBox!.y).toBeLessThan(nameBox!.y);
    const name = `context-${width}-${Date.now()}`;
    await modal.getByLabel('项目根目录').selectOption(root);
    await modal.getByLabel('项目名称', { exact: true }).fill(name);
    await modal.getByLabel('子目录（留空使用根目录）').fill(name);
    await modal.getByRole('checkbox', { name: '创建新目录（支持自动创建多级父目录）' }).check();
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({
      path: `test-results/project-context-${width}.png`,
      animations: 'disabled',
    });
    const submitted = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/projects') && response.request().method() === 'POST',
    );
    await modal.getByRole('button', { name: '添加项目', exact: true }).click();
    const response = await submitted;
    expect(response.ok()).toBe(true);
    const created = await response.json();
    expect(created).toMatchObject({
      name,
      contextWindow1M: width === 1280,
      autoCompactPercent: 70,
    });
    await expect(modal).toHaveCount(0);
    await page.reload();
    const saved = await (await page.request.get('/api/projects')).json();
    expect(saved.find((project: { id: string }) => project.id === created.id)).toMatchObject({
      contextWindow1M: width === 1280,
      autoCompactPercent: 70,
    });
  });
}
