import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

// Shared by the Docker integration tests of the CLI agents: the real sandbox image, a real runner container (with the hefyn-agents volume read-only at /agents)
// and a relay that stands in for the agent process's model socket. Topology of the dev stack: runner and sandboxes share named volumes. A host-side unix
// socket does not cross Docker Desktop's bind mounts (ENOTSUP), and in the stack the agent process is a container on the volume too: a relay container on the
// same volume plays that role (socket on the volume -> a handler in this process over TCP). The relay is the only substitute.

export const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
export const sockPath = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') || '/var/run/docker.sock';
export const skip = !(dockerUp && existsSync(sockPath)) && 'Docker daemon / socket not available';

export async function startStack(t: TestContext, o: { run: string; token: string }) {
  const { run, token } = o;
  const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const quiet = (...a: string[]) => { try { docker(...a); } catch { /* best effort cleanup */ } };
  const IMAGE = `hefyn-sandbox-cli-test:${run}`, RUNNER_IMAGE = `hefyn-runner-cli-test:${run}`, VOL = `hefyn-cli-test-${run}`, AGENTS = `hefyn-cli-agents-${run}`;
  const NET = `hefyn-cli-sbx-${run}`, MCP = `hefyn-cli-mcp-${run}`, INST = `hefyn-cli-inst-${run}`, RUNNER = `hefyn-cli-runner-${run}`;
  const relays: string[] = [], servers: { stop(f?: boolean): void }[] = [];
  const cleanup = () => {
    for (const s of servers) s.stop(true);
    for (const label of ['hefyn.managed=true', 'hefyn.installer']) for (const id of docker('ps', '-aq', '--filter', `label=${label}`).split('\n').filter(Boolean)) if (docker('inspect', '-f', '{{.Config.Image}}', id).trim() === IMAGE) quiet('rm', '-f', id);
    for (const r of relays) quiet('rm', '-f', r);
    quiet('rm', '-f', RUNNER); for (const n of [NET, MCP, INST]) quiet('network', 'rm', n);
    quiet('volume', 'rm', '-f', VOL); quiet('volume', 'rm', '-f', AGENTS); quiet('rmi', '-f', IMAGE); quiet('rmi', '-f', RUNNER_IMAGE);
  };
  t.after(cleanup);

  docker('build', '-q', '-t', IMAGE, join(import.meta.dirname, '../services/sandbox-image'));
  docker('build', '-q', '-t', RUNNER_IMAGE, join(import.meta.dirname, '../services/runner'));
  docker('volume', 'create', VOL); docker('volume', 'create', AGENTS);
  docker('run', '-d', '--name', RUNNER, '-v', `${VOL}:/data`, '-v', `${AGENTS}:/agents:ro`, '-v', `${sockPath}:/var/run/docker.sock`, '-p', '127.0.0.1::8790',
    '-e', `HEFYN_INTERNAL_TOKEN=${token}`, '-e', `HEFYN_SANDBOX_IMAGE=${IMAGE}`, '-e', `HEFYN_SANDBOX_NETWORK=${NET}`, '-e', `HEFYN_MCP_NETWORK=${MCP}`, '-e', `HEFYN_INSTALL_NETWORK=${INST}`,
    '-e', 'HEFYN_RUNNER_ATTACH_GRACE_MS=500', '-e', 'HEFYN_RUNNER_MAX_INSTALLS=4', '-e', 'HEFYN_RUNNER_MAX_SANDBOXES_PER_USER=8', RUNNER_IMAGE);
  const runnerUrl = `http://127.0.0.1:${docker('port', RUNNER, '8790/tcp').trim().split('\n')[0].split(':').pop()}`;
  const headers = { 'x-hefyn-internal': token, 'content-type': 'application/json' };
  for (let i = 0; i < 100 && !(await fetch(`${runnerUrl}/health`, { headers }).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));

  const runner = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(runnerUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  /** POST /agents/install and wait for the end; resolves the final status ({state: 'ready' | 'failed', error?}). */
  async function install(req: unknown, ms = 600_000) {
    const first = await runner('POST', '/agents/install', req);
    if (first.status !== 200) return { state: 'rejected', status: first.status, error: first.json.error as string };
    const { id, version } = req as { id: string; version: string };
    for (let i = 0; i < ms / 1000; i++) {
      const s = (await runner('GET', `/agents/${id}/${version}`)).json;
      if (s.state === 'ready' || s.state === 'failed' || s.state === 'none') return s as { state: string; error?: string };
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`install of ${id} timed out`);
  }

  /** A unix socket `<sock>.sock` in the conversation's .hefyn dir on the data volume that forwards to a TCP port of this process, through a relay container. */
  const relay = async (userId: string, conversationId: string, sock: string, port: number) => {
    const sub = `users/${userId}/tmp/${conversationId}`, name = `hefyn-cli-relay-${run}-${relays.length}`;
    docker('run', '--rm', '-u', '0', '-v', `${VOL}:/data`, IMAGE, 'sh', '-c', `mkdir -p /data/${sub}/.hefyn && chmod 777 /data/${sub}/.hefyn`);
    const js = `const net=require('net'),fs=require('fs'),p='/m/.hefyn/${sock}.sock';try{fs.unlinkSync(p)}catch{}
net.createServer(c=>{const u=net.connect(${port},'host.docker.internal');c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(p,()=>fs.chmodSync(p,0o666))`;
    quiet('rm', '-f', name); relays.push(name);
    docker('run', '-d', '--name', name, '-u', '0', '--add-host', 'host.docker.internal:host-gateway', '--mount', `type=volume,src=${VOL},dst=/m,volume-subpath=${sub}`, IMAGE, 'node', '-e', js);
    for (let i = 0; i < 100; i++) { try { docker('exec', name, 'test', '-S', `/m/.hefyn/${sock}.sock`); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
    return name;
  };
  /** The model socket of a conversation, served by `handler` in this process through a relay container on the data volume. */
  const listenModel = async (userId: string, conversationId: string, handler: (r: Request) => Promise<Response>) => {
    const server = Bun.serve({ port: 0, hostname: '0.0.0.0', idleTimeout: 0, fetch: handler });
    servers.push(server);
    const name = await relay(userId, conversationId, 'model', server.port!);
    return { close: () => { server.stop(true); quiet('rm', '-f', name); } };
  };
  /** The Anthropic-only proxy of a conversation (own-account.ts createAuthProxy, the real one), `dial` pointing its allowed names at stand-ins. */
  const listenAuth = async (userId: string, conversationId: string, dial?: Parameters<typeof import('../src/cli-agents/own-account.ts').createAuthProxy>[1]) => {
    const { createAuthProxy, ANTHROPIC_HOSTS } = await import('../src/cli-agents/own-account.ts');
    const proxy = createAuthProxy(ANTHROPIC_HOSTS, dial);
    await new Promise<void>((r) => proxy.listen(0, '0.0.0.0', r));
    const name = await relay(userId, conversationId, 'auth', (proxy.address() as { port: number }).port);
    return { close: () => { proxy.close(); proxy.closeAllConnections?.(); quiet('rm', '-f', name); } };
  };
  /** A wrapped agent's transcript, read from inside the sandbox through the runner (this process does not share the sandbox's disk, as the agent container does in the stack). */
  const transcript = async (userId: string, conversationId: string, sid: string, offset: number) => {
    const { containerFs } = await import('../src/server/container-fs.ts');
    const f = `/tmp/.claude/projects/-files/${sid}.jsonl`, from = Math.min(offset, 2 ** 40);
    const r = await containerFs({ userId, conversationId, runnerUrl, token }).run(['sh', '-c', `[ -f ${f} ] || exit 3; s=$(stat -c %s ${f}); echo "$s"; if [ "$s" -gt ${from} ]; then tail -c +${from + 1} ${f}; fi`], { cwd: '/tmp', timeoutMs: 20_000 });
    if (r.exitCode !== 0) return undefined;
    const nl = r.stdout.indexOf('\n');
    return { size: Number(r.stdout.slice(0, nl)), data: Buffer.from(r.stdout.slice(nl + 1), 'utf8') };
  };
  return { docker, quiet, IMAGE, VOL, AGENTS, runnerUrl, runner, install, listenModel, listenAuth, transcript };
}
