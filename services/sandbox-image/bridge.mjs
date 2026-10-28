// Node built-ins only. The sandbox has no network; model traffic leaves through one unix socket that hefyn listens on.
// This exposes it as 127.0.0.1:PORT, because the agents speak TCP (ANTHROPIC_BASE_URL=http://127.0.0.1:PORT).
// A second one, 127.0.0.1:AUTH_PORT -> /tmp/.hefyn/auth.sock, exists only for users who may sign in with their own account: hefyn serves an HTTPS proxy there
// that tunnels to the login's hosts and nothing else. Without that socket a connection to it is simply dropped.
import net from 'node:net';

const port = Number(process.env.HEFYN_BRIDGE_PORT) || 47000;
const sock = process.env.HEFYN_MODEL_SOCKET || '/tmp/.hefyn/model.sock';
const authPort = Number(process.env.HEFYN_AUTH_PORT) || 47001;
const authSock = process.env.HEFYN_AUTH_SOCKET || '/tmp/.hefyn/auth.sock';

const pipe = (path) => (c) => {
  const u = net.connect(path);
  c.pipe(u); u.pipe(c);
  const drop = () => { c.destroy(); u.destroy(); };
  c.on('error', drop); u.on('error', drop); c.on('close', drop); u.on('close', drop);
};

net.createServer(pipe(authSock)).on('error', () => {}).listen(authPort, '127.0.0.1');
net.createServer(pipe(sock)).on('error', (e) => { console.error('bridge:', e.message); process.exit(e.code === 'EADDRINUSE' ? 0 : 1); }).listen(port, '127.0.0.1');
