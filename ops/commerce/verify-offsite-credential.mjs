#!/usr/bin/env node
// Verifies the offsite backup credential against the real bucket.
//
// Proves the facts the offsite gates assert, instead of assuming them:
//   * the credential can upload under the backup prefix and read the exact version
//     back - what the backup chain does on every run;
//   * overwriting an object keeps the previous version readable, which is the
//     functional proof that bucket versioning is on ("a bad backup can never
//     destroy the good one");
//   * the credential cannot delete an object, so the account that writes backups
//     cannot destroy them, and cannot rewrite the rules that expire them.
//
// The bucket-level versioning *status* is deliberately never read: this identity
// is denied every bucket-level action, so the status read would answer 403. The
// proof is functional instead, using only the permissions the credential has -
// the same property the backup chain relies on at runtime.
//
// Run as root on the production host, after creating or rotating the credential:
//
//   /usr/bin/node /usr/local/libexec/pawshop/verify-offsite-credential.mjs
//
// It writes two small object versions under the backup prefix and then *tries* to
// delete them: the delete must be refused, which is the whole point of the check.
// The object therefore stays behind - clean it up with the management identity, or
// set PAWSHOP_OFFSITE_CHECK_KEEP=1 to silence the reminder (it expires with the
// daily tier either way).
//
// Prints no key material: only pass/fail and the HTTP outcome.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ACCESS_KEY_FILE = process.env.PAWSHOP_BACKUP_S3_ACCESS_KEY_FILE || '/etc/pawshop-backup/backup-s3-access-key';
const SECRET_KEY_FILE = process.env.PAWSHOP_BACKUP_S3_SECRET_KEY_FILE || '/etc/pawshop-backup/backup-s3-secret-key';
const BUCKET = process.env.PAWSHOP_BACKUP_S3_BUCKET || 'pawlivora-backups-us-west-1';
const REGION = process.env.PAWSHOP_BACKUP_S3_REGION || 'oss-us-west-1';
const KEY = 'pawshop/database-backups/daily/.pawshop-credential-check.txt';
const FIRST_BODY = 'pawshop credential check: first version\n';
const SECOND_BODY = 'pawshop credential check: second version\n';
const KEEP = process.env.PAWSHOP_OFFSITE_CHECK_KEEP === '1';

let accessKeyId;
let secretAccessKey;
try {
  accessKeyId = readFileSync(ACCESS_KEY_FILE, 'utf8').trim();
  secretAccessKey = readFileSync(SECRET_KEY_FILE, 'utf8').trim();
} catch (error) {
  console.error(`cannot read the credential files: ${error.message}`);
  process.exit(2);
}

// OSS V1 signing: Content-MD5 and Content-Type are part of the string to sign, and
// fetch sets a text/plain content type on a string body by itself, so the content
// type is explicit and signed.
function sign(method, pathname, subresource, contentType = '') {
  const date = new Date().toUTCString();
  const resource = `/${BUCKET}${pathname}${subresource}`;
  const signature = createHmac('sha1', secretAccessKey).update(`${method}\n\n${contentType}\n${date}\n${resource}`, 'utf8').digest('base64');
  const headers = { date, authorization: `OSS ${accessKeyId}:${signature}` };
  if (contentType) headers['content-type'] = contentType;
  return headers;
}

async function call(method, pathname, subresource = '', { body, contentType = '' } = {}) {
  const response = await fetch(`https://${BUCKET}.${REGION}.aliyuncs.com${pathname}${subresource}`, {
    method, headers: sign(method, pathname, subresource, contentType), body, signal: AbortSignal.timeout(20000),
  });
  const text = method === 'GET' ? await response.text() : '';
  return { status: response.status, text, headers: response.headers };
}

// A version identifier may contain characters that must be percent-encoded in the
// query string; the canonicalized resource has to match whichever form was sent,
// so the encoded form is retried when the signature of the raw form is rejected.
async function readExactVersion(pathname, versionId) {
  const raw = await call('GET', pathname, `?versionId=${versionId}`);
  if (raw.status === 403 && /SignatureDoesNotMatch/.test(raw.text)) {
    return call('GET', pathname, `?versionId=${encodeURIComponent(versionId)}`);
  }
  return raw;
}

const checks = [];
function record(label, ok, detail) {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label.padEnd(34)} ${detail}`);
}

const first = await call('PUT', `/${KEY}`, '', { body: FIRST_BODY, contentType: 'application/octet-stream' });
const firstVersion = first.headers.get('x-oss-version-id') || '';
record('上传（PutObject）', first.status === 200 && Boolean(firstVersion), `HTTP ${first.status} versionId=${firstVersion.slice(0, 12)}…`);

const second = await call('PUT', `/${KEY}`, '', { body: SECOND_BODY, contentType: 'application/octet-stream' });
const secondVersion = second.headers.get('x-oss-version-id') || '';
record('覆盖上传（PutObject）', second.status === 200 && Boolean(secondVersion) && secondVersion !== firstVersion,
  `HTTP ${second.status} versionId=${secondVersion.slice(0, 12)}…`);

const head = await call('HEAD', `/${KEY}`);
record('探测（HeadObject + 版本号）', head.status === 200 && Boolean(head.headers.get('x-oss-version-id')), `HTTP ${head.status} versionId=${(head.headers.get('x-oss-version-id') || '').slice(0, 12)}…`);

const latest = await call('GET', `/${KEY}`);
record('回读明文一致（GetObject）', latest.status === 200 && latest.text === SECOND_BODY, `HTTP ${latest.status} 内容匹配=${latest.text === SECOND_BODY}`);

// The functional versioning proof: after the overwrite above, the version that was
// overwritten must still be readable by its own identifier. Without versioning the
// overwrite would have destroyed it and this read would fail.
const retained = firstVersion ? await readExactVersion(`/${KEY}`, firstVersion) : { status: 0, text: '' };
record('覆盖后旧版本仍可读（版本控制）', retained.status === 200 && retained.text === FIRST_BODY,
  `HTTP ${retained.status} 旧版本内容匹配=${retained.text === FIRST_BODY}`);

const remove = await call('DELETE', `/${KEY}`);
record('删除被拒（DeleteObject）', remove.status === 403, `HTTP ${remove.status}`);

const lifecycle = await call('GET', '/', '?lifecycle');
// A credential that cannot delete an object must also not be able to change when
// objects expire: reading the rules is already more than it needs.
record('生命周期规则不可读（越权检查）', lifecycle.status === 403, `HTTP ${lifecycle.status}`);

if (!KEEP) {
  console.log(`\n提示：本脚本不能删除自己写入的校验对象（这正是被验证的能力）。`);
  console.log(`请用管理凭据清理 ${KEY}，或设置 PAWSHOP_OFFSITE_CHECK_KEEP=1 让它随 daily 层到期。`);
}

console.log(checks.every(Boolean)
  ? '\n全部通过：凭据可写、覆盖后旧版本仍可读（版本控制已开启）、且不能删除。'
  : '\n有检查未通过——不要打开 VERSIONING_CONFIRMED / DELETE_DISABLED 闸门。');
process.exit(checks.every(Boolean) ? 0 : 1);
