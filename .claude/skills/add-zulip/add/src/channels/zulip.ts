import { setTimeout as sleep } from 'timers/promises';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface ZulipChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ZulipCredentials {
  site: string;
  email: string;
  apiKey: string;
}

interface ZulipSelfResponse {
  result: 'success' | 'error';
  msg?: string;
  code?: string;
  user_id: number;
}

interface ZulipRegisterResponse {
  result: 'success' | 'error';
  msg?: string;
  code?: string;
  queue_id: string;
  last_event_id: number;
}

interface ZulipEventResponse {
  result: 'success' | 'error';
  msg?: string;
  code?: string;
  events: ZulipEvent[];
  last_event_id: number;
}

interface ZulipStreamResponse {
  result: 'success' | 'error';
  msg?: string;
  code?: string;
  streams: Array<{ stream_id: number; name: string; is_archived: boolean }>;
}

interface ZulipEvent {
  id: number;
  type: string;
  message?: ZulipMessage;
}

interface ZulipMessage {
  id: number;
  type: 'stream' | 'private';
  stream_id?: number;
  subject?: string;
  display_recipient?: string | { id: number; email: string }[];
  sender_id: number;
  sender_email?: string;
  sender_full_name?: string;
  content: string;
  content_type: string;
  timestamp: number;
}

class RateLimitError extends Error {
  retryAfterMs: number;

  constructor(retryAfterSecs: number) {
    super(`Rate limited, retry after ${retryAfterSecs}s`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterSecs * 1000;
  }
}

class ZulipApiError extends Error {
  code?: string;
  status?: number;

  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = 'ZulipApiError';
    this.code = code;
    this.status = status;
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(html: string): string {
  const collapsed = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return decodeHtmlEntities(collapsed);
}

function normalizeTopic(raw: string | undefined): { id: string; name: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { id: '__empty__', name: '(no topic)' };
  }
  return { id: trimmed, name: trimmed };
}

function parseZulipJid(jid: string): { streamId: number; topic?: string } | null {
  if (!jid.startsWith('zulip:')) return null;
  const parts = jid.split(':');
  if (parts.length < 2) return null;
  const streamId = Number(parts[1]);
  if (!Number.isFinite(streamId)) return null;
  if (parts.length > 2) {
    const topic = parts.slice(2).join(':');
    if (topic === '__empty__') return { streamId, topic: '' };
    return { streamId, topic };
  }
  return { streamId };
}

export class ZulipChannel implements Channel {
  name = 'zulip';

  private opts: ZulipChannelOpts;
  private creds: ZulipCredentials;
  private connected = false;
  private polling = false;
  private pollLoop: Promise<void> | null = null;
  private queueId: string | null = null;
  private lastEventId = 0;
  private userId: number | null = null;
  private streamNames = new Map<number, string>();

