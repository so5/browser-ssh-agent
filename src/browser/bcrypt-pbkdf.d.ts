declare module 'bcrypt-pbkdf' {
  interface BcryptPbkdf {
    /** Derives `keylen` bytes into `key` (mutated in place). Returns 0 on success, -1 on error. */
    pbkdf(
      pass: Uint8Array,
      passlen: number,
      salt: Uint8Array,
      saltlen: number,
      key: Uint8Array,
      keylen: number,
      rounds: number
    ): number;
  }
  const bcryptPbkdf: BcryptPbkdf;
  export default bcryptPbkdf;
}
