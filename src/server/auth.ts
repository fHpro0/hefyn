import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { db } from './appdb.ts';
import { CLIENT_IP_HEADER } from './clientip.ts';
import { SECRET } from './crypto.ts';

const baseURL = process.env.HEFYN_URL ?? 'http://localhost:3000';

const options = {
  database: db,
  secret: SECRET,
  baseURL,
  // dev: Astro (4321) and Flue/Vite (5173) dev servers
  trustedOrigins: [baseURL, 'http://localhost:4321', 'http://localhost:5173'],
  // The web service resolves the client IP itself (clientip.ts: socket peer, or X-Forwarded-For behind HEFYN_TRUSTED_PROXIES) and
  // hands it over in this header; forwarding headers sent by clients never reach Better Auth.
  advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
  emailAndPassword: { enabled: true, autoSignIn: false, minPasswordLength: 8 },
};

// Tables must exist before betterAuth() is created: it checks the schema once at init.
await (await getMigrations(options)).runMigrations();
export const auth = betterAuth(options);
