import { decryptOpenSshEd25519Key } from './keyImport/decrypt.js';
import { parseOpenSshPrivateKeyPem } from './keyImport/opensshKey.js';
import { KeyHandle } from './keyStore.js';

export { KeyHandle } from './keyStore.js';
export { connectAgent } from './wsClient.js';
export type { AgentConnection, AgentConnectionStatus, ConfirmSignInfo, ConnectAgentOptions } from './wsClient.js';
export { getSigner } from './signers/index.js';
export type { Signer } from './signers/index.js';

/** Parses + decrypts an OpenSSH `id_ed25519`-style private key file, holding the result in memory. */
export async function loadKeyFromFile(file: File, passphrase: string): Promise<KeyHandle> {
  const text = await file.text();
  const parsed = parseOpenSshPrivateKeyPem(text);
  const decrypted = await decryptOpenSshEd25519Key(parsed, passphrase);
  return new KeyHandle(decrypted.publicKey, decrypted.seed, decrypted.comment);
}

/** Same as `loadKeyFromFile` but from raw PEM text (e.g. read via some other means than a `File`). */
export async function loadKeyFromText(pem: string, passphrase: string): Promise<KeyHandle> {
  const parsed = parseOpenSshPrivateKeyPem(pem);
  const decrypted = await decryptOpenSshEd25519Key(parsed, passphrase);
  return new KeyHandle(decrypted.publicKey, decrypted.seed, decrypted.comment);
}
