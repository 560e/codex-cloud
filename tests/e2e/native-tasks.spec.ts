import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByText('今天，想完成什么？')).toBeVisible();
}

test('file references persist in a mobile draft and are submitted separately from the question', async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('button', { name: '引用本项目文件', exact: false }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('搜索文件名或路径').fill('hello');
  await dialog.getByRole('button', { name: 'hello.ts', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已选 1 / 10');
  await page.screenshot({
    path: 'test-results/native-file-reference-mobile.png',
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByLabel('发送给 Codex 的消息').fill('检查引用的文件');
  await page.reload();
  await expect(page.getByLabel('引用的项目文件', { exact: true })).toContainText('hello.ts');
  await expect(page.getByLabel('发送给 Codex 的消息')).toHaveValue('检查引用的文件');
  const request = page.waitForRequest(
    (r) => r.url().endsWith('/messages') && r.method() === 'POST',
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({
    text: '检查引用的文件',
    fileReferences: ['hello.ts'],
  });
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('引用的项目文件', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('native review and manual compaction render their real progress and results in the current thread', async ({
  page,
}) => {
  await login(page);
  await page.getByLabel('发送给 Codex 的消息').fill('开始原生功能测试');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '会话菜单', exact: true }).click();
  await page.getByRole('button', { name: '代码审查', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: '审查范围' }).click();
  await page.getByRole('option', { name: '自定义审查要求' }).click();
  await dialog.getByLabel('审查要求').fill('检查输入边界');
  const review = page.waitForRequest(
    (r) => r.url().endsWith('/native-task') && r.method() === 'POST',
  );
  await dialog.getByRole('button', { name: '开始审查', exact: true }).click();
  expect((await review).postDataJSON()).toEqual({
    type: 'review',
    target: { type: 'custom', instructions: '检查输入边界' },
  });
  await expect(page.getByText('模拟审查结果：请检查输入边界。')).toBeVisible();
  await page.getByRole('button', { name: '会话菜单', exact: true }).click();
  await page.getByRole('button', { name: '压缩上下文', exact: true }).click();
  await dialog.getByRole('button', { name: '开始压缩', exact: true }).click();
  await expect(page.getByText('上下文已压缩', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('模拟审查结果：请检查输入边界。')).toBeVisible();
  await expect(page.getByText('上下文已压缩', { exact: true })).toBeVisible();
  await page.screenshot({
    path: 'test-results/native-review-compaction.png',
    animations: 'disabled',
  });
});
