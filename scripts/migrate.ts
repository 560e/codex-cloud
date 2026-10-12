import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { acquireDataLock } from '../server/data-lock.js';
import { codexHome, userSkillsHome } from '../server/extensions.js';
import { exportMigration, restoreOffline, unpackMigration } from '../server/migration.js';

const [action, archiveArg, ...args] = process.argv.slice(2);
if (!archiveArg || !['export', 'inspect', 'import'].includes(action))
  throw new Error(
    '用法：npm run migrate -- export|inspect|import 文件.tar.gz [--mapping 路径映射.json] [--data-dir 目录] [--codex-home 目录] [--skills-home 目录]',
  );
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (
    !['--mapping', '--data-dir', '--codex-home', '--skills-home'].includes(args[i]) ||
    !args[i + 1]
  )
    throw new Error('参数无效');
  options.set(args[i], args[i + 1]);
}
const archive = path.resolve(archiveArg);
const homes = {
  codexHome: path.resolve(options.get('--codex-home') || codexHome()),
  skillsHome: path.resolve(options.get('--skills-home') || userSkillsHome()),
};
const dataDir = path.resolve(options.get('--data-dir') || config.dataDir);
if (action === 'export') {
  if (
    await fs.stat(archive).then(
      () => true,
      () => false,
    )
  )
    throw new Error('导出目标已存在');
  const release = acquireDataLock(dataDir);
  const store = new Store(dataDir);
  try {
    const result = await exportMigration(store, homes, archive);
    console.log(
      JSON.stringify(
        { archive, files: result.manifest.files.length, warnings: result.warnings },
        null,
        2,
      ),
    );
  } finally {
    store.close();
    release();
  }
} else if (action === 'inspect') {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-inspect-'));
  try {
    const manifest = await unpackMigration(archive, temp);
    console.log(
      JSON.stringify(
        {
          ...manifest,
          files: manifest.files.length,
          mapping: Object.fromEntries(
            manifest.projects.map((project) => [project.id, project.path]),
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
} else {
  const mapping = options.get('--mapping');
  if (!mapping) throw new Error('导入需要 --mapping，内容为项目 ID 到目标绝对目录的 JSON 对象');
  const projects: Record<string, string> = JSON.parse(await fs.readFile(mapping, 'utf8'));
  console.log(
    JSON.stringify(await restoreOffline(archive, { dataDir, ...homes, projects }), null, 2),
  );
}
