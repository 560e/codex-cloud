// Standalone certificate issuance/renewal, used by the installer and OS timers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validDomain } from './core.mjs';

export async function issueCertificate(config, force = false) {
  const { domain, email, directory, challengeDir, modulePath } = config;
  validDomain(domain);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('请输入有效的证书通知邮箱');
  const certFile = path.join(directory, 'fullchain.pem');
  if (!force) {
    try {
      const cert = new X509Certificate(await fs.readFile(certFile));
      if (Date.parse(cert.validTo) - Date.now() > 30 * 86400000 && cert.checkHost(domain))
        return false;
    } catch {
      /* First issuance or invalid certificate. */
    }
  }
  const imported = await import(pathToFileURL(modulePath).href);
  const acme = imported.default || imported;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const accountFile = path.join(directory, 'account.pem');
  let accountKey;
  try {
    accountKey = await fs.readFile(accountFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    accountKey = await acme.forge.createPrivateKey();
    await fs.writeFile(accountFile, accountKey, { mode: 0o600 });
  }
  const client = new acme.Client({
    directoryUrl: config.staging
      ? acme.directory.letsencrypt.staging
      : acme.directory.letsencrypt.production,
    accountKey,
  });
  const [key, csr] = await acme.forge.createCsr({ commonName: domain });
  const tokenDir = path.join(challengeDir, '.well-known/acme-challenge');
  await fs.mkdir(tokenDir, { recursive: true, mode: 0o755 });
  const tokenFile = (challenge) => {
    if (!/^[A-Za-z0-9_-]+$/.test(challenge.token)) throw new Error('ACME token 无效');
    return path.join(tokenDir, challenge.token);
  };
  const cert = await client.auto({
    csr,
    email,
    termsOfServiceAgreed: true,
    challengePriority: ['http-01'],
    challengeCreateFn: async (_authz, challenge, value) =>
      fs.writeFile(tokenFile(challenge), value, { mode: 0o644 }),
    challengeRemoveFn: async (_authz, challenge) => fs.rm(tokenFile(challenge), { force: true }),
  });
  // A complete issuance must succeed before touching the current certificate pair.
  await fs.writeFile(path.join(directory, 'privkey.pem.next'), key, { mode: 0o600 });
  await fs.writeFile(certFile + '.next', cert, { mode: 0o644 });
  await fs.rename(path.join(directory, 'privkey.pem.next'), path.join(directory, 'privkey.pem'));
  await fs.rename(certFile + '.next', certFile);
  return true;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error('用法：node scripts/install/acme.mjs /路径/acme.json');
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    if (await issueCertificate(config)) {
      for (const args of process.argv.includes('--no-reload') ? [] : [['-t'], ['-s', 'reload']]) {
        const result = spawnSync(
          config.nginx,
          [...args, '-c', config.nginxConfig, '-p', config.nginxPrefix],
          { stdio: 'inherit', windowsHide: true },
        );
        if (result.error || result.status !== 0)
          throw result.error || new Error('Nginx 证书重载失败');
      }
      console.log(
        process.argv.includes('--no-reload')
          ? '证书已更新，等待 Nginx 重载。'
          : '证书已更新并重载 Nginx。',
      );
    } else console.log('证书尚未到续期时间。');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
