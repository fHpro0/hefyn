import http from 'node:http';
import type { Duplex } from 'node:stream';

// Minimal Docker Engine API client over the unix socket. Only the calls the runner needs; no generic passthrough.

export class DockerError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface Docker {
  call(method: string, path: string, body?: unknown): Promise<any>;
  /** Start an exec with a hijacked (raw, multiplexed) connection. Resolves with the socket after the 101. */
  hijack(execId: string): Promise<Duplex>;
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
    hijack: (execId) => new Promise((resolve, reject) => {
      const data = JSON.stringify({ Detach: false, Tty: false });
      const req = http.request({ socketPath, method: 'POST', path: `/exec/${execId}/start`, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), connection: 'Upgrade', upgrade: 'tcp' } });
      req.on('upgrade', (_res, socket) => resolve(socket));
      req.on('response', (res) => { res.resume(); reject(new DockerError(res.statusCode ?? 500, 'exec start refused')); });
      req.on('error', reject);
      req.end(data);
    }),
  };
}
