import { builtinProviders } from '../server/connections/providers.ts';
import { defineModule } from './types.ts';

// Files connections (docs/STORAGE.md): WebDAV/Nextcloud, SFTP, FTP/FTPS and remote MCP servers, synced both ways into /files/<name>.
// The tables are in appdb.ts and the API is the `connections` router; this module registers the kinds with `ctx.storage` and the background sync.
export const connections = defineModule({
  id: 'connections', name: 'Connections', icon: 'Cable',
  storageProviders: builtinProviders,
  // every 5 minutes for the connections of people who used hefyn in the last hour
  jobs: [{ name: 'sync', everyMs: 5 * 60_000, first: 90_000, run: async () => (await import('../server/connections/sync.ts')).syncDue() }],
});
