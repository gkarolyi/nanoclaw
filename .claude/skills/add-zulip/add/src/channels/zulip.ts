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
  email: string;
  apiKey: string;
  site: string;
}

export async function zulipApi(
  creds: ZulipCredentials,
  endpoint: string,
  method = 'GET',
  data?: Record<string, string>,
  opts?: { timeoutMs?: number },
): Promise<any> {
  const url = new URL(`/api/v1${endpoint}`, creds.site);
  const auth = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    'User-Agent': 'nanoclaw-zulip/1.0',
  };

  let body: string | undefined;
  if (data && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(data).toString();
  }

  const fetchOpts: RequestInit = { method, headers, body };
  if (opts?.timeoutMs) {
    fetchOpts.signal = AbortSignal.timeout(opts.timeoutMs);
  }

  const response = await fetch(url.toString(), fetchOpts);

  if (response.status === 429) {
    const retryAfter = parseInt(
      response.headers.get('retry-after') || '60',
      10,
    );
    const err = new Error(
      `Rate limited, retry after ${retryAfter}s`,
    ) as Error & { retryAfterMs: number };
    err.retryAfterMs = retryAfter * 1000;
    throw err;
  }

  return response.json();
}

function stripHtml(content: string): string {
  return content.replace(/<[^>]*>/g, '');
}

export class ZulipChannel implements Channel {
  name = 'zulip';

  private opts: ZulipChannelOpts;
  private creds: ZulipCredentials;
  private connected = false;
  private abortController: AbortController | null = null;
  private myUserId: number | null = null;
  private botFullName: string | null = null;

  // Track last topic per stream for replies
  private lastTopicByStream = new Map<string, string>();

  constructor(creds: ZulipCredentials, opts: ZulipChannelOpts) {
    this.creds = creds;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Verify credentials and get bot info
    const meResult = await zulipApi(this.creds, '/users/me');
    if (!meResult.user_id) {
      throw new Error(`Zulip auth failed: ${meResult.msg || 'unknown error'}`);
    }

    this.myUserId = meResult.user_id;
    this.botFullName = meResult.full_name;
    this.connected = true;
    this.abortController = new AbortController();

    logger.info(
      { email: this.creds.email, userId: this.myUserId, name: this.botFullName },
      'Zulip bot connected',
    );
    console.log(`\n  Zulip bot: ${this.botFullName} (${this.creds.email})`);
    console.log(`  Site: ${this.creds.site}\n`);

    // Start long-poll event loop in the background
    this.pollLoop().catch((err) => {
      logger.error({ err: err.message }, 'Zulip poll loop crashed');
    });
  }

