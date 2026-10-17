export interface EncryptedSession {
  version: 1;
  iv: string;
  ciphertext: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(secret)) throw new Error();
    bytes = fromBase64(secret);
    if (bytes.length !== 32) throw new Error();
  } catch {
    throw new Error("SESSION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** The tenant binding prevents a ciphertext copied to another user from decrypting. */
export async function encryptSession(secret: string, value: unknown, tenant: string): Promise<EncryptedSession> {
  const key = await sessionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: new TextEncoder().encode(`openecobee-session-v1:${tenant}`),
    tagLength: 128,
  }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { version: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptSession<T>(secret: string, value: EncryptedSession, tenant: string): Promise<T> {
  if (value.version !== 1) throw new Error("Unsupported encrypted session version.");
  const key = await sessionKey(secret);
  const iv = fromBase64(value.iv);
  if (iv.length !== 12) throw new Error("Invalid encrypted session.");
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv,
    additionalData: new TextEncoder().encode(`openecobee-session-v1:${tenant}`),
    tagLength: 128,
  }, key, fromBase64(value.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
