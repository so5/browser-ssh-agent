import { describe, expect, it } from 'vitest';
import { formatAgentKillScript, formatAgentStartScript } from '../src/server/shellEnv.js';

describe('formatAgentStartScript', () => {
  it('matches ssh-agent\'s Bourne-shell export format exactly', () => {
    const script = formatAgentStartScript({ sshAuthSock: '/tmp/bssh-agent-abc.sock', agentPid: 1234 });
    expect(script).toBe(
      'SSH_AUTH_SOCK=/tmp/bssh-agent-abc.sock; export SSH_AUTH_SOCK;\n' +
        'SSH_AGENT_PID=1234; export SSH_AGENT_PID;\n' +
        'echo Agent pid 1234;\n'
    );
  });
});

describe('formatAgentKillScript', () => {
  it('matches ssh-agent -k\'s output format exactly', () => {
    const script = formatAgentKillScript(1234);
    expect(script).toBe('unset SSH_AUTH_SOCK;\nunset SSH_AGENT_PID;\necho Agent pid 1234 killed;\n');
  });
});
