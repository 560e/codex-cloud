import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Store } from './store.js';
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, stored?: string) {
  if (!stored) return false;
  const [salt, encoded] = stored.split(':');
  if (!salt || !encoded) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(encoded, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class Auth {
  attempts = new Map<string, { count: number; reset: number }>();
  private verifying = 0;
  constructor(
    private store: Store,
    private passwordKey = 'passwordHash',
  ) {}
  async authenticate(password: string, ip: string) {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.reset < now) this.attempts.delete(key);
    const attempt = this.attempts.get(ip) || { count: 0, reset: now + 15 * 60000 };
    if (
      attempt.count >= 10 ||
      this.verifying >= 4 ||
      (!this.attempts.has(ip) && this.attempts.size >= 10000)
    )
      throw Object.assign(new Error('尝试过于频繁，请稍后再试'), { statusCode: 429 });
    attempt.count++;
    this.attempts.set(ip, attempt);
    this.verifying++;
    let valid: boolean;
    const storedHash = this.store.get(this.passwordKey);
    try {
      valid = await verifyPassword(password, storedHash);
    } finally {
      this.verifying--;
    }
    if (storedHash !== this.store.get(this.passwordKey)) valid = false;
    if (!valid) throw Object.assign(new Error('密码不正确'), { statusCode: 401 });
    this.attempts.delete(ip);
    return storedHash;
  }
  async login(password: string, ip: string, ttl: number) {
    const expected = await this.authenticate(password, ip);
    if (expected !== this.store.get('passwordHash'))
      throw Object.assign(new Error('密码已变化，请重新登录'), { statusCode: 401 });
    const token = randomBytes(32).toString('base64url');
    this.store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(digest(token), Date.now() + ttl);
    return token;
  }
  valid(token?: string) {
    if (!token) return false;
    const row = this.store.db
      .prepare('SELECT expires_at FROM sessions WHERE token_hash=?')
      .get(digest(token));
    return !!row && Number(row.expires_at) > Date.now();
  }
  logout(token?: string) {
    if (token) this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
  }
  async change(password: string, expected?: string) {
    if (this.verifying >= 4)
      throw Object.assign(new Error('尝试过于频繁，请稍后再试'), { statusCode: 429 });
    this.verifying++;
    let hash: string;
    try {
      hash = await hashPassword(password);
    } finally {
      this.verifying--;
    }
    if (expected && expected !== this.store.get('passwordHash'))
      throw Object.assign(new Error('密码已被其他请求修改，请重新登录'), { statusCode: 409 });
    this.store.set('passwordHash', hash);
    this.store.db.exec('DELETE FROM sessions');
  }
}
