import { test, expect } from '@playwright/test';

test('settings groups archived conversations by project and restores them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByLabel('发送给 Codex 的消息').fill('归档设置恢复验证');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();

  const project = (await (await page.request.get('/api/projects')).json())[0] as {
    id: string;
    name: string;
  };
  const regular = await (
    await page.request.get(`/api/threads?project=${encodeURIComponent(project.id)}`)
  ).json();
  const thread = regular.data[0] as { id: string; preview: string };
  await page.evaluate(async (threadId) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive' }),
    });
    if (!response.ok) throw new Error(await response.text());
  }, thread.id);

  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('main', { name: '工作台设置' });
  await settings.getByRole('tab', { name: '归档会话', exact: true }).click();
  const group = settings.locator('.archived-project').filter({ hasText: project.name });
  await expect(group).toBeVisible();
  await expect(group).toContainText(thread.id.slice(-8));
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );

  await group.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(group).toHaveCount(0);
  await expect(settings.getByText('暂无归档会话', { exact: true })).toBeVisible();

  const archived = await (
    await page.request.get(`/api/threads?archived=true&project=${encodeURIComponent(project.id)}`)
  ).json();
  expect(archived.data.some((item: { id: string }) => item.id === thread.id)).toBe(false);
  const restored = await (
    await page.request.get(`/api/threads?project=${encodeURIComponent(project.id)}`)
  ).json();
  expect(restored.data.some((item: { id: string }) => item.id === thread.id)).toBe(true);
});
