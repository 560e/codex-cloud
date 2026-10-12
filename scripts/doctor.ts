import { config } from '../server/config.js';
import { CodexBridge, resolveCodex } from '../server/codex.js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
console.log(
  `Node: ${process.version}\n账户: ${os.userInfo().username}\n系统: ${process.platform}\n数据: ${config.dataDir}\n地址: ${config.origin}\n后端: ${config.host}:${config.port}`,
);
const bridge = new CodexBridge(config.codexBin);
try {
  const bin = resolveCodex(config.codexBin);
  console.log(`Codex 启动入口: ${[bin.command, ...bin.args].join(' ')}`);
  console.log(
    execFileSync(bin.command, [...bin.args, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
  );
  console.log(`Codex home: ${process.env.CODEX_HOME || path.join(os.homedir(), '.codex')}`);
  console.log(`前端构建: ${existsSync('dist/client/index.html') ? '存在' : '尚未构建'}`);
  await bridge.start();
  const results = await Promise.allSettled([
    bridge.call('model/list', {}),
    bridge.call('account/read', {}),
    bridge.call('thread/list', { limit: 1 }),
  ]);
  results.forEach((r, i) => {
    const name = ['模型列表', '账户状态', '会话列表'][i];
    console.log(`${name}: ${r.status === 'fulfilled' ? '可用' : r.reason.message}`);
    if (r.status === 'rejected') process.exitCode = 1;
  });
  const account = results[1];
  if (account.status === 'fulfilled')
    console.log(
      `认证方式: ${account.value.account?.type || '由服务器配置决定'}；需要 OpenAI 认证: ${account.value.requiresOpenaiAuth}`,
    );
  console.log('协议基线: 0.155.1。此诊断不发送模型任务，也不修改项目文件。');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  bridge.stop();
}
