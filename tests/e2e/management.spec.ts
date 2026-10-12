import { test, expect } from '@playwright/test';
import path from 'node:path';

test('project prompts, Skills, MCP and portable migration work from mobile settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('main', { name: '工作台设置' });
  await settings.getByRole('tab', { name: '项目', exact: true }).click();
  await settings.getByLabel('项目系统提示词内容').fill('用中文回答，遵循本项目风格。');
  await settings.getByRole('button', { name: '保存项目提示词' }).click();
  await expect(settings.getByText('项目提示词已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(settings.getByLabel('项目系统提示词内容')).toHaveValue(
    '用中文回答，遵循本项目风格。',
  );
  await settings.getByRole('tab', { name: '扩展与迁移', exact: true }).click();
  const management = settings.getByRole('region', { name: '扩展与数据迁移' });
  await expect(management.getByRole('button', { name: '新增 MCP' })).toBeVisible();
  const name = 'mobile-skill-' + Date.now();
  await management.getByRole('button', { name: '新建 Skill' }).click();
  await management.getByLabel('Skill 目录名').fill(name);
  await management
    .getByLabel('Skill 内容')
    .fill(`---\nname: ${name}\ndescription: 手机设置测试\n---\n运行项目检查。\n`);
  await management.getByRole('button', { name: '保存 Skill', exact: true }).click();
  const skill = management.locator('.management-item').filter({ hasText: name });
  await expect(skill.locator(':scope > div:first-child')).toHaveText(name);
  await skill.getByRole('button', { name: '停用', exact: true }).click();
  await expect(skill.locator(':scope > div:first-child')).toHaveText(name);
  await skill.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(management.getByLabel('Skill 内容')).toContainText('运行项目检查。');
  await management.getByRole('button', { name: '取消编辑', exact: true }).click();
  const mcpName = 'mobile-mcp-' + Date.now();
  await management.getByRole('button', { name: '新增 MCP' }).click();
  await management.getByLabel('MCP 名称', { exact: true }).fill(mcpName);
  await management.getByLabel('MCP 启动命令').fill('node');
  await management.getByLabel('MCP 启动参数').fill('example.js');
  await management.getByRole('button', { name: '保存 MCP', exact: true }).click();
  const mcp = management.locator('.management-item').filter({ hasText: mcpName });
  await expect(mcp.locator(':scope > div:first-child')).toHaveText(mcpName);
  await mcp.getByRole('button', { name: '停用', exact: true }).click();
  await expect(mcp.locator(':scope > div:first-child')).toHaveText(mcpName);
  const download = page.waitForEvent('download');
  await management.getByRole('button', { name: '导出完整迁移包' }).click();
  const downloaded = await download;
  const archive = path.resolve('test-results/portable-migration.tar.gz');
  await downloaded.saveAs(archive);
  await expect(management.getByText('迁移包已导出，请妥善保存其中的凭据')).toBeVisible();
  await management.getByLabel('导入迁移包', { exact: true }).setInputFiles(archive);
  await expect(management.getByRole('button', { name: '确认导入并重新登录' })).toBeVisible();
  await expect(management.getByLabel('迁移项目目录 测试示例项目（模拟）')).not.toHaveValue('');
  await management.getByRole('button', { name: '确认导入并重新登录' }).click();
  await expect(page.getByLabel('工作台密码', { exact: true })).toBeVisible();
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(settings.getByLabel('项目系统提示词内容')).toHaveValue(
    '用中文回答，遵循本项目风格。',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
