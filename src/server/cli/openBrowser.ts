import { spawn } from 'node:child_process';

/** True when the process looks like it's running in a remote/headless SSH session, where auto-opening a local browser makes no sense. */
export function looksLikeRemoteSession(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
}

/**
 * Best-effort, never throws: shells out to the OS-native URL opener rather
 * than adding an `open` npm dependency, consistent with this package having
 * zero runtime deps beyond `ssh2`/`ws`/`@noble/curves`/`bcrypt-pbkdf`.
 */
export function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // Best-effort: the pairing URL is always printed to stderr regardless.
  }
}
