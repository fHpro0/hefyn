import { vaultedSqlite } from './server/flue-vault.ts';

// Flue's sqlite() adapter, with user content sealed per user before it reaches flue.db (see server/flue-vault.ts).
export default vaultedSqlite(`${process.env.HEFYN_DATA_DIR ?? './data'}/flue.db`);
