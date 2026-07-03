/**
 * Bourne-shell (`sh`/`bash`/`zsh`) output matching real `ssh-agent`'s own
 * format, so `eval "$(bssh-agent)"` (or any host app's own CLI reusing these
 * formatters) exports `SSH_AUTH_SOCK`/`SSH_AGENT_PID` into the calling
 * interactive shell — the only way to reach a shell process our own Node
 * process didn't spawn. csh/tcsh's `setenv` syntax is not supported.
 */

export interface AgentStartVars {
  sshAuthSock: string;
  agentPid: number;
}

export function formatAgentStartScript(vars: AgentStartVars): string {
  return (
    `SSH_AUTH_SOCK=${vars.sshAuthSock}; export SSH_AUTH_SOCK;\n` +
    `SSH_AGENT_PID=${vars.agentPid}; export SSH_AGENT_PID;\n` +
    `echo Agent pid ${vars.agentPid};\n`
  );
}

export function formatAgentKillScript(agentPid: number): string {
  return `unset SSH_AUTH_SOCK;\nunset SSH_AGENT_PID;\necho Agent pid ${agentPid} killed;\n`;
}
