import { test, expect } from '@playwright/test';

test('individual bubbles preserve progress, selected quotes and steered message order after reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  const composer = page.getByLabel('发送给 Codex 的消息');
  await composer.fill('慢速界面验证气泡验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const progress = page.locator('.assistant-progress');
  await expect(progress).toContainText('检查页面结构');
  const bubble = await progress.locator('.assistant-message-bubble').boundingBox();
  const body = await progress.locator('.message-body').boundingBox();
  expect(bubble!.width).toBeLessThan(body!.width - 30);
  await page.screenshot({
    path: 'test-results/message-bubbles-progress.png',
    animations: 'disabled',
  });
  await page.getByRole('combobox', { name: '执行中发送方式' }).click();
  await page.getByRole('option', { name: '立即补充' }).click();
  await composer.fill('请保留代码和文件差异');
  await page.getByRole('button', { name: '补充指令', exact: true }).click();
  await expect(page.getByRole('heading', { name: '检查结果' })).toBeVisible();

  async function checkOrder() {
    const turn = page.locator('.turn');
    await expect(turn).toHaveCount(1);
    await expect(turn.locator('.assistant-message-bubble')).toHaveCount(2);
    await expect(turn.locator('.assistant-avatar')).toHaveCount(2);
    const order = await turn.locator(':scope > *').evaluateAll((nodes) =>
      nodes.map((node) => ({
        user: node.classList.contains('user-message'),
        text: node.textContent,
      })),
    );
    expect(order.map((node) => node.user)).toEqual([true, false, true, false]);
    expect(order[1].text).toContain('检查页面结构');
    expect(order[2].text).toContain('请保留代码和文件差异');
    expect(order[3].text).toContain('检查结果');
    const summaries = turn.getByLabel('任务执行状态');
    await expect(summaries).toHaveCount(1);
    await expect(summaries).toContainText('已完成');
  }
  await checkOrder();
  await page.reload();
  await checkOrder();

  await progress.locator('.markdown p').evaluate((paragraph) => {
    const node = paragraph.firstChild!;
    const start = node.textContent!.indexOf('检查页面结构');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + '检查页面结构'.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await progress.getByRole('button', { name: '引用追问' }).click();
  await expect(page.locator('.reference-card')).toContainText('检查页面结构');
  await expect(page.locator('.reference-card')).not.toContainText('再调整消息气泡');
  await page.getByRole('button', { name: '移除引用 1' }).click();
  await progress.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'test-results/message-bubbles-desktop.png',
    animations: 'disabled',
  });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await progress.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/message-bubbles-mobile-${theme}.png`,
      animations: 'disabled',
    });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const boxes = await page.locator('.assistant-message-bubble').evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        }),
      );
      for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(width);
      }
    }
  }
});
