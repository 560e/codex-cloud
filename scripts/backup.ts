import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { acquireDataLock } from '../server/data-lock.js';
import { codexHome, userSkillsHome } from '../server/extensions.js';
import { exportMigration } from '../server/migration.js';
const destination = path.resolve(
  process.argv[2] ||
    path.join(
      'backups',
      'codex-cloud-' + new Date().toISOString().replaceAll(':', '-') + '.tar.gz',
    ),
);
if (
  await fs.stat(destination).then(
    () => true,
    () => false,
  )
)
  throw new Error('备份目标已存在');
await fs.mkdir(path.dirname(destination), { recursive: true });
const release = acquireDataLock(config.dataDir);
const store = new Store(config.dataDir);
try {
  const result = await exportMigration(
    store,
    { codexHome: codexHome(), skillsHome: userSkillsHome() },
    destination,
  );
  console.log(
    `完整迁移备份：${destination}\n已校验 ${result.manifest.files.length} 个文件。包含工作台与 Codex 数据及凭据；项目源码与 CLI 安装需另行复制。\n${result.warnings.join('\n')}`,
  );
} finally {
  store.close();
  release();
}