  constructor(creds: ZulipCredentials, opts: ZulipChannelOpts) {
    this.creds = creds;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    await this.loadSelf();
    await this.registerEventQueue();

    this.connected = true;
    this.polling = true;
    this.pollLoop = this.pollEvents();

    try {
      await this.syncGroups(false);
    } catch (err) {
      logger.warn({ err }, 'Zulip: failed to sync groups on connect');
    }

    logger.info({ site: this.creds.site, email: this.creds.email }, 'Zulip connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const parsed = parseZulipJid(jid);
    if (!parsed) {
      logger.warn({ jid }, 'Zulip: invalid JID');
      return;
    }

    const topic = parsed.topic ?? 'general';
    const payload = {
      type: 'stream',
      to: parsed.streamId,
      topic,
      content: text,
    };

    try {
      await this.request('/messages', 'POST', payload);
      logger.info({ jid, length: text.length }, 'Zulip message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Zulip message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('zulip:');
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    if (this.pollLoop) {
      await this.pollLoop.catch(() => undefined);
    }
    if (this.queueId) {
      try {
        await this.request('/events', 'DELETE', { queue_id: this.queueId });
      } catch (err) {
        logger.warn({ err }, 'Zulip: failed to delete event queue');
      }
    }
    this.queueId = null;
    this.connected = false;
  }

  async syncGroups(_force: boolean): Promise<void> {
    const response = await this.request<ZulipStreamResponse>('/streams', 'GET');
    const now = new Date().toISOString();
    for (const stream of response.streams || []) {
      if (stream.is_archived) continue;
      this.streamNames.set(stream.stream_id, stream.name);
      this.opts.onChatMetadata(
        `zulip:${stream.stream_id}`,
        now,
        stream.name,
        'zulip',
        true,
      );
    }
  }

  private async loadSelf(): Promise<void> {
    const response = await this.request<ZulipSelfResponse>('/users/me', 'GET');
    this.userId = response.user_id;
  }

  private async registerEventQueue(): Promise<void> {
    const response = await this.request<ZulipRegisterResponse>('/register', 'POST', {
      event_types: ['message'],
      all_public_streams: true,
    });

    this.queueId = response.queue_id;
    this.lastEventId = response.last_event_id;
  }

  private async pollEvents(): Promise<void> {
    while (this.polling) {
      if (!this.queueId) {
        await this.registerEventQueue();
      }
      try {
        const response = await this.request<ZulipEventResponse>('/events', 'GET', {
          queue_id: this.queueId,
          last_event_id: this.lastEventId,
        });

        for (const event of response.events || []) {
          this.handleEvent(event);
        }

        this.lastEventId = response.last_event_id;
      } catch (err) {
        if (err instanceof ZulipApiError && err.code === 'BAD_EVENT_QUEUE_ID') {
          logger.warn('Zulip event queue expired, re-registering');
          await this.registerEventQueue();
          continue;
        }
        if (err instanceof RateLimitError) {
          await sleep(err.retryAfterMs);
          continue;
        }
        logger.warn({ err }, 'Zulip event poll failed, retrying');
        await sleep(2000);
      }
    }
  }

  private handleEvent(event: ZulipEvent): void {
    if (event.type !== 'message' || !event.message) return;
    const message = event.message;
    if (message.type !== 'stream') return;
    if (this.userId && message.sender_id === this.userId) return;

    const streamId = message.stream_id;
    if (!streamId) return;

    const streamName =
      typeof message.display_recipient === 'string'
        ? message.display_recipient
        : this.streamNames.get(streamId);
    if (streamName) this.streamNames.set(streamId, streamName);

    const baseJid = `zulip:${streamId}`;
    const timestamp = new Date(message.timestamp * 1000).toISOString();

    this.opts.onChatMetadata(
      baseJid,
      timestamp,
      streamName || baseJid,
      'zulip',
      true,
    );

    const registered = this.opts.registeredGroups();
    if (!registered[baseJid]) {
      logger.debug({ baseJid }, 'Zulip message from unregistered stream');
      return;
    }

    const normalized = normalizeTopic(message.subject);

    let content = message.content || '';
    if (message.content_type?.includes('text/html')) {
      content = stripHtml(content);
    }

    const escapedName = ASSISTANT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentionPattern = new RegExp(
      `@\\*\\*${escapedName}\\*\\*|@${escapedName}\\b`,
      'i',
    );
    if (mentionPattern.test(content) && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    this.opts.onMessage(baseJid, {
      id: message.id.toString(),
      chat_jid: baseJid,
      sender: message.sender_email || message.sender_id.toString(),
      sender_name:
        message.sender_full_name || message.sender_email || message.sender_id.toString(),
      content,
      timestamp,
      is_from_me: false,
      thread_id: normalized.id,
      thread_name: normalized.name,
    });
  }

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE',
    data?: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(`/api/v1${endpoint}`, this.creds.site);
    const auth = Buffer.from(`${this.creds.email}:${this.creds.apiKey}`).toString(
      'base64',
    );
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      'User-Agent': 'nanoclaw-zulip/1.0',
    };

    const body = this.buildBody(method, url, data, headers);

    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
      throw new RateLimitError(retryAfter);
    }

    if (!response.ok) {
      const text = await response.text();
      let parsed: { msg?: string; code?: string } | null = null;
      try {
        parsed = JSON.parse(text) as { msg?: string; code?: string };
      } catch {
        parsed = null;
      }
      if (parsed) {
        throw new ZulipApiError(
          parsed.msg || `Zulip API error ${response.status}`,
          parsed.code,
          response.status,
        );
      }
      throw new ZulipApiError(
        text || `Zulip API error ${response.status}`,
        undefined,
        response.status,
      );
    }

    const json = (await response.json()) as { result?: string; msg?: string; code?: string } & T;
    if (json.result && json.result !== 'success') {
      throw new ZulipApiError(json.msg || 'Zulip API error', json.code);
    }

    return json as T;
  }

  private buildBody(
    method: 'GET' | 'POST' | 'DELETE',
    url: URL,
    data: Record<string, unknown> | undefined,
    headers: Record<string, string>,
  ): string | undefined {
    if (!data) return undefined;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) || typeof value === 'object') {
        params.set(key, JSON.stringify(value));
      } else {
        params.set(key, String(value));
      }
    }

    if (method === 'GET') {
      for (const [key, value] of params.entries()) {
        url.searchParams.set(key, value);
      }
      return undefined;
    }

    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return params.toString();
  }
}

registerChannel('zulip', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['ZULIP_SITE', 'ZULIP_EMAIL', 'ZULIP_API_KEY']);
  const site = process.env.ZULIP_SITE || envVars.ZULIP_SITE || '';
  const email = process.env.ZULIP_EMAIL || envVars.ZULIP_EMAIL || '';
  const apiKey = process.env.ZULIP_API_KEY || envVars.ZULIP_API_KEY || '';

  if (!site || !email || !apiKey) {
    logger.warn('Zulip: ZULIP_SITE, ZULIP_EMAIL, or ZULIP_API_KEY not set');
    return null;
  }

  return new ZulipChannel({ site, email, apiKey }, opts);
});
