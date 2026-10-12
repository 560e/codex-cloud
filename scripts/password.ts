import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { Auth } from '../server/auth.js';

const passwordVariable = 'WORKBENCH_PASSWORD';

async function hidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(`非交互运行请通过 ${passwordVariable} 环境变量传入密码`);
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (data: string) => {
      for (const char of data) {
        if (char === '\u0003') {
          finish();
          reject(new Error('已取消'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
try {
  const password =
    process.env[passwordVariable] || (await hidden('设置工作台密码（至少 8 位，输入不回显）：'));
  if (password.length < 8 || password.length > 1024) throw new Error('密码必须为 8–1024 个字符');
  if (!process.env[passwordVariable] && password !== (await hidden('再次输入密码：')))
    throw new Error('两次密码不一致');
  const store = new Store(config.dataDir);
  await new Auth(store).change(password);
  store.close();
  console.log('密码已更新。所有旧登录已失效；执行任务不受影响。');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
