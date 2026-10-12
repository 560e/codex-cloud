import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByText('今天，想完成什么？')).toBeVisible();
}

test('custom selects support keyboard, focus, outside click and mobile placement', async ({
  page,
}) => {
  await login(page);
  const newChat = page.getByRole('button', { name: '新建会话', exact: true });
  await expect(newChat.locator('svg')).toHaveCount(1);
  await expect(newChat).not.toContainText('＋');
  await expect(page.locator('select')).toHaveCount(0);
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  await model.click();
  await expect(page.getByRole('listbox', { name: '模型', exact: true })).toBeVisible();
  await model.press('ArrowDown');
  await model.press('Enter');
  await expect(model).toContainText('Test Codex');
  await expect(model).toBeFocused();
  await model.click();
  await model.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(model).toBeFocused();
  await model.click();
  await page.getByLabel('发送给 Codex 的消息').click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await model.click();
  const box = await page.getByRole('listbox').boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: 'test-results/mobile-controls.png', animations: 'disabled' });
});

test('rich conversation: code, thinking, command, diffs, copy, quote, questions and export', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1400, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.getByLabel('发送给 Codex 的消息').fill('界面验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('heading', { name: '检查结果' })).toBeVisible();
  const answer = page.locator('.assistant-message').last();
  const response = page.getByRole('region', { name: 'Codex 回复', exact: true });
  await expect(response).toHaveCount(1);
  await expect(response.locator('.assistant-identity')).toHaveCount(1);
  await expect(response.locator('.assistant-avatar')).toHaveCount(1);
  await expect(response.getByLabel('任务执行状态')).toContainText('已完成');
  await page.getByRole('heading', { name: '检查结果' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/ai-answer-desktop.png', animations: 'disabled' });
  const code = answer.locator('.code-block');
  await expect(code.locator('pre')).toHaveCSS('white-space', 'pre-wrap');
  await code.getByRole('button', { name: '自动换行', exact: true }).click();
  await expect(code.locator('pre')).toHaveCSS('white-space', 'pre');
  await code.getByRole('button', { name: '自动换行', exact: true }).click();
  await code.getByRole('button', { name: '复制代码' }).click();
  const copiedCode = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedCode).toContain('const longValue');
  expect(copiedCode).not.toContain('自动换行');
  await answer.getByRole('button', { name: '复制 Markdown' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('# 检查结果');
  await answer.getByRole('button', { name: '引用追问' }).click();
  const composer = page.getByLabel('发送给 Codex 的消息');
  await expect(composer).toBeFocused();
  await expect(composer).toContainText('');
  await expect(composer).toHaveValue('');
  await expect(page.locator('.reference-card')).toContainText('# 检查结果');
  await page.getByRole('button', { name: '移除引用 1' }).click();
  await expect(page.locator('.reference-card')).toHaveCount(0);
  await composer.fill('');
  await answer.getByRole('button', { name: '整理说明', exact: true }).click();
  expect(await composer.inputValue()).toContain('接下来如何处理？\n整理说明');
  await composer.fill('');
  const downloadEvent = page.waitForEvent('download');
  await answer.getByRole('button', { name: '导出', exact: true }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('codex-reply.md');
  await page.locator('.reasoning > summary').click();
  await expect(page.locator('.reasoning')).toContainText('先检查结构，再验证行为。');
  await expect(page.locator('.reasoning')).toContainText('已核对目录和变更范围。');
  await expect(page.locator('.reasoning pre')).toHaveCSS('white-space', 'pre-wrap');
  const command = page
    .locator('.tool-card')
    .filter({ has: page.locator('summary .tool-title', { hasText: 'node --version' }) });
  await command.locator('summary').click();
  await expect(command).toContainText('退出码：0');
  await expect(command).toContainText('1.25 秒');
  await expect(command).toContainText('v24.18.0');
  await expect(page.locator('.file-changes')).not.toHaveAttribute('open');
  await page.locator('.file-changes > summary').click();
  const file = page.locator('.file-change-detail').filter({ hasText: 'src/hello.ts' });
  await file.locator('summary').click();
  await expect(file.locator('.diff-counts')).toContainText('+1');
  await expect(file.locator('.diff-counts')).toContainText('−1');
  await file.getByRole('button', { name: '切换并排对比' }).click();
  await expect(file.getByRole('table', { name: '并排差异' })).toBeVisible();
  await file.getByRole('button', { name: '复制差异' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('@@ -1,2 +1,2 @@');
  await page.locator('.compaction-event').scrollIntoViewIfNeeded();
  await expect(page.locator('.compaction-event')).toContainText('上下文已压缩');
  await expect(page.locator('.context-usage')).toContainText('1,200');
  await page.locator('.reasoning').scrollIntoViewIfNeeded();
  const scrollButton = await page.getByRole('button', { name: '回到最新消息' }).boundingBox();
  const composerBox = await page.locator('.thread-composer').boundingBox();
  expect(scrollButton!.y + scrollButton!.height).toBeLessThanOrEqual(composerBox!.y);
  await page.screenshot({ path: 'test-results/rich-tools.png', animations: 'disabled' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '切换至暗色主题' }).click();
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await page.screenshot({ path: 'test-results/rich-tools-dark.png', animations: 'disabled' });
  await page.getByRole('heading', { name: '检查结果' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/ai-answer-dark.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await answer.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/rich-mobile.png', animations: 'disabled' });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    }),
  );
  await answer.getByRole('button', { name: '复制 Markdown' }).click();
  await expect(answer.getByText('复制失败，请选中文本复制', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
