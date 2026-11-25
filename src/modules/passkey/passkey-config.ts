import { appOrigins } from '../auth/cookies';

export interface RelyingParty {
  /** The domain passkeys are bound to (WEBAUTHN_RP_ID, else APP_URL's host) */
  id: string;
  name: string;
  /** Origins a WebAuthn response may come from: APP_URL's */
  origins: string[];
}

/**
 * Who the passkeys belong to. They're bound to the RP ID for good: changing
 * WEBAUTHN_RP_ID (or APP_URL's host without it) orphans every passkey. Set
 * WEBAUTHN_RP_ID=bitcoindeepa.com to let app.bitcoindeepa.com and any other
 * subdomain share them. Null when APP_URL isn't set (passkeys unavailable).
 */
export function relyingParty(): RelyingParty | null {
  const origins = appOrigins();
  if (origins.length === 0) return null;
  let id = process.env.WEBAUTHN_RP_ID?.trim();
  if (!id) {
    try {
      id = new URL(origins[0]).hostname;
    } catch {
      return null;
    }
  }
  return { id, name: 'Bitcoin Deepa', origins };
}
