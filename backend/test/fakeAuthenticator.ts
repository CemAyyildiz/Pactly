/**
 * A synthetic WebAuthn authenticator for tests: an ES256 keypair from
 * `node:crypto` that produces a `"none"`-attestation registration response
 * and a signed authentication assertion in exactly the JSON shapes the
 * browser's `navigator.credentials.create()/get()` (via
 * @simplewebauthn/browser) would hand the backend. Enough for
 * `verifyRegistrationResponse`/`verifyAuthenticationResponse` to run their
 * real checks (RP id hash, origin, challenge, signature, counter) with no
 * real device. Not itself a test file.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

function b64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString("base64url");
}

function rpIdHash(): Buffer {
  return createHash("sha256").update(RP_ID).digest();
}

function clientDataJSON(type: "webauthn.create" | "webauthn.get", challenge: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }), "utf8");
}

/** COSE_Key for an EC2/P-256 public key (kty 2, alg ES256 -7, crv P-256 1). */
function coseEc2PublicKey(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x as string, "base64url");
  const y = Buffer.from(jwk.y as string, "base64url");
  const map = new Map<number, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, new Uint8Array(x)],
    [-3, new Uint8Array(y)],
  ]);
  return isoCBOR.encode(map as never);
}

function counterBytes(counter: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(counter);
  return buffer;
}

export class FakeAuthenticator {
  readonly credentialId: Buffer;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  counter = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.credentialId = randomBytes(32);
  }

  get credentialIdBase64Url(): string {
    return b64url(this.credentialId);
  }

  /** What the browser would return from `startRegistration(options)`. */
  createRegistrationResponse(challenge: string) {
    const flags = 0x01 | 0x04 | 0x40; // UP | UV | AT
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      rpIdHash(),
      Buffer.from([flags]),
      counterBytes(this.counter),
      Buffer.alloc(16), // aaguid
      idLength,
      this.credentialId,
      Buffer.from(coseEc2PublicKey(this.publicKey)),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]) as never,
    );
    return {
      id: this.credentialIdBase64Url,
      rawId: this.credentialIdBase64Url,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON("webauthn.create", challenge)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** What the browser would return from `startAuthentication(options)`.
   * Advances the signature counter like a real authenticator. */
  createAuthenticationResponse(challenge: string, options: { credentialId?: string } = {}) {
    this.counter += 1;
    const flags = 0x01 | 0x04; // UP | UV
    const authenticatorData = Buffer.concat([rpIdHash(), Buffer.from([flags]), counterBytes(this.counter)]);
    const clientData = clientDataJSON("webauthn.get", challenge);
    const signedOver = Buffer.concat([authenticatorData, createHash("sha256").update(clientData).digest()]);
    const signature = sign("sha256", signedOver, this.privateKey);
    const id = options.credentialId ?? this.credentialIdBase64Url;
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
