import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { Auth, hashPassword } from '../server/auth.js';
import { Workbench } from '../server/workbench.js';
import { buildApp } from '../server/app.js';
import { MockCodex } from './mock-codex.js';
// Refuse to seed sample projects or replace passwords in the real workbench.
const testRoot = path.resolve('.test-data');
const testRelative = path.relative(testRoot, config.dataDir);
if (
  process.env.WORKBENCH_TEST_FIXTURE !== '1' ||
  !testRelative ||
  testRelative.startsWith('..') ||
  path.isAbsolute(testRelative) ||
  config.port !== 18479
) {
  throw new Error('模拟服务仅允许由测试命令启动，使用 .test-data 子目录和 18479 端口。');
}
const store = new Store(config.dataDir, true);
process.env.CODEX_HOME = config.dataDir + '-codex-fixture';
process.env.CODEX_CLOUD_SKILLS_HOME = config.dataDir + '-skills-fixture';
await new Auth(store).change('test-password-long');
const projectDir = path.join(config.dataDir, 'sample-project');
await fs.mkdir(projectDir, { recursive: true });
await fs.writeFile(path.join(projectDir, 'hello.ts'), 'export const hello = "world";\n');
const previewDir = path.join(projectDir, 'preview-demo');
await fs.mkdir(previewDir, { recursive: true });
await fs.writeFile(
  path.join(previewDir, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./preview.css"></head><body><h1>HTML 预览样例</h1><button id="counter">计数 0</button><p id="isolation"></p><p id="module"></p><img alt="本地图片" src="./preview.svg"><script src="./preview.js"></script><script type="module" src="./module.js"></script></body></html>`,
);
await fs.writeFile(path.join(previewDir, 'preview.css'), 'h1 { color: rgb(12, 34, 56); }');
await fs.writeFile(
  path.join(previewDir, 'preview.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>',
);
await fs.writeFile(
  path.join(previewDir, 'preview.js'),
  `let n = 0; document.querySelector('#counter').onclick = () => { document.querySelector('#counter').textContent = '计数 ' + (++n); }; try { parent.document.title; document.querySelector('#isolation').textContent = 'not isolated'; } catch { document.querySelector('#isolation').textContent = '工作台已隔离'; }`,
);
await fs.writeFile(
  path.join(previewDir, 'module.js'),
  `import { message } from './helper.js'; document.querySelector('#module').textContent = message;`,
);
await fs.writeFile(path.join(previewDir, 'helper.js'), `export const message = '模块已加载';`);
if (!store.projects().length) store.addProject('测试示例项目（模拟）', projectDir);
const bridge = new MockCodex(projectDir);
let balanceQueries = 0;
const workbench = new Workbench(bridge, store, 3, async () => ({
  status: 'available',
  checkedAt: Date.now(),
  providerName: '模拟余额上游',
  remaining: 100 - ++balanceQueries * 0.125,
  unit: 'USD',
  isValid: true,
}));
const app = await buildApp(store, workbench, { logger: false });
await bridge.start();
await app.listen({ host: '127.0.0.1', port: config.port });
console.log(`Fixture ready at ${config.origin}`);
const stop = async () => {
  await app.close();
  bridge.stop();
  store.close();
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
