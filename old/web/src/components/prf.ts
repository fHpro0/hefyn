import { startAuthentication } from '@simplewebauthn/browser';
import { api } from './api';

// Passkey unlock (WebAuthn PRF, docs/ENCRYPTION.md). Loaded by Login, Unlock and Security only.
export const prfSupported = () => typeof PublicKeyCredential !== 'undefined';

// Fixed 32-byte PRF input; the authenticator mixes in its own secret, so this is a label, not a secret.
export const prfExtensions = async () => ({ prf: { eval: { first: new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hefyn-unlock-v1'))) } } });

const b64url = (b: ArrayBuffer | ArrayBufferView) => {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
/** The PRF output of a clientExtensionResults object, base64url, or undefined when the passkey gave none. */
export const prfOf = (ext: any): string | undefined => { const f = ext?.prf?.results?.first; return f ? b64url(f) : undefined; };

const ask = async (credentialIds: string[], challenge: string) => startAuthentication({
  optionsJSON: { challenge, userVerification: 'required', allowCredentials: credentialIds.map((id) => ({ id, type: 'public-key' as const })), extensions: await prfExtensions() as any },
});

/** After a passkey sign-in: hand the PRF output to the server so the data unlocks too. Never throws (the password path stays). */
export const unlockAfterSignIn = (credentialId: string | undefined, ext: any) => {
  const prf = prfOf(ext);
  return credentialId && prf ? api('/api/security/passkey-unlock', 'POST', { credentialId, prf }).then(() => true, () => false) : Promise.resolve(false);
};

/** One touch on an already-enrolled passkey unlocks. Resolves false when the server could not open it. */
export async function unlockWithPasskey(credentialIds: string[]): Promise<boolean> {
  const r = await ask(credentialIds, b64url(crypto.getRandomValues(new Uint8Array(32))));
  return unlockAfterSignIn(r.id, r.clientExtensionResults);
}

/** Enrol one of the given passkeys for unlock. Resolves 'noprf' when the browser or authenticator returned no PRF output. */
export async function enrolPasskey(credentialIds: string[]): Promise<'ok' | 'noprf'> {
  const { challenge } = await api<{ challenge: string }>('/api/security/passkey-prf/challenge', 'POST', {});
  const { clientExtensionResults, ...response } = await ask(credentialIds, challenge);
  const prf = prfOf(clientExtensionResults);
  if (!prf) return 'noprf';
  await api('/api/security/passkey-prf/enroll', 'POST', { response, prf });
  return 'ok';
}
