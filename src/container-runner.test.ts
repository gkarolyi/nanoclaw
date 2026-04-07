import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_RUNTIME: '',
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import fs from 'fs';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('skill sync', () => {
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as any);
    vi.mocked(fs.cpSync).mockReset();
    const cp = await import('child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function spawnContainer() {
    const p = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    return p;
  }

  function getMountArgs(): string[] {
    const args: string[] = spawnMock.mock.calls[0]?.[1] ?? [];
    const mounts: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-v' && args[i + 1]) mounts.push(args[i + 1]);
    }
    return mounts;
  }

  it('mounts built-in skills from container/skills/ as read-only bind mounts', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).includes('container/skills'),
    );
    vi.mocked(fs.readdirSync).mockImplementation((p) =>
      String(p).includes('container/skills') ? (['agent-browser'] as any) : [],
    );
    vi.mocked(fs.statSync).mockImplementation(
      (p) =>
        ({
          isDirectory: () => String(p).includes('agent-browser'),
        }) as any,
    );

    await spawnContainer();

    // Built-ins are mounted, not copied
    expect(vi.mocked(fs.cpSync)).not.toHaveBeenCalled();
    const mounts = getMountArgs();
    expect(
      mounts.some(
        (m) =>
          m.includes('agent-browser') &&
          m.endsWith(':/home/node/.claude/skills/agent-browser:ro'),
      ),
    ).toBe(true);
  });

  it('mounts global skills as live read-only bind mounts', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).includes('global/skills'),
    );
    vi.mocked(fs.readdirSync).mockImplementation((p) =>
      String(p).includes('global/skills') ? (['caveman'] as any) : [],
    );
    vi.mocked(fs.statSync).mockImplementation(
      (p) =>
        ({
          isDirectory: () => String(p).includes('caveman'),
        }) as any,
    );

    await spawnContainer();

    expect(vi.mocked(fs.cpSync)).not.toHaveBeenCalled();
    const mounts = getMountArgs();
    expect(
      mounts.some(
        (m) =>
          m.includes('caveman') &&
          m.endsWith(':/home/node/.claude/skills/caveman:ro'),
      ),
    ).toBe(true);
  });

  it('mounts group-specific skills as live read-only bind mounts', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).includes('test-group/skills'),
    );
    vi.mocked(fs.readdirSync).mockImplementation((p) =>
      String(p).includes('test-group/skills') ? (['my-skill'] as any) : [],
    );
    vi.mocked(fs.statSync).mockImplementation(
      (p) =>
        ({
          isDirectory: () => String(p).includes('my-skill'),
        }) as any,
    );

    await spawnContainer();

    expect(vi.mocked(fs.cpSync)).not.toHaveBeenCalled();
    const mounts = getMountArgs();
    expect(
      mounts.some(
        (m) =>
          m.includes('my-skill') &&
          m.endsWith(':/home/node/.claude/skills/my-skill:ro'),
      ),
    ).toBe(true);
  });

  it('skips skill sources that do not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await spawnContainer();

    const mounts = getMountArgs();
    expect(mounts.some((m) => m.includes('/home/node/.claude/skills/'))).toBe(
      false,
    );
  });

  it('skips non-directory entries in skill source', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).includes('container/skills'),
    );
    vi.mocked(fs.readdirSync).mockImplementation((p) =>
      String(p).includes('container/skills')
        ? (['README.md', 'agent-browser'] as any)
        : [],
    );
    vi.mocked(fs.statSync).mockImplementation(
      (p) =>
        ({
          isDirectory: () => String(p).includes('agent-browser'),
        }) as any,
    );

    await spawnContainer();

    expect(vi.mocked(fs.cpSync)).not.toHaveBeenCalled();
    const mounts = getMountArgs();
    const skillMounts = mounts.filter((m) =>
      m.includes('/home/node/.claude/skills/'),
    );
    expect(skillMounts).toHaveLength(1);
    expect(skillMounts[0]).toContain('agent-browser');
  });

  it('mounts all three skill sources when all exist', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      return (
        s.includes('container/skills') ||
        s.includes('global/skills') ||
        s.includes('test-group/skills')
      );
    });
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      const s = String(p);
      if (s.includes('container/skills')) return ['agent-browser'] as any;
      if (s.includes('global/skills')) return ['caveman'] as any;
      if (s.includes('test-group/skills')) return ['my-skill'] as any;
      return [];
    });
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);

    await spawnContainer();

    // Nothing copied — all mounted
    expect(vi.mocked(fs.cpSync)).not.toHaveBeenCalled();

    const mounts = getMountArgs();
    expect(
      mounts.some(
        (m) =>
          m.includes('agent-browser') &&
          m.endsWith(':/home/node/.claude/skills/agent-browser:ro'),
      ),
    ).toBe(true);
    expect(mounts.some((m) => m.includes('caveman'))).toBe(true);
    expect(mounts.some((m) => m.includes('my-skill'))).toBe(true);
  });
});
