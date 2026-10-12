import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('工作台密码', { exact: true }).fill('test-password-long');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByText('今天，想完成什么？')).toBeVisible();
}

test('provider models are fetched only on click and remain cached across page reloads', async ({
  page,
}) => {
  let calls = 0;
  let fail = false;
  let models = ['fetched-fast', 'fetched-deep'];
  const upstream = createServer((req, res) => {
    if (req.url === '/v1/models') {
      calls++;
      if (fail) res.writeHead(503);
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    } else res.end(JSON.stringify({ remaining: 10 }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let id = '';
  const headers = { origin: 'http://127.0.0.1:18479' };
  try {
    await login(page);
    const saved = await page.request.post('/api/providers', {
      headers,
      data: {
        name: '模型获取测试',
        baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        apiKey: 'test-only-model-key',
        model: 'kept-default',
      },
    });
    expect(saved.ok()).toBe(true);
    id = (await saved.json()).id;
    await page.request.post('/api/providers/active', { headers, data: { id } });
    const openProviders = async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('tab', { name: '供应商', exact: true }).click();
    };
    await openProviders();
    const panel = page.getByRole('region', { name: '模型供应商' });
    const button = panel.getByRole('button', { name: '获取 模型获取测试模型', exact: true });
    await expect(button).toBeVisible();
    expect(calls).toBe(0);
    await button.click();
    await expect(panel.getByRole('status')).toContainText('2 个模型并保存');
    expect(calls).toBe(1);
    await expect(panel).toContainText('上次获取：');
    await page.getByRole('button', { name: '返回工作台', exact: true }).click();
    await page.getByRole('combobox', { name: '模型', exact: true }).click();
    await expect(page.getByRole('option', { name: /fetched-fast/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await openProviders();
    await expect(button).toBeVisible();
    expect(calls).toBe(1);
    await panel.getByRole('button', { name: '编辑 模型获取测试', exact: true }).click();
    await expect(panel.getByLabel('可选模型 ID（每行一个）')).toHaveValue(
      'fetched-fast\nfetched-deep',
    );
    models = ['updated-model'];
    await button.click();
    await expect(panel.getByRole('status')).toContainText('1 个模型并保存');
    await expect(panel.getByLabel('可选模型 ID（每行一个）')).toHaveValue('updated-model');
    expect(calls).toBe(2);
    fail = true;
    await button.click();
    await expect(panel.getByRole('alert')).toContainText('HTTP 503');
    await expect(panel.getByLabel('可选模型 ID（每行一个）')).toHaveValue('updated-model');
    const persisted = (await (await page.request.get('/api/providers')).json()).profiles.find(
      (p: { id: string }) => p.id === id,
    );
    expect(persisted.models).toEqual(['updated-model']);
    expect(persisted.model).toBe('kept-default');
    expect(calls).toBe(3);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(button).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await page.request.post('/api/providers/active', { headers, data: { id: null } });
    if (id) await page.request.delete(`/api/providers/${id}`, { headers });
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test('logged-in users manage providers on mobile without extra passwords or exposed keys', async ({
  page,
  browser,
}) => {
  let remaining = 12.3456;
  let balanceFailed = false;
  await page.route('**/api/providers/*/balance', async (route) => {
    await route.fulfill({
      json: route.request().url().includes('/default/')
        ? { status: 'unavailable', checkedAt: Date.now() }
        : balanceFailed
          ? { status: 'error', checkedAt: Date.now() }
          : { status: 'available', remaining, unit: 'USD', checkedAt: Date.now() },
    });
  });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '供应商', exact: true }).click();
  const panel = page.getByRole('region', { name: '模型供应商' });
  const capabilities = page.getByRole('region', { name: '供应商能力' });
  await expect(capabilities).toContainText('网页搜索');
  await expect(capabilities).toContainText('未声明支持');
  await expect(panel.getByLabel('供应商管理密码')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '添加供应商' })).toBeVisible();
  const key = 'test-e2e-private-provider-key';
  const url = 'https://classroom.example.test/v1';
  const profiles: string[] = [];
  const student = await browser.newContext();
  try {
    for (const name of ['课堂欧洲线路', '课堂亚洲线路']) {
      await panel.getByRole('button', { name: '添加供应商' }).click();
      await panel.getByLabel('供应商名称', { exact: true }).fill(name);
      await panel.getByLabel('API 基础地址', { exact: true }).fill(url);
      await panel.getByLabel('API Key', { exact: true }).fill(key);
      if (name === '课堂欧洲线路')
        await panel.getByLabel('默认模型 ID', { exact: true }).fill('classroom-model');
      await panel.getByLabel('可选模型 ID（每行一个）').fill('classroom-fast\nclassroom-deep');
      await panel.getByRole('button', { name: '保存供应商', exact: true }).click();
      await expect(panel.getByRole('button', { name: `编辑 ${name}`, exact: true })).toBeVisible();
    }
    const listed = await (await page.request.get('/api/providers')).json();
    profiles.push(
      ...listed.profiles
        .filter((p: { name: string }) => p.name.startsWith('课堂'))
        .map((p: { id: string }) => p.id),
    );
    expect(JSON.stringify(listed)).not.toContain(key);
    const balance = panel.getByLabel('课堂欧洲线路当前余额', { exact: true });
    await expect(balance).toContainText('当前余额：12.3456 $');
    remaining = 0;
    await balance.getByRole('button', { name: '刷新 课堂欧洲线路余额' }).click();
    await expect(balance).toContainText('当前余额：0 $');
    balanceFailed = true;
    await balance.getByRole('button', { name: '刷新 课堂欧洲线路余额' }).click();
    await expect(balance).toContainText('查询失败');
    balanceFailed = false;
    await balance.getByRole('button', { name: '刷新 课堂欧洲线路余额' }).click();
    await expect(balance).toContainText('当前余额：0 $');
    await expect(panel.getByLabel('服务器默认配置当前余额', { exact: true })).toContainText(
      '暂不支持查询',
    );
    await panel.getByRole('button', { name: '切换到 课堂欧洲线路', exact: true }).click();
    await panel.getByRole('button', { name: '确认切换', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('供应商已切换');
    await expect(capabilities).toContainText('命名空间工具');
    expect((await (await page.request.get('/api/models')).json()).data[0].model).toBe(
      'classroom-model',
    );
    expect(
      (await (await page.request.get('/api/models')).json()).data.map(
        (m: { model: string }) => m.model,
      ),
    ).toEqual(['classroom-model', 'classroom-fast', 'classroom-deep']);
    await panel.getByRole('button', { name: '编辑 课堂欧洲线路', exact: true }).click();
    await expect(panel.getByLabel('可选模型 ID（每行一个）')).toHaveValue(
      'classroom-fast\nclassroom-deep',
    );
    await expect(panel.getByLabel('API Key（留空保留原值）', { exact: true })).toHaveValue('');
    await panel.getByLabel('默认模型 ID', { exact: true }).fill('');
    await panel.getByRole('button', { name: '保存供应商', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('当前供应商已重新连接');
    expect(
      (await (await page.request.get('/api/providers/access')).json()).active.model,
    ).toBeNull();
    await expect(panel).toContainText('沿用 CLI 默认模型');
    expect(
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      ),
    ).not.toContain(key);
    const other = await student.newPage();
    await login(other);
    await other.getByRole('button', { name: '设置', exact: true }).click();
    await other.getByRole('tab', { name: '供应商', exact: true }).click();
    const publicPanel = other.getByRole('region', { name: '模型供应商' });
    await expect(publicPanel).toContainText('课堂欧洲线路');
    await expect(publicPanel).toContainText(url);
    expect((await other.request.get('/api/providers')).status()).toBe(200);
    expect(await (await other.request.get('/api/providers')).text()).not.toContain(key);
    const access = await (await other.request.get('/api/providers/access')).text();
    expect(access).not.toContain(key);
    expect(access).not.toContain(url);
    await panel.getByRole('button', { name: '切换到 课堂亚洲线路', exact: true }).click();
    await panel.getByRole('button', { name: '确认切换', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('供应商已切换');
    await page.screenshot({ path: 'test-results/providers-mobile.png', animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await panel.getByRole('button', { name: '切换至默认配置', exact: true }).click();
    await panel.getByRole('button', { name: '确认切换', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('供应商已切换');
  } finally {
    await page.request.post('/api/providers/active', {
      headers: { origin: new URL(page.url()).origin },
      data: { id: null },
    });
    for (const id of profiles)
      await page.request.delete(`/api/providers/${id}`, {
        headers: { origin: new URL(page.url()).origin },
      });
    await student.close();
  }
});
