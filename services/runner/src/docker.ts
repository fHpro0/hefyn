import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

// Minimal Docker Engine API client over the unix socket. Only the calls the runner needs; no generic passthrough.

export class DockerError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface Docker {
  call(method: string, path: string, body?: unknown): Promise<any>;
  /** POST with a hijacked (raw, multiplexed) connection: an exec start (`/exec/<id>/start`) or a container attach. Resolves with the socket after the 101. */
  hijack(path: string, body?: unknown): Promise<Duplex>;
}

export function dockerClient(socketPath = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') || '/var/run/docker.sock'): Docker {
  return {
    call: (method, path, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ socketPath, method, path, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
          if ((res.statusCode ?? 500) >= 400) return reject(new DockerError(res.statusCode!, json?.message ?? String(text)));
          resolve(json);
        });
      });
      req.on('error', reject);
      req.end(data);
    }),
    hijack: (path, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? '' : JSON.stringify(body); // an attach has no body: any byte sent here would reach the container's stdin
      // Raw socket instead of http.request + 'upgrade': Bun's http client never emits 'upgrade' for a 101 (it reports a response), Node's does.
      const sock = net.connect(socketPath);
      let head = Buffer.alloc(0);
      const onData = (c: Buffer) => {
        head = Buffer.concat([head, c]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        sock.off('data', onData);
        sock.pause();
        const status = Number(/^HTTP\/1\.\d (\d+)/.exec(head.toString('latin1', 0, end))?.[1] ?? 500);
        if (status !== 101) { sock.destroy(); return reject(new DockerError(status, 'exec start refused')); }
        const rest = head.subarray(end + 4);
        if (rest.length) sock.unshift(rest);
        resolve(sock);
        setImmediate(() => sock.resume()); // paused until the caller has attached its listeners
      };
      sock.on('data', onData);
      sock.once('error', reject);
      sock.write(`POST ${path} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n${data}`);
    }),
  };
}
