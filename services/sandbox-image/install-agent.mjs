// Runs only in the runner's short-lived installer container (docs/SANDBOX.md), with the hefyn-agents volume at /agents. Node built-ins only.
// Spec (HEFYN_INSTALL, validated by the runner): {id, version, check: [relative file that must exist afterwards],
//   npm: {package: "name@x.y.z", extra?: ["name@x.y.z"]} | binary: {"linux-x86_64": {archive, sha256, cmd}, "linux-aarch64": {...}}}
// No package code runs here: npm gets --ignore-scripts and an archive is only unpacked. The result is built in a temp dir and renamed into place
// with a marker file, so a half-finished install is never visible.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { join, resolve } from 'node:path';

const fail = (m) => { console.error(`hefyn-install: ${m}`); process.exit(1); };
const spec = JSON.parse(process.env.HEFYN_INSTALL || '{}');
const { id, version } = spec;
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id ?? '') || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version ?? '')) fail('invalid id or version');
const final = `/agents/${id}/${version}`, tmp = `/agents/.tmp-${id}-${version}`;
rmSync(tmp, { recursive: true, force: true });
rmSync(`${tmp}.archive`, { force: true });
if (spec.remove) { // the runner's uninstall: this container is the only one that can write the volume
  rmSync(final, { recursive: true, force: true });
  try { rmdirSync(`/agents/${id}`); } catch { /* other versions are still there */ }
  process.exit(0);
}
mkdirSync(tmp, { recursive: true });

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) fail(`${cmd} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-8).join(' | ')}`);
}

// Hosts a download may touch: the archive's own, plus GitHub's release CDN (its archives redirect there). The sha256 below is what makes the bytes trustworthy.
const GITHUB_CDN = ['objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'];
function download(url, file, allowed, sha256, hops = 0) {
  return new Promise((done, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !allowed.has(u.hostname)) return reject(new Error(`download from ${u.hostname} is not allowed for this agent`));
    https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return hops >= 5 ? reject(new Error('too many redirects')) : download(new URL(res.headers.location, u).href, file, allowed, sha256, hops + 1).then(done, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download failed (HTTP ${res.statusCode})`)); }
      const h = createHash('sha256'), out = createWriteStream(file);
      let n = 0;
      res.on('data', (c) => { h.update(c); if ((n += c.length) > 1.5e9) res.destroy(new Error('archive too large')); });
      res.pipe(out);
      out.on('finish', () => (h.digest('hex') === sha256 ? done() : reject(new Error('the download does not match the checksum (sha256) the registry published; nothing was installed'))));
      res.on('error', reject); out.on('error', reject);
    }).on('error', reject);
  });
}

if (spec.npm) {
  const pkgs = [spec.npm.package, ...(spec.npm.extra ?? [])];
  run('npm', ['install', '--prefix', tmp, ...pkgs, '--ignore-scripts', '--no-fund', '--no-audit', '--omit=dev', '--registry', 'https://registry.npmjs.org/', '--loglevel=error'],
    { env: { PATH: process.env.PATH, HOME: '/tmp', npm_config_cache: '/tmp/npm-cache', npm_config_userconfig: '/tmp/npmrc-user', npm_config_globalconfig: '/tmp/npmrc-global' } }); // no .npmrc of the image applies
} else if (spec.binary) {
  const plat = { arm64: 'linux-aarch64', x64: 'linux-x86_64' }[process.arch];
  const e = plat && spec.binary[plat];
  if (!e) fail(`this agent has no download for ${process.arch} Linux`);
  const host = new URL(e.archive).hostname;
  const allowed = new Set([host, ...(host === 'github.com' ? GITHUB_CDN : [])]);
  const file = `${tmp}.archive`; // on the volume, not in the memory-backed /tmp
  try { await download(e.archive, file, allowed, e.sha256); } catch (err) { rmSync(file, { force: true }); fail(err.message); }
  if (/\.(tar\.gz|tgz)$/.test(new URL(e.archive).pathname)) run('tar', ['-xzf', file, '-C', tmp, '--no-same-owner']);
  else if (/\.zip$/.test(new URL(e.archive).pathname)) run('python3', ['-I', '-m', 'zipfile', '-e', file, tmp]);
  else fail('this archive type is not supported (tar.gz and zip are)');
  const cmd = resolve(tmp, e.cmd);
  if (!cmd.startsWith(`${tmp}/`) || !existsSync(cmd)) fail('the archive does not contain the program the registry names');
  rmSync(file, { force: true });
  chmodSync(cmd, 0o755);
} else fail('nothing to install');

for (const f of spec.check ?? []) if (!resolve(tmp, f).startsWith(`${tmp}/`) || !existsSync(resolve(tmp, f))) fail(`the installed files are not as expected (missing ${f})`);
run('chmod', ['-R', 'a+rX,go-w', tmp]);
writeFileSync(join(tmp, '.hefyn-installed'), JSON.stringify({ id, version, at: new Date().toISOString() }));
mkdirSync(`/agents/${id}`, { recursive: true });
rmSync(final, { recursive: true, force: true });
renameSync(tmp, final);
console.log(`hefyn-install: ${id} ${version} ready`);
