import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ZulipChannel, ZulipChannelOpts, zulipApi } from './zulip.js';

// --- Test helpers ---

const testCreds = {
  email: 'bot@example.zulipchat.com',
  apiKey: 'test-api-key',
  site: 'https://example.zulipchat.com',
};

function createTestOpts(
  overrides?: Partial<ZulipChannelOpts>,
): ZulipChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'zu:42': {
        name: 'General',
        folder: 'zulip-general',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'zu:dm:99': {
        name: 'Alice',
        folder: 'zulip-alice',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createStreamMessage(overrides?: Record<string, any>) {
  return {
    id: 1001,
    type: 'stream',
    stream_id: 42,
    display_recipient: 'general',
    subject: 'greetings',
    sender_id: 99,
    sender_full_name: 'Alice',
    sender_email: 'alice@example.com',
    content: '<p>Hello everyone</p>',
    timestamp: 1704067200,
    ...overrides,
  };
}

function createDmMessage(overrides?: Record<string, any>) {
  return {
    id: 2001,
    type: 'private',
    sender_id: 99,
    sender_full_name: 'Alice',
    sender_email: 'alice@example.com',
    content: '<p>Hi there</p>',
    timestamp: 1704067200,
    ...overrides,
  };
}

// --- Tests ---

describe('ZulipChannel', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Helper to create a connected channel without starting the poll loop
  function createConnectedChannel(): ZulipChannel {
    const channel = new ZulipChannel(testCreds, createTestOpts());
    (channel as any).connected = true;
    (channel as any).myUserId = 123;
    (channel as any).botFullName = 'Andy Bot';
    return channel;
  }

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connects and retrieves bot info', async () => {
      (global.fetch as any)
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              user_id: 123,
              full_name: 'Andy Bot',
              result: 'success',
            }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              result: 'success',
              queue_id: 'q1',
              last_event_id: -1,
            }),
        })
        // First poll — return empty events then abort
        .mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      const opts = createTestOpts();
      const channel = new ZulipChannel(testCreds, opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('throws on auth failure', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        json: () =>
          Promise.resolve({ result: 'error', msg: 'Invalid API key' }),
      });

      const channel = new ZulipChannel(testCreds, createTestOpts());

      await expect(channel.connect()).rejects.toThrow('Zulip auth failed');
    });

    it('disconnects cleanly', async () => {
      (global.fetch as any)
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ user_id: 123, full_name: 'Andy Bot' }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              result: 'success',
              queue_id: 'q1',
              last_event_id: -1,
            }),
        })
        .mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      const channel = new ZulipChannel(testCreds, createTestOpts());
      await channel.connect();

      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const channel = new ZulipChannel(testCreds, createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling (via handleMessage) ---

  describe('message handling', () => {
    let channel: ZulipChannel;
    let opts: ZulipChannelOpts;

    beforeEach(async () => {
      (global.fetch as any)
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ user_id: 123, full_name: 'Andy Bot' }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              result: 'success',
              queue_id: 'q1',
              last_event_id: -1,
            }),
        })
        .mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      opts = createTestOpts();
      channel = new ZulipChannel(testCreds, opts);
      await channel.connect();
      vi.clearAllMocks();
    });

    it('delivers stream message for registered group', () => {
      const msg = createStreamMessage();
      (channel as any).handleMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'zu:42:greetings',
        expect.any(String),
        'general',
        'zulip',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'zu:42:greetings',
        expect.objectContaining({
          id: '1001',
          chat_jid: 'zu:42:greetings',
          sender: '99',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('delivers DM for registered group', () => {
      const msg = createDmMessage();
      (channel as any).handleMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'zu:dm:99',
        expect.any(String),
        'Alice',
        'zulip',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'zu:dm:99',
        expect.objectContaining({
          id: '2001',
          chat_jid: 'zu:dm:99',
          sender: '99',
          sender_name: 'Alice',
          content: 'Hi there',
          is_from_me: false,
        }),
      );
    });

    it('strips HTML from message content', () => {
      const msg = createStreamMessage({
        content: '<p>Hello <strong>world</strong>!</p>',
      });
      (channel as any).handleMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'zu:42:greetings',
        expect.objectContaining({
          content: 'Hello world!',
        }),
      );
    });

    it('skips own messages', () => {
      const msg = createStreamMessage({ sender_id: 123 });
      (channel as any).handleMessage(msg);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('only emits metadata for unregistered chats', () => {
      const msg = createStreamMessage({ stream_id: 999 });
      (channel as any).handleMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'zu:999:greetings',
        expect.any(String),
        'general',
        'zulip',
        true,
      );
      // Messages are always delivered, even for unregistered chats
    });

    it('converts timestamp to ISO format', () => {
      const msg = createStreamMessage({ timestamp: 1704067200 });
      (channel as any).handleMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'zu:42:greetings',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('uses sender name as chat name for DMs', () => {
      const msg = createDmMessage({ sender_full_name: 'Bob' });
      (channel as any).handleMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'zu:dm:99',
        expect.any(String),
        'Bob',
        'zulip',
        false,
      );
    });

    it('uses display_recipient as chat name for streams', () => {
      const msg = createStreamMessage({ display_recipient: 'engineering' });
      (channel as any).handleMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'zu:42:greetings',
        expect.any(String),
        'engineering',
        'zulip',
        true,
      );
    });

    it('passes topic as thread metadata for stream messages', () => {
      const msg = createStreamMessage({ subject: 'deployment' });
      (channel as any).handleMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'zu:42:deployment',
        expect.objectContaining({
          content: 'Hello everyone',
        }),
      );
    });

    it('tracks last topic per stream', () => {
      const msg1 = createStreamMessage({ subject: 'first-topic' });
      (channel as any).handleMessage(msg1);

      const msg2 = createStreamMessage({ subject: 'second-topic' });
      (channel as any).handleMessage(msg2);

      expect((channel as any).lastTopicByStream.get('42')).toBe('second-topic');
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    let channel: ZulipChannel;
    let opts: ZulipChannelOpts;

    beforeEach(async () => {
      (global.fetch as any)
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ user_id: 123, full_name: 'Andy Bot' }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              result: 'success',
              queue_id: 'q1',
              last_event_id: -1,
            }),
        })
        .mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      opts = createTestOpts();
      channel = new ZulipChannel(testCreds, opts);
      await channel.connect();
      vi.clearAllMocks();
    });

    it('translates @**BotName** mention to trigger format', () => {
      const msg = createStreamMessage({
        content: '<p>@**Andy Bot** what time is it?</p>',
      });
      (channel as any).handleMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'zu:42:greetings',
        expect.objectContaining({
          content: expect.stringContaining('@Andy'),
        }),
      );
    });

    it('does not translate if message already matches trigger', () => {
      const msg = createStreamMessage({
        content: '<p>@Andy @**Andy Bot** hello</p>',
      });
      (channel as any).handleMessage(msg);

      const call = (opts.onMessage as any).mock.calls[0];
      const content = call[1].content;
      // Should NOT double-prepend
      expect(content).not.toMatch(/^@Andy @Andy/);
    });

    it('does not translate mentions of other users', () => {
      const msg = createStreamMessage({
        content: '<p>@**Someone Else** check this</p>',
      });
      (channel as any).handleMessage(msg);

      const call = (opts.onMessage as any).mock.calls[0];
      const content = call[1].content;
      expect(content).not.toMatch(/^@Andy/);
    });

    it('handles message with no mentions', () => {
      const msg = createStreamMessage({
        content: '<p>plain message</p>',
      });
      (channel as any).handleMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'zu:42:greetings',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });
  });

  // --- sendMessage ---
  // These tests create channels without connect() to avoid background poll interference.

  describe('sendMessage', () => {
    it('sends stream message to correct stream and topic', async () => {
      const channel = createConnectedChannel();
      (channel as any).lastTopicByStream.set('42', 'greetings');

      (global.fetch as any)
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              result: 'success',
              stream: { name: 'general' },
            }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ result: 'success', id: 5001 }),
        });

      await channel.sendMessage('zu:42:greetings', 'Hello stream');

      const streamCall = (global.fetch as any).mock.calls[0];
      expect(streamCall[0]).toContain('/streams/42');

      const sendCall = (global.fetch as any).mock.calls[1];
      expect(sendCall[0]).toContain('/messages');
      expect(sendCall[1].body).toContain('type=stream');
      expect(sendCall[1].body).toContain('to=general');
      expect(sendCall[1].body).toContain('topic=greetings');
    });

    it('sends DM to correct user', async () => {
      const channel = createConnectedChannel();

      (global.fetch as any).mockResolvedValueOnce({
        json: () => Promise.resolve({ result: 'success', id: 5002 }),
      });

      await channel.sendMessage('zu:dm:99', 'Hello direct');

      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toContain('/messages');
      expect(call[1].body).toContain('type=direct');
    });

    it('uses default topic "chat" when no topic tracked', async () => {
      const channel = createConnectedChannel();

      (global.fetch as any)
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              result: 'success',
              stream: { name: 'general' },
            }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ result: 'success', id: 5003 }),
        });

      await channel.sendMessage('zu:42:greetings', 'No topic tracked');

      const sendCall = (global.fetch as any).mock.calls[1];
      expect(sendCall[1].body).toContain('topic=greetings');
    });

    it('handles send failure gracefully', async () => {
      const channel = createConnectedChannel();

      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      await expect(
        channel.sendMessage('zu:dm:99', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when not connected', async () => {
      const channel = new ZulipChannel(testCreds, createTestOpts());

      await channel.sendMessage('zu:42:greetings', 'No connection');

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('splits messages exceeding 10000 characters', async () => {
      const channel = createConnectedChannel();
      (channel as any).lastTopicByStream.set('42', 'greetings');

      (global.fetch as any)
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              result: 'success',
              stream: { name: 'general' },
            }),
        })
        .mockResolvedValue({
          json: () => Promise.resolve({ result: 'success', id: 5004 }),
        });

      const longText = 'x'.repeat(15000);
      await channel.sendMessage('zu:42:greetings', longText);

      // 1 stream info call + 2 message sends
      expect((global.fetch as any).mock.calls.length).toBe(3);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing start for stream with tracked topic', async () => {
      const channel = createConnectedChannel();
      (channel as any).lastTopicByStream.set('42', 'greetings');

      (global.fetch as any).mockResolvedValueOnce({
        json: () => Promise.resolve({ result: 'success' }),
      });

      await channel.setTyping('zu:42:greetings', true);

      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toContain('/typing');
      expect(call[1].body).toContain('op=start');
      expect(call[1].body).toContain('type=stream');
      expect(call[1].body).toContain('stream_id=42');
      expect(call[1].body).toContain('topic=greetings');
    });

    it('sends typing stop for stream', async () => {
      const channel = createConnectedChannel();
      (channel as any).lastTopicByStream.set('42', 'greetings');

      (global.fetch as any).mockResolvedValueOnce({
        json: () => Promise.resolve({ result: 'success' }),
      });

      await channel.setTyping('zu:42:greetings', false);

      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toContain('/typing');
      expect(call[1].body).toContain('op=stop');
      expect(call[1].body).toContain('type=stream');
    });

    it('sends typing start for DM', async () => {
      const channel = createConnectedChannel();

      (global.fetch as any).mockResolvedValueOnce({
        json: () => Promise.resolve({ result: 'success' }),
      });

      await channel.setTyping('zu:dm:99', true);

      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toContain('/typing');
      expect(call[1].body).toContain('op=start');
      expect(call[1].body).toContain('type=direct');
      expect(call[1].body).toContain('to=%5B99%5D'); // URL-encoded [99]
    });

    it('uses default topic "chat" when no topic tracked', async () => {
      const channel = createConnectedChannel();

      (global.fetch as any).mockResolvedValueOnce({
        json: () => Promise.resolve({ result: 'success' }),
      });

      await channel.setTyping('zu:42:greetings', true);

      const call = (global.fetch as any).mock.calls[0];
      expect(call[1].body).toContain('topic=greetings');
    });

    it('handles typing API failure gracefully', async () => {
      const channel = createConnectedChannel();

      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      await expect(
        channel.setTyping('zu:dm:99', true),
      ).resolves.toBeUndefined();
    });

    it('does nothing when not connected', async () => {
      const channel = new ZulipChannel(testCreds, createTestOpts());

      await channel.setTyping('zu:42:greetings', true);

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('parses JID with topic correctly', async () => {
      const channel = createConnectedChannel();

      (global.fetch as any).mockResolvedValueOnce({
        json: () => Promise.resolve({ result: 'success' }),
      });

      await channel.setTyping('zu:42:custom-topic', true);

      const call = (global.fetch as any).mock.calls[0];
      expect(call[1].body).toContain('stream_id=42');
      expect(call[1].body).toContain('topic=custom-topic');
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns zu: JIDs (streams)', () => {
      const channel = new ZulipChannel(testCreds, createTestOpts());
      expect(channel.ownsJid('zu:42')).toBe(true);
    });

    it('owns zu:dm: JIDs (DMs)', () => {
      const channel = new ZulipChannel(testCreds, createTestOpts());
      expect(channel.ownsJid('zu:dm:99')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new ZulipChannel(testCreds, createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = new ZulipChannel(testCreds, createTestOpts());
      expect(channel.ownsJid('dc:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new ZulipChannel(testCreds, createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "zulip"', () => {
      const channel = new ZulipChannel(testCreds, createTestOpts());
      expect(channel.name).toBe('zulip');
    });
  });

  // --- zulipApi ---

  describe('zulipApi', () => {
    it('makes GET request with correct auth header', async () => {
      (global.fetch as any).mockResolvedValue({
        json: () => Promise.resolve({ result: 'success', user_id: 123 }),
        status: 200,
      });

      await zulipApi(testCreds, '/users/me');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = (global.fetch as any).mock.calls[0];
      expect(url).toBe('https://example.zulipchat.com/api/v1/users/me');
      expect(opts.method).toBe('GET');
      expect(opts.headers.Authorization).toMatch(/^Basic /);
    });

    it('makes POST request with form-encoded body', async () => {
      (global.fetch as any).mockResolvedValue({
        json: () => Promise.resolve({ result: 'success', id: 456 }),
        status: 200,
      });

      await zulipApi(testCreds, '/messages', 'POST', {
        type: 'stream',
        to: 'general',
        content: 'Hello!',
      });

      const [, opts] = (global.fetch as any).mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
      expect(opts.body).toContain('type=stream');
      expect(opts.body).toContain('to=general');
    });

    it('throws on 429 rate limit', async () => {
      (global.fetch as any).mockResolvedValue({
        status: 429,
        headers: {
          get: (key: string) => (key === 'retry-after' ? '30' : null),
        },
      });

      await expect(zulipApi(testCreds, '/messages')).rejects.toThrow(
        'Rate limited',
      );
    });

    it('returns parsed JSON response', async () => {
      const mockResponse = { result: 'success', messages: [{ id: 1 }] };
      (global.fetch as any).mockResolvedValue({
        json: () => Promise.resolve(mockResponse),
        status: 200,
      });

      const result = await zulipApi(testCreds, '/messages');
      expect(result).toEqual(mockResponse);
    });
  });
});
