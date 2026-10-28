import { ftpProvider } from './ftp.ts';
import { mcpProvider } from './mcp.ts';
import { sftpProvider } from './sftp.ts';
import { providerRegistry, type StorageProvider } from './types.ts';
import { webdavProvider } from './webdav.ts';

/** The four built-in kinds (the `connections` module registers them with `ctx.storage`). */
export const builtinProviders: StorageProvider[] = [webdavProvider, sftpProvider, ftpProvider, mcpProvider];

/** The agent process has no kernel: it fills the registry itself. */
export const ensureProviders = () => { if (!providerRegistry.size) for (const p of builtinProviders) providerRegistry.set(p.kind, p); };
