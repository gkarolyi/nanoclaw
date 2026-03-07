import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { ZulipChannel, ZulipChannelOpts } from './zulip.js';

const CREDS = {
  site: 'https://chat.example.com',
  email: 'bot@example.com',
  apiKey: 'test-key',
};

function getUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof (input as { url?: string }).url === 'string') {
    return (input as { url: string }).url;
  }
  return String(input);
}

function mockJsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers,
    }),
  );
}

function createOpts(overrides?: Partial<ZulipChannelOpts>): ZulipChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'zulip:5': {
        name: 'Testing',
        folder: 'zulip_testing',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function stopPolling(channel: ZulipChannel): void {
  (channel as unknown as { polling: boolean }).polling = false;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ZulipChannel', () => {
  it('connects and registers the event queue', async () => {
    let channel: ZulipChannel | null = null;
    let eventCalls = 0;
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = getUrl(input);
      if (url.includes('/users/me')) {
        return mockJsonResponse({ result: 'success', user_id: 42 });
      }
      if (url.includes('/register')) {
        return mockJsonResponse({
          result: 'success',
          queue_id: 'q1',
          last_event_id: 1,
        });
      }
      if (url.includes('/streams')) {
        return mockJsonResponse({ result: 'success', streams: [] });
      }
      if (url.includes('/events')) {
        eventCalls += 1;
        if (eventCalls === 1 && channel) {
          stopPolling(channel);
        }
        return mockJsonResponse({
          result: 'success',
          events: [],
          last_event_id: 1,
        });
      }
      return mockJsonResponse({ result: 'success' });
    });
    globalThis.fetch = fetchMock;

    const opts = createOpts();
    channel = new ZulipChannel(CREDS, opts);

    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    expect(fetchMock).toHaveBeenCalled();

    await channel.disconnect();
  });

  it('delivers stream messages with topic metadata', async () => {
    const onMessage = vi.fn();
    let channel: ZulipChannel | null = null;
    let eventCalls = 0;
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = getUrl(input);
      if (url.includes('/users/me')) {
        return mockJsonResponse({ result: 'success', user_id: 99 });
      }
      if (url.includes('/register')) {
        return mockJsonResponse({
          result: 'success',
          queue_id: 'q1',
          last_event_id: 1,
        });
      }
      if (url.includes('/streams')) {
        return mockJsonResponse({ result: 'success', streams: [] });
      }
      if (url.includes('/events')) {
        eventCalls += 1;
        if (eventCalls === 1 && channel) {
          stopPolling(channel);
          return mockJsonResponse({
            result: 'success',
            last_event_id: 2,
            events: [
              {
                id: 1,
                type: 'message',
                message: {
                  id: 100,
                  type: 'stream',
                  stream_id: 5,
                  subject: 'testing',
                  display_recipient: 'testing-channel',
                  sender_id: 1,
                  sender_email: 'alice@example.com',
                  sender_full_name: 'Alice',
                  content: '@**Andy** hello',
                  content_type: 'text/x-markdown',
                  timestamp: 1_700_000_000,
                },
              },
            ],
          });
        }
        return mockJsonResponse({
          result: 'success',
          events: [],
          last_event_id: 2,
        });
      }
      return mockJsonResponse({ result: 'success' });
    });
    globalThis.fetch = fetchMock;

    const opts = createOpts({ onMessage });
    channel = new ZulipChannel(CREDS, opts);

    await channel.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await channel.disconnect();

    expect(onMessage).toHaveBeenCalledWith(
      'zulip:5',
      expect.objectContaining({
        thread_id: 'testing',
        thread_name: 'testing',
        content: expect.stringContaining('@Andy'),
      }),
    );
  });

  it('sends messages using topic from JID', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) =>
      mockJsonResponse({ result: 'success', id: 123 }),
    );
    globalThis.fetch = fetchMock;

    const channel = new ZulipChannel(CREDS, createOpts());

    await channel.sendMessage('zulip:5:standup', 'Hello');

    const call = fetchMock.mock.calls[0];
    const body = call?.[1]?.body as string;
    expect(body).toContain('to=5');
    expect(body).toContain('topic=standup');
    expect(body).toContain('content=Hello');
  });
});
