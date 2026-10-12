import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('settings clean server data; deleting a session removes attachments and syncs another tab', async ({
  page,
  context,
}) => {
  const dataDir = path.resolve('.test-data/e2e');
  const log = path.join(dataDir, 'logs', 'maintenance-test.log');
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, 'persisted test log');
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByLabel('发送给 Codex 的消息').fill('将被永久删除的会话');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  const id = await page.evaluate(() => sessionStorage.getItem('selectedThread'));
  await page.locator('input[type=file]').setInputFiles({
    name: 'delete-owned.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('uploaded secret'),
  });
  await expect(page.locator('.attachments')).toContainText('delete-owned.txt');
  const db = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'), { readOnly: true });
  let uploadedPath: string;
  try {
    uploadedPath = String(
      db.prepare('SELECT path FROM attachments WHERE thread_id=?').get(id!)!.path,
    );
  } finally {
    db.close();
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('main', { name: '工作台设置' });
  await settings.getByRole('tab', { name: '数据', exact: true }).click();
  await expect(settings).toContainText('服务器数据清理');
  await settings.getByRole('button', { name: '清除缓存', exact: true }).click();
  await settings.getByRole('button', { name: '确认清理' }).click();
  await expect(settings.locator('.maintenance-result')).toContainText('从服务器数据库清除');
  await settings.getByRole('button', { name: '清除日志', exact: true }).click();
  await settings.getByRole('button', { name: '确认清理' }).click();
  await expect(settings.locator('.maintenance-result')).toContainText('已清空');
  expect((await fs.stat(log)).size).toBe(0);
  expect(await fs.readFile(uploadedPath!, 'utf8')).toBe('uploaded secret');
  await page.screenshot({ path: 'test-results/maintenance-settings.png', animations: 'disabled' });
  await settings.getByRole('button', { name: '返回工作台' }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.addInitScript((threadId) => sessionStorage.setItem('selectedThread', threadId!), id);
  await other.goto('/');
  await expect(other.getByText('已完成你的任务。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除会话 将被永久删除的会话', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('上传附件');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(
    await fs.stat(uploadedPath!).then(
      () => true,
      () => false,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: '删除会话 将被永久删除的会话', exact: true }).click();
  await page.getByRole('button', { name: '确认永久删除' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('今天，想完成什么？')).toBeVisible();
  await expect(other.getByText('今天，想完成什么？')).toBeVisible();
  expect(
    await fs.stat(uploadedPath!).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  const disk = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'), { readOnly: true });
  try {
    for (const table of ['attachments', 'message_queue', 'runs', 'thread_deletions'])
      expect(disk.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id=?`).get(id!)!.n).toBe(
        0,
      );
    expect(
      disk
        .prepare("SELECT COUNT(*) AS n FROM events WHERE params LIKE '%将被永久删除的会话%'")
        .get()!.n,
    ).toBe(0);
  } finally {
    disk.close();
  }
  await page.reload();
  await expect(
    page.getByRole('button', { name: '删除会话 将被永久删除的会话', exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get(`/api/threads/${id}`)).status()).toBe(404);
  await other.close();
});
