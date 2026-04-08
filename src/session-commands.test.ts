import { describe, it, expect, vi } from 'vitest';
import {
  extractSessionCommand,
  handleSessionCommand,
} from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toBe('/compact');
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
  });

  it('detects /register as standalone command', () => {
    expect(extractSessionCommand('/register', trigger)).toBe('/register');
  });

  it('does not detect /register with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /register', trigger)).toBeNull();
  });

  it('detects /unregister as standalone command', () => {
    expect(extractSessionCommand('/unregister', trigger)).toBe('/unregister');
  });

  it('does not detect /unregister with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /unregister', trigger)).toBeNull();
  });

  it('detects /backfill as standalone command', () => {
    expect(extractSessionCommand('/backfill', trigger)).toBe('/backfill');
  });

  it('does not detect /backfill with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /backfill', trigger)).toBeNull();
  });

  it('detects /commands as standalone command', () => {
    expect(extractSessionCommand('/commands', trigger)).toBe('/commands');
  });

  it('detects /help as alias for /commands', () => {
    expect(extractSessionCommand('/help', trigger)).toBe('/commands');
  });

  it('detects /stop as standalone command', () => {
    expect(extractSessionCommand('/stop', trigger)).toBe('/stop');
  });

  it('does not detect /stop with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /stop', trigger)).toBeNull();
  });

  it('rejects /stop with extra text', () => {
    expect(extractSessionCommand('/stop now', trigger)).toBeNull();
  });

  it('handles whitespace around /stop', () => {
    expect(extractSessionCommand('  /stop  ', trigger)).toBe('/stop');
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    chatJid: 'test-chat-jid',
    ...overrides,
  };
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('allows interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-compact + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });

  it('handles /register command', async () => {
    const registerTopic = vi.fn().mockResolvedValue({
      success: true,
      message: 'Topic registered successfully.',
    });
    const deps = makeDeps({ registerTopic });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/register', { is_from_me: true })],
      isMainGroup: true,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(registerTopic).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Topic registered successfully.',
    );
    expect(deps.advanceCursor).toHaveBeenCalled();
  });

  it('handles /register when not supported', async () => {
    const deps = makeDeps(); // No registerTopic function

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/register', { is_from_me: true })],
      isMainGroup: true,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Topic registration is not supported for this channel type.',
    );
    expect(deps.advanceCursor).toHaveBeenCalled();
  });

  it('handles /unregister command', async () => {
    const unregisterTopic = vi.fn().mockResolvedValue({
      success: true,
      message: 'Topic unregistered successfully.',
    });
    const deps = makeDeps({ unregisterTopic });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/unregister', { is_from_me: true })],
      isMainGroup: true,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(unregisterTopic).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Topic unregistered successfully.',
    );
    expect(deps.advanceCursor).toHaveBeenCalled();
  });

  it('handles /unregister when not supported', async () => {
    const deps = makeDeps(); // No unregisterTopic function

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/unregister', { is_from_me: true })],
      isMainGroup: true,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Topic unregistration is not supported for this channel type.',
    );
    expect(deps.advanceCursor).toHaveBeenCalled();
  });

  it('handles /commands command', async () => {
    const deps = makeDeps();

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/commands', { is_from_me: true })],
      isMainGroup: true,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Available Session Commands'),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('/register'),
    );
    expect(deps.advanceCursor).toHaveBeenCalled();
  });

  it('handles /help as alias for /commands', async () => {
    const deps = makeDeps();

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/help', { is_from_me: true })],
      isMainGroup: true,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Available Session Commands'),
    );
  });

  it('/commands help includes /stop', async () => {
    const deps = makeDeps();

    await handleSessionCommand({
      missedMessages: [makeMsg('/commands', { is_from_me: true })],
      isMainGroup: true,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('/stop'),
    );
  });

  it('handles /stop: calls stopAgent, sends Stopped., advances cursor', async () => {
    const stopAgent = vi.fn();
    const deps = makeDeps({ stopAgent });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/stop', { timestamp: '200' })],
      isMainGroup: true,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(stopAgent).toHaveBeenCalledOnce();
    expect(deps.sendMessage).toHaveBeenCalledWith('Stopped.');
    expect(deps.advanceCursor).toHaveBeenCalledWith('200');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('handles /stop without stopAgent dep (no-op, still sends confirmation)', async () => {
    const deps = makeDeps(); // no stopAgent

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/stop')],
      isMainGroup: true,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('Stopped.');
    expect(deps.advanceCursor).toHaveBeenCalled();
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('handles /stop from is_from_me sender in non-main group', async () => {
    const stopAgent = vi.fn();
    const deps = makeDeps({ stopAgent });

    const result = await handleSessionCommand({
      missedMessages: [
        makeMsg('/stop', { is_from_me: true, timestamp: '300' }),
      ],
      isMainGroup: false,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(stopAgent).toHaveBeenCalledOnce();
    expect(deps.sendMessage).toHaveBeenCalledWith('Stopped.');
    expect(deps.advanceCursor).toHaveBeenCalledWith('300');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('/stop does not process pre-stop messages through the agent', async () => {
    const stopAgent = vi.fn();
    const deps = makeDeps({ stopAgent });

    const msgs = [
      makeMsg('some work request', { timestamp: '99' }),
      makeMsg('/stop', { timestamp: '100' }),
    ];

    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'Test Group',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(stopAgent).toHaveBeenCalledOnce();
    expect(deps.sendMessage).toHaveBeenCalledWith('Stopped.');
    // runAgent must NOT be called — /stop skips pre-command agent processing
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });
});