  private async pollLoop(): Promise<void> {
    // Register event queue
    const registerResult = await zulipApi(this.creds, '/register', 'POST', {
      event_types: JSON.stringify(['message']),
    });

    if (registerResult.result !== 'success') {
      logger.error(
        { msg: registerResult.msg },
        'Failed to register Zulip event queue',
      );
      return;
    }

    let queueId = registerResult.queue_id;
    let lastEventId = registerResult.last_event_id;

    const POLL_TIMEOUT_MS = 90_000;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 20;

    const backoff = async (errors: number) => {
      const ms = Math.min(5000 * Math.pow(2, errors - 1), 120_000);
      logger.info(
        { ms, errors, max: MAX_CONSECUTIVE_ERRORS },
        'Zulip backing off',
      );
      await new Promise((r) => setTimeout(r, ms));
    };

    const reRegister = async (): Promise<boolean> => {
      const reReg = await zulipApi(this.creds, '/register', 'POST', {
        event_types: JSON.stringify(['message']),
      });
      if (reReg.result === 'success') {
        queueId = reReg.queue_id;
        lastEventId = reReg.last_event_id;
        logger.info('Zulip re-registered event queue');
        return true;
      }
      logger.error({ msg: reReg.msg }, 'Zulip re-registration failed');
      return false;
    };

    while (this.connected && !this.abortController?.signal.aborted) {
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        logger.error(
          { errors: consecutiveErrors },
          'Zulip too many consecutive errors, stopping poller',
        );
        return;
      }

      try {
        const qs = `queue_id=${encodeURIComponent(queueId)}&last_event_id=${lastEventId}&dont_block=false`;
        const result = await zulipApi(
          this.creds,
          `/events?${qs}`,
          'GET',
          undefined,
          { timeoutMs: POLL_TIMEOUT_MS },
        );

        if (result.result !== 'success') {
          consecutiveErrors++;
          if (String(result.msg).includes('BAD_EVENT_QUEUE_ID')) {
            logger.warn('Zulip queue expired, re-registering...');
            if (!(await reRegister())) {
              await backoff(consecutiveErrors);
            }
          } else {
            logger.error({ msg: result.msg }, 'Zulip poll failed');
            await backoff(consecutiveErrors);
          }
          continue;
        }

        if (consecutiveErrors > 0) {
          logger.info(
            { errors: consecutiveErrors },
            'Zulip poll recovered',
          );
        }
        consecutiveErrors = 0;

        for (const event of result.events) {
          lastEventId = event.id;

          if (event.type === 'message') {
            this.handleMessage(event.message);
          }
        }
      } catch (err: any) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          // Normal — long-poll timed out with no events
          continue;
        }
        if (err.retryAfterMs) {
          logger.warn(
            { retryAfterMs: err.retryAfterMs },
            'Zulip rate limited',
          );
          await new Promise((r) => setTimeout(r, err.retryAfterMs));
          consecutiveErrors++;
          continue;
        }
        consecutiveErrors++;
        logger.error({ err: err.message }, 'Zulip poll error');
        await backoff(consecutiveErrors);
      }
    }

    logger.info('Zulip poll loop exited');
  }

  private handleMessage(msg: any): void {
    // Skip our own messages
    if (msg.sender_id === this.myUserId) return;

    const isStream = msg.type === 'stream';
    const streamId = isStream ? String(msg.stream_id) : null;
    const chatJid = isStream
      ? `zu:${streamId}`
      : `zu:dm:${msg.sender_id}`;

    const topic = isStream ? msg.subject : undefined;
    let content = stripHtml(msg.content);
    const timestamp = new Date(msg.timestamp * 1000).toISOString();
    const senderName = msg.sender_full_name || msg.sender_email || 'Unknown';
    const sender = String(msg.sender_id);
    const msgId = String(msg.id);

    // Track last topic per stream for reply routing
    if (isStream && topic && streamId) {
      this.lastTopicByStream.set(streamId, topic);
    }

    // Determine chat name
    const chatName = isStream
      ? (msg.display_recipient || chatJid)
      : senderName;

    // Translate Zulip @**BotName** mentions to trigger format.
    // Zulip uses @**Full Name** for mentions. We translate the bot's mention
    // to @ASSISTANT_NAME so TRIGGER_PATTERN can match.
    if (this.botFullName) {
      const zulipMention = `@**${this.botFullName}**`;
      if (content.includes(zulipMention) && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Prefix topic context for stream messages so the agent knows the topic
    if (isStream && topic) {
      content = `[topic: ${topic}] ${content}`;
    }

    // Store chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'zulip', isStream);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Zulip chat',
      );
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, topic, sender: senderName },
      'Zulip message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn('Zulip not connected');
      return;
    }

    try {
      const isStream = jid.startsWith('zu:') && !jid.startsWith('zu:dm:');

      if (isStream) {
        const streamId = jid.replace(/^zu:/, '');
        const topic = this.lastTopicByStream.get(streamId) || 'chat';

        // Get stream name from stream ID
        const streamInfo = await zulipApi(
          this.creds,
          `/streams/${streamId}`,
        );
        const streamName =
          streamInfo.stream?.name || streamId;

        // Zulip supports long messages (10k+), but split at 10000 for safety
        const MAX_LENGTH = 10000;
        const chunks =
          text.length <= MAX_LENGTH
            ? [text]
            : text.match(new RegExp(`.{1,${MAX_LENGTH}}`, 'gs')) || [text];

        for (const chunk of chunks) {
          await zulipApi(this.creds, '/messages', 'POST', {
            type: 'stream',
            to: streamName,
            topic,
            content: chunk,
          });
        }
      } else {
        // DM: zu:dm:{userId}
        const userId = jid.replace(/^zu:dm:/, '');

        const MAX_LENGTH = 10000;
        const chunks =
          text.length <= MAX_LENGTH
            ? [text]
            : text.match(new RegExp(`.{1,${MAX_LENGTH}}`, 'gs')) || [text];

        for (const chunk of chunks) {
          await zulipApi(this.creds, '/messages', 'POST', {
            type: 'direct',
            to: JSON.stringify([parseInt(userId, 10)]),
            content: chunk,
          });
        }
      }

      logger.info({ jid, length: text.length }, 'Zulip message sent');
    } catch (err: any) {
      logger.error({ jid, err: err.message }, 'Failed to send Zulip message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('zu:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    logger.info('Zulip bot stopped');
  }
}

registerChannel('zulip', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'ZULIP_BOT_EMAIL',
    'ZULIP_BOT_API_KEY',
    'ZULIP_SITE',
  ]);
  const email =
    process.env.ZULIP_BOT_EMAIL || envVars.ZULIP_BOT_EMAIL || '';
  const apiKey =
    process.env.ZULIP_BOT_API_KEY || envVars.ZULIP_BOT_API_KEY || '';
  const site = process.env.ZULIP_SITE || envVars.ZULIP_SITE || '';

  if (!email || !apiKey || !site) {
    logger.warn('Zulip: credentials not set (ZULIP_BOT_EMAIL, ZULIP_BOT_API_KEY, ZULIP_SITE)');
    return null;
  }

  return new ZulipChannel({ email, apiKey, site }, opts);
});
