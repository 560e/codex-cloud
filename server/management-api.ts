import { latestCliVersion, installCli, activateCli } from './cli-update.js';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import { Workbench, fail } from './workbench.js';
import {
  codexHome,
  userSkillsHome,
  listSkills,
  skillInput,
  saveSkill,
  readSkill,
  deleteSkill,
  listMcp,
  mcpInput,
  saveMcp,
} from './extensions.js';
import {
  exportMigration,
  unpackMigration,
  withPreparedRestore,
  installRestore,
  receiveArchive,
  type MigrationManifest,
} from './migration.js';
import { config } from './config.js';
import { projectPath, contains } from './files.js';

export function managementRoutes(
  app: FastifyInstance,
  store: Store,
  wb: Workbench,
  imported: () => void,
) {
  let updatingCli = false;
  app.get('/api/cli', async () => ({
    latest: await latestCliVersion(),
    current: wb.bridge.version || null,
  }));
  app.post('/api/cli/update', async (request) => {
    const body = z
      .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), confirm: z.literal(true) })
      .parse(request.body);
    if (updatingCli) throw fail('CLI 正在更新，请等待', 409);
    updatingCli = true;
    try {
      const latest = await latestCliVersion();
      if (latest !== body.version) throw fail('最新版本已变化，请重新检查更新', 409);
      return await wb.maintenance(async () => {
        const oldBinary = wb.bridge.binaryPath;
        try {
          const binary = await installCli(store.dir, latest);
          wb.bridge.setBinary(binary);
          await wb.bridge.start();
          await wb.bridge.forceStop();
          await activateCli(store.dir, latest);
          return { ok: true, version: latest };
        } catch (error) {
          await wb.bridge.forceStop();
          wb.bridge.setBinary(oldBinary);
          throw error;
        }
      }, true);
    } finally {
      updatingCli = false;
    }
  });
  const cwdFor = async (project?: string) => {
    if (!project) return process.cwd();
    const item = store.projects().find((entry) => entry.id === project);
    if (!item) throw fail('项目不存在', 404);
    return projectPath(item.path, config.projectRoots, false);
  };
  app.get('/api/skills', async (request) => {
    const query = z.object({ project: z.string().optional() }).parse(request.query);
    return listSkills(wb, await cwdFor(query.project));
  });
  app.get<{ Params: { name: string } }>('/api/skills/:name/content', async (request) => ({
    content: await readSkill(request.params.name),
  }));
  app.put('/api/skills', async (request) =>
    wb.maintenance(async () => {
      await saveSkill(skillInput.parse(request.body));
      return { ok: true };
    }),
  );
  app.post('/api/skills/enabled', async (request) => {
    const body = z
      .object({ project: z.string().optional(), path: z.string().min(1), enabled: z.boolean() })
      .parse(request.body);
    const skills = await listSkills(wb, await cwdFor(body.project));
    if (!skills.some((skill) => skill.path === body.path)) throw fail('Skill 不存在', 404);
    return wb.maintenance(async () => {
      await wb.bridge.call('skills/config/write', { path: body.path, enabled: body.enabled });
      return { ok: true };
    });
  });
  app.delete<{ Params: { name: string } }>('/api/skills/:name', async (request) =>
    wb.maintenance(async () => {
      await deleteSkill(request.params.name);
      return { ok: true };
    }),
  );
  app.get('/api/mcp', async () => listMcp(wb));
  app.put('/api/mcp', async (request) =>
    wb.maintenance(async () => {
      await saveMcp(mcpInput.parse(request.body));
      return { ok: true };
    }, true),
  );
  app.delete<{ Params: { name: string } }>('/api/mcp/:name', async (request) =>
    wb.maintenance(async () => {
      await saveMcp({ name: request.params.name, remove: true });
      return { ok: true };
    }, true),
  );

  const pending = new Map<
    string,
    { directory: string; manifest: MigrationManifest; expires: number }
  >();
  const purge = async () => {
    for (const [id, item] of pending)
      if (item.expires < Date.now()) {
        pending.delete(id);
        await fs.rm(path.dirname(item.directory), { recursive: true, force: true });
      }
  };
  app.addHook('onClose', async () => {
    for (const item of pending.values())
      await fs.rm(path.dirname(item.directory), { recursive: true, force: true });
    pending.clear();
  });
  app.get('/api/migration', async () => ({
    format: 'codex-cloud-portable',
    version: 1,
    dataDir: store.dir,
    codexHome: codexHome(),
    skillsHome: userSkillsHome(),
    projects: store.projects(),
  }));
  app.post('/api/migration/export', async (_request, reply) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-download-'));
    const archive = path.join(temp, 'codex-cloud.tar.gz');
    try {
      const result = await wb.maintenance(
        () =>
          exportMigration(store, { codexHome: codexHome(), skillsHome: userSkillsHome() }, archive),
        true,
      );
      reply
        .header(
          'Content-Disposition',
          `attachment; filename="codex-cloud-${new Date().toISOString().slice(0, 10)}.tar.gz"`,
        )
        .header('X-Migration-Warnings', result.warnings.length)
        .type('application/gzip');
      const stream = createReadStream(archive);
      stream.once('close', () => {
        void fs.rm(temp, { recursive: true, force: true });
      });
      return reply.send(stream);
    } catch (e) {
      await fs.rm(temp, { recursive: true, force: true });
      throw e;
    }
  });
  app.post('/api/migration/preview', { bodyLimit: 2 * 1024 ** 3 }, async (request) => {
    await purge();
    if (pending.size >= 3) throw fail('请先处理或取消已有导入包', 409);
    const upload = await request.file({ limits: { fileSize: 2 * 1024 ** 3, files: 1 } });
    if (!upload) throw fail('请选择迁移包');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-upload-'));
    const archive = path.join(temp, 'archive.tar.gz');
    const directory = path.join(temp, 'unpacked');
    try {
      await receiveArchive(upload.file, archive);
      if (upload.file.truncated) throw fail('迁移包超过 2 GiB');
      const manifest = await unpackMigration(archive, directory);
      const id = randomUUID();
      pending.set(id, { directory, manifest, expires: Date.now() + 3600000 });
      return {
        id,
        createdAt: manifest.createdAt,
        platform: manifest.platform,
        files: manifest.files.length,
        projects: manifest.projects.map((project) => ({
          ...project,
          target:
            store.projects().find((item) => item.id === project.id)?.path ||
            path.join(
              config.projectRoots[0],
              path.posix.basename(project.path.replaceAll('\\', '/')),
            ),
        })),
      };
    } catch (e) {
      await fs.rm(temp, { recursive: true, force: true });
      throw e;
    }
  });
  app.delete<{ Params: { id: string } }>('/api/migration/:id', async (request) => {
    const item = pending.get(request.params.id);
    if (item) {
      pending.delete(request.params.id);
      await fs.rm(path.dirname(item.directory), { recursive: true, force: true });
    }
    return { ok: true };
  });
  app.post('/api/migration/apply', async (request) => {
    await purge();
    const body = z
      .object({
        id: z.string(),
        confirm: z.literal(true),
        projects: z.record(z.string(), z.string().min(1).max(3000)),
      })
      .parse(request.body);
    const item = pending.get(body.id);
    if (!item) throw fail('迁移包已过期，请重新上传', 404);
    const targets = {
      dataDir: path.resolve(store.dir),
      codexHome: codexHome(),
      skillsHome: userSkillsHome(),
      projects: {} as Record<string, string>,
    };
    const roots = [targets.dataDir, targets.codexHome, targets.skillsHome];
    if (roots.some((a, i) => roots.some((b, j) => i !== j && (contains(a, b) || contains(b, a)))))
      throw fail('迁移目标目录不能相互包含');
    for (const project of item.manifest.projects) {
      if (!body.projects[project.id]) throw fail('请填写所有项目的目标目录');
      targets.projects[project.id] = await projectPath(
        body.projects[project.id],
        config.projectRoots,
        true,
      );
    }
    if (
      new Set(
        Object.values(targets.projects).map((p) =>
          process.platform === 'win32' ? p.toLowerCase() : p,
        ),
      ).size !== item.manifest.projects.length
    )
      throw fail('不同项目必须使用不同目录');
    const backups = await wb.maintenance(
      () =>
        withPreparedRestore(item.directory, item.manifest, targets, async (prepared) => {
          store.close();
          try {
            return await installRestore(prepared, targets);
          } finally {
            store.reload();
          }
        }),
      true,
    );
    pending.delete(body.id);
    await fs.rm(path.dirname(item.directory), { recursive: true, force: true });
    imported();
    return { ok: true, backups };
  });
}
