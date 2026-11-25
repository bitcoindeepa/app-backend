import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'crypto';

/**
 * A software passkey for e2e tests: a P-256 key that answers WebAuthn
 * create/get the way a platform authenticator does ("none" attestation,
 * user present + verified), so @simplewebauthn/server verifies it for real.
 */

const b64url = (bytes: Buffer) => bytes.toString('base64url');
const sha256 = (data: Buffer | string) =>
  createHash('sha256').update(data).digest();

// Minimal CBOR: unsigned/negative ints, byte and text strings, maps
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(length, 1);
  return b;
}
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([head(2, value.length), value]);
  const parts = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

export interface SoftPasskey {
  credentialId: string;
  create(
    options: { challenge: string },
    origin: string,
  ): Record<string, unknown>;
  get(
    options: { challenge: string },
    origin: string,
    overrides?: { rpId?: string; userVerified?: boolean },
  ): Record<string, unknown>;
}

export function softPasskey(rpId: string): SoftPasskey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  }) as { privateKey: KeyObject; publicKey: KeyObject };
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(16);
  let counter = 0;

  const coseKey = cbor(
    new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );

  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );

  return {
    credentialId: b64url(credentialId),

    create({ challenge }, origin) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.from([0x45]), // UP | UV | AT
        Buffer.alloc(4), // counter 0
        Buffer.alloc(16), // aaguid
        idLength,
        credentialId,
        coseKey,
      ]);
      const attestationObject = cbor(
        new Map<Cbor, Cbor>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64url(
            clientData('webauthn.create', challenge, origin),
          ),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },

    get({ challenge }, origin, overrides = {}) {
      counter += 1;
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const flags = overrides.userVerified === false ? 0x01 : 0x05; // UP (| UV)
      const authenticatorData = Buffer.concat([
        sha256(overrides.rpId ?? rpId),
        Buffer.from([flags]),
        count,
      ]);
      const clientDataJSON = clientData('webauthn.get', challenge, origin);
      const signature = sign(
        'sha256',
        Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
        privateKey,
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
}
