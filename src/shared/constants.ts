export const PROTOCOL_VERSION = 1;

/** How long a pairing token stays valid before it must be re-issued. */
export const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

/** How long a freshly-opened WS connection has to send a valid `hello` before being dropped. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5 * 1000;

/** How long a single list-identities/sign request waits for a browser reply before failing. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;

export const SSH_ED25519 = 'ssh-ed25519';
