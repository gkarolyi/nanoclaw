import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  Attachment,
} from '../types.js';
import { getLastZulipMessageTimestamp } from '../db.js';
import { promises as fs } from 'fs';
import path from 'path';
export interface ZulipChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onTopicResolved?: (chatJid: string) => void;
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
  if (
    data &&
    (method === 'POST' || method === 'PATCH' || method === 'DELETE')
  ) {
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

/**
 * Normalize Zulip topic JIDs by stripping the ✔ prefix from resolved topics.
 * This ensures resolved and unresolved topics map to the same group.
 */
function normalizeZulipJid(chatJid: string): string {
  const parts = chatJid.split(':');
  if (parts.length >= 3 && parts[0] === 'zu') {
    const topic = parts.slice(2).join(':');
    const normalized = topic.replace(/^✔\s*/, '');
    return `zu:${parts[1]}:${normalized}`;
  }
  return chatJid;
}

export class ZulipChannel implements Channel {
  name = 'zulip';

  private opts: ZulipChannelOpts;
  private creds: ZulipCredentials;
  private uploadsPath: string | undefined;
  private connected = false;
  private abortController: AbortController | null = null;
  private myUserId: number | null = null;
  private botFullName: string | null = null;

  // Track last topic per stream for replies
  private lastTopicByStream = new Map<string, string>();

  constructor(
    creds: ZulipCredentials,
    opts: ZulipChannelOpts,
    uploadsPath?: string,
  ) {
    this.creds = creds;
    this.opts = opts;
    this.uploadsPath = uploadsPath;
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
      {
        email: this.creds.email,
        userId: this.myUserId,
        name: this.botFullName,
      },
      'Zulip bot connected',
    );
    console.log(`\n  Zulip bot: ${this.botFullName} (${this.creds.email})`);
    console.log(`  Site: ${this.creds.site}\n`);

    // Start long-poll event loop in the background
    this.pollLoop().catch((err) => {
      logger.error({ err: err.message }, 'Zulip poll loop crashed');
    });
  }

  /**
   * Get the timestamp of the last message we processed, for recovery
   */
  private getLastMessageTimestamp(): number {
    const lastTs = getLastZulipMessageTimestamp();
    if (lastTs !== null) {
      return lastTs;
    }
    // Default: start from 5 minutes ago to avoid fetching entire history
    return Math.floor((Date.now() - 5 * 60 * 1000) / 1000);
  }

  /**
   * Fetch and process missed messages since the given timestamp
   */
  private async catchUpMissedMessages(sinceTimestamp: number): Promise<void> {
    try {
      logger.info({ sinceTimestamp }, 'Catching up on missed Zulip messages');

      const result = await zulipApi(
        this.creds,
        `/messages?anchor=newest&num_before=1000&num_after=0&narrow=${encodeURIComponent(JSON.stringify([]))}`,
      );

      if (result.result !== 'success' || !result.messages) {
        logger.warn('Failed to fetch message history for catch-up');
        return;
      }

      // Filter messages since our last timestamp and not from ourselves
      const missedMessages = result.messages.filter(
        (msg: any) =>
          msg.timestamp > sinceTimestamp && msg.sender_id !== this.myUserId,
      );

      if (missedMessages.length === 0) {
        logger.info('No missed messages to catch up');
        return;
      }

      logger.info(
        { count: missedMessages.length },
        'Processing missed Zulip messages',
      );

      // Process messages in chronological order
      missedMessages.sort((a: any, b: any) => a.timestamp - b.timestamp);
      for (const msg of missedMessages) {
        await this.handleMessage(msg);
      }

      logger.info('Finished catching up on missed messages');
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error during message catch-up');
    }
  }

  /**
   * Backfill message history for a newly registered topic.
   * Fetches all messages from the topic and stores them in chronological order.
   */
  async backfillHistory(chatJid: string): Promise<void> {
    if (!this.connected) {
      logger.warn('Zulip not connected, cannot backfill topic history');
      return;
    }

    // Parse JID to extract stream ID and topic
    const parts = chatJid.split(':');
    if (parts.length < 3 || !parts[0].startsWith('zu')) {
      logger.warn({ chatJid }, 'Invalid Zulip topic JID for backfill');
      return;
    }

    const streamId = parts[1];
    const topic = parts.slice(2).join(':');

    try {
      logger.info({ chatJid, streamId, topic }, 'Backfilling topic history');

      // Fetch all messages from this topic
      const messages = await this.searchTopicMessages(streamId, topic, 1000);

      if (messages.length === 0) {
        logger.info({ chatJid }, 'No history to backfill');
        return;
      }

      logger.info(
        { chatJid, count: messages.length },
        'Processing backfilled messages',
      );

      // Process messages in chronological order (oldest first)
      messages.sort((a: any, b: any) => a.timestamp - b.timestamp);
      for (const msg of messages) {
        // Skip messages we might have already processed
        // handleMessage will deduplicate based on message ID
        await this.handleMessage(msg);
      }

      logger.info({ chatJid }, 'Finished backfilling topic history');
    } catch (err: any) {
      logger.error(
        { chatJid, err: err.message },
        'Error backfilling topic history',
      );
    }
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

    // Catch up on any messages that arrived while we were down
    const lastTs = this.getLastMessageTimestamp();
    await this.catchUpMissedMessages(lastTs);
    const POLL_TIMEOUT_MS = 90_000;
    let consecutiveErrors = 0;

    const backoff = async (errors: number) => {
      const ms = Math.min(5000 * Math.pow(2, errors - 1), 120_000);
      logger.info({ ms, errors }, 'Zulip backing off');
      await new Promise((r) => setTimeout(r, ms));
    };

    const reRegister = async (catchUp: boolean = false): Promise<boolean> => {
      if (catchUp) {
        // Fetch missed messages before re-registering
        const lastTs = this.getLastMessageTimestamp();
        await this.catchUpMissedMessages(lastTs);
      }

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
            // Catch up if we've had multiple errors (indicating a longer outage)
            const shouldCatchUp = consecutiveErrors >= 3;
            if (!(await reRegister(shouldCatchUp))) {
              await backoff(consecutiveErrors);
            } else {
              consecutiveErrors = 0; // Reset on successful re-registration
            }
          } else {
            logger.error({ msg: result.msg }, 'Zulip poll failed');

            // After sustained failures, assume queue is stale and try re-registering
            if (consecutiveErrors >= 10) {
              logger.warn(
                'Too many consecutive poll failures, attempting to re-register queue...',
              );
              const shouldCatchUp = true;
              if (!(await reRegister(shouldCatchUp))) {
                await backoff(consecutiveErrors);
              } else {
                consecutiveErrors = 0;
              }
            } else {
              await backoff(consecutiveErrors);
            }
          }
          continue;
        }

        if (consecutiveErrors > 0) {
          logger.info({ errors: consecutiveErrors }, 'Zulip poll recovered');
        }
        consecutiveErrors = 0;

        for (const event of result.events) {
          lastEventId = event.id;

          if (event.type === 'message') {
            await this.handleMessage(event.message);
          }
        }
      } catch (err: any) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          // Normal — long-poll timed out with no events
          continue;
        }
        if (err.retryAfterMs) {
          logger.warn({ retryAfterMs: err.retryAfterMs }, 'Zulip rate limited');
          await new Promise((r) => setTimeout(r, err.retryAfterMs));
          consecutiveErrors++;
          continue;
        }
        consecutiveErrors++;
        logger.error({ err: err.message }, 'Zulip poll error');

        // After sustained errors (e.g., Zulip restart returning HTML, network issues),
        // assume the event queue is stale and attempt to re-register
        if (consecutiveErrors >= 10) {
          logger.warn(
            'Too many consecutive poll errors, attempting to re-register queue...',
          );
          const shouldCatchUp = true; // Always catch up after prolonged failure
          if (await reRegister(shouldCatchUp)) {
            consecutiveErrors = 0; // Reset on successful re-registration
            continue; // Skip backoff and try polling immediately
          }
        }

        await backoff(consecutiveErrors);
      }
    }

    logger.info('Zulip poll loop exited');
  }

  /**
   * Extract attachment URLs from message content.
   * Zulip attachments appear as markdown links like [filename](/user_uploads/...)
   */
  private extractAttachmentUrls(
    content: string,
  ): Array<{ url: string; filename: string }> {
    const attachments: Array<{ url: string; filename: string }> = [];
    // Match markdown links with /user_uploads/ paths
    const regex = /\[([^\]]+)\]\((\/user_uploads\/[^)]+)\)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      attachments.push({
        filename: match[1],
        url: match[2],
      });
    }
    return attachments;
  }

  /**
   * Download an attachment from Zulip server to local filesystem,
   * or resolve its path if using direct mount.
   * Returns the Attachment object with local path.
   */
  private async downloadAttachment(
    url: string,
    filename: string,
  ): Promise<Attachment | null> {
    try {
      // If uploadsPath is configured, we're using direct mount.
      // Skip download and use the direct container path.
      // The URL path matches the container path exactly (e.g., /user_uploads/2/a1/abc/file.pdf)
      if (this.uploadsPath) {
        // Validate URL format
        if (!url.startsWith('/user_uploads/')) {
          logger.error({ url }, 'Invalid Zulip upload URL format');
          return null;
        }

        // In direct mount mode, the URL path IS the container path
        const containerPath = url;
        const fullUrl = new URL(url, this.creds.site).toString();

        logger.info(
          { url, containerPath, mode: 'direct-mount' },
          'Using direct-mounted Zulip upload',
        );

        return {
          filename,
          path: containerPath,
          url: fullUrl,
          // Size and mimeType unknown without fetching, but they're optional
        };
      }

      // Fallback: Download the file (default behavior)
      const fullUrl = new URL(url, this.creds.site).toString();
      const auth = Buffer.from(
        `${this.creds.email}:${this.creds.apiKey}`,
      ).toString('base64');

      const response = await fetch(fullUrl, {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      });

      if (!response.ok) {
        logger.error(
          { url, status: response.status },
          'Failed to download Zulip attachment',
        );
        return null;
      }

      // Ensure uploads directory exists (host path, will be mounted into container)
      const uploadsDir = path.join(process.cwd(), 'data', 'uploads');
      await fs.mkdir(uploadsDir, { recursive: true });

      // Generate safe filename
      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const timestamp = Date.now();
      const localFilename = `${timestamp}_${sanitizedFilename}`;
      const localPath = path.join(uploadsDir, localFilename);

      // Download file
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(localPath, buffer);

      logger.info(
        { url, localPath, size: buffer.length },
        'Downloaded Zulip attachment',
      );

      // Return the container path (where the agent will see the file)
      const containerPath = path.join('/user_uploads', localFilename);

      return {
        filename,
        path: containerPath,
        url: fullUrl,
        size: buffer.length,
        mimeType: response.headers.get('content-type') || undefined,
      };
    } catch (err: any) {
      logger.error({ url, err: err.message }, 'Error downloading attachment');
      return null;
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    // Skip our own messages
    if (msg.sender_id === this.myUserId) return;

    const isStream = msg.type === 'stream';
    const streamId = isStream ? String(msg.stream_id) : null;
    const topic = isStream ? msg.subject : undefined;
    // chatJid format: 'zu:streamId:topic' for topics, 'zu:streamId' for stream-level, 'zu:dm:userId' for DMs
    const rawChatJid = isStream
      ? topic
        ? `zu:${streamId}:${topic}`
        : `zu:${streamId}`
      : `zu:dm:${msg.sender_id}`;

    // Normalize JID to strip ✔ prefix from resolved topics
    const chatJid = normalizeZulipJid(rawChatJid);

    let content = stripHtml(msg.content);
    const timestamp = new Date(msg.timestamp * 1000).toISOString();
    const senderName = msg.sender_full_name || msg.sender_email || 'Unknown';
    const sender = String(msg.sender_id);
    const msgId = String(msg.id);

    // Detect topic resolution from Notification Bot
    if (
      senderName === 'Notification Bot' &&
      /has marked this topic as resolved/.test(content)
    ) {
      logger.info({ chatJid, topic }, 'Zulip topic marked as resolved');
      if (this.opts.onTopicResolved) {
        this.opts.onTopicResolved(chatJid);
      }
      return; // Don't deliver resolution notifications to the agent
    }

    // Track last topic per stream for replies
    if (isStream && topic && streamId) {
      this.lastTopicByStream.set(streamId, topic);
    }

    // Determine chat name
    const chatName = isStream ? msg.display_recipient || chatJid : senderName;

    // Translate Zulip @**BotName** mentions to trigger format.
    // Zulip uses @**Full Name** for mentions. We translate the bot's mention
    // to @ASSISTANT_NAME so TRIGGER_PATTERN can match.
    if (this.botFullName) {
      const zulipMention = `@**${this.botFullName}**`;
      if (content.includes(zulipMention) && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Extract and download attachments
    const attachmentUrls = this.extractAttachmentUrls(msg.content);
    const attachments: Attachment[] = [];
    for (const { url, filename } of attachmentUrls) {
      const attachment = await this.downloadAttachment(url, filename);
      if (attachment) {
        attachments.push(attachment);
      }
    }

    // Store chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'zulip', isStream);

    // Note: Auto-registration happens in orchestrator's onMessage callback
    // We always deliver messages, even from unregistered topics

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      attachments: attachments.length > 0 ? attachments : undefined,
      // Zulip topics are the thread level - don't pass thread_id (would cause nesting)
    });

    logger.info(
      { chatJid, chatName, topic, sender: senderName },
      'Zulip message stored',
    );
  }

  /**
   * Search for messages in a specific topic within a stream.
   * Returns full message objects matching the search.
   */
  async searchTopicMessages(
    streamId: string,
    topic: string,
    limit: number = 100,
  ): Promise<Array<any>> {
    if (!this.connected) {
      logger.warn('Zulip not connected');
      return [];
    }

    try {
      // Construct narrow filter for stream and topic
      const narrow = [
        { operator: 'channel', operand: parseInt(streamId, 10) },
        { operator: 'topic', operand: topic },
      ];

      const params = new URLSearchParams({
        narrow: JSON.stringify(narrow),
        num_before: String(limit),
        num_after: '0',
        anchor: 'newest',
      });
      const result = await zulipApi(
        this.creds,
        `/messages?${params.toString()}`,
        'GET',
      );

      if (result.result !== 'success') {
        logger.error(
          { streamId, topic, msg: result.msg },
          'Failed to search Zulip topic',
        );
        return [];
      }

      logger.info(
        { streamId, topic, count: result.messages?.length || 0 },
        'Searched Zulip topic',
      );

      return result.messages || [];
    } catch (err: any) {
      logger.error(
        { streamId, topic, err: err.message },
        'Error searching Zulip topic',
      );
      return [];
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn('Zulip not connected');
      return;
    }

    try {
      const isStream = jid.startsWith('zu:') && !jid.startsWith('zu:dm:');

      if (isStream) {
        // Parse JID: zu:{streamId} or zu:{streamId}:{topic}
        const parts = jid.split(':');
        const streamId = parts[1];
        const topic =
          parts.length > 2
            ? parts.slice(2).join(':')
            : this.lastTopicByStream.get(streamId) || 'chat';

        // Get stream name from stream ID
        const streamInfo = await zulipApi(this.creds, `/streams/${streamId}`);
        const streamName = streamInfo.stream?.name || streamId;

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

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) {
      logger.warn('Zulip not connected');
      return;
    }

    try {
      const op = isTyping ? 'start' : 'stop';
      const isStream = jid.startsWith('zu:') && !jid.startsWith('zu:dm:');

      if (isStream) {
        // Parse JID: zu:{streamId} or zu:{streamId}:{topic}
        const parts = jid.split(':');
        const streamId = parts[1];
        const topic =
          parts.length > 2
            ? parts.slice(2).join(':')
            : this.lastTopicByStream.get(streamId) || 'chat';

        await zulipApi(this.creds, '/typing', 'POST', {
          op,
          type: 'stream',
          stream_id: streamId,
          topic,
        });
      } else {
        // DM: zu:dm:{userId}
        const userId = jid.replace(/^zu:dm:/, '');

        await zulipApi(this.creds, '/typing', 'POST', {
          op,
          type: 'direct',
          to: JSON.stringify([parseInt(userId, 10)]),
        });
      }

      logger.debug(
        { jid, isTyping },
        `Zulip typing indicator ${isTyping ? 'started' : 'stopped'}`,
      );
    } catch (err: any) {
      logger.error(
        { jid, isTyping, err: err.message },
        'Failed to set Zulip typing indicator',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('zu:');
  }


  /**
   * Override trigger requirements for auto-register streams.
   * Topics in ZULIP_AUTO_REGISTER_STREAMS don't require trigger.
   */
  shouldRequireTrigger(jid: string): boolean {
    if (!jid.startsWith('zu:') || jid.startsWith('zu:dm:')) {
      return true; // DMs use default behavior
    }

    const parts = jid.split(':');
    if (parts.length < 2) return true;

    const streamId = parts[1];
    const { ZULIP_AUTO_REGISTER_STREAMS } = require('../config.js');
    return !ZULIP_AUTO_REGISTER_STREAMS.includes(streamId);
  }

  /**
   * Handle auto-registration for Zulip topics.
   * Auto-registers topics in configured streams or when mentioned in new topics.
   */
  handleAutoRegister(
    jid: string,
    message: import('../types.js').NewMessage,
    context: {
      registeredGroups: Record<string, import('../types.js').RegisteredGroup>;
      triggerPattern: RegExp;
      assistantName: string;
    },
  ): { shouldRegister: boolean; group?: import('../types.js').RegisteredGroup } | null {
    // Only handle Zulip topic JIDs
    if (!jid.startsWith('zu:') || jid.startsWith('zu:dm:')) {
      return null;
    }

    const parts = jid.split(':');
    if (parts.length < 3) return null; // Not a topic

    const streamId = parts[1];
    const topic = parts.slice(2).join(':');
    const { ZULIP_AUTO_REGISTER_STREAMS } = require('../config.js');

    // Check if this stream is configured for auto-registration
    const isAutoRegisterStream = ZULIP_AUTO_REGISTER_STREAMS.includes(streamId);

    let trigger: string;
    let requiresTrigger: boolean;
    let shouldAutoRegister: boolean;

    if (isAutoRegisterStream) {
      // Stream is configured to always auto-register without trigger
      trigger = `@${context.assistantName}`;
      requiresTrigger = false;
      shouldAutoRegister = true;
    } else {
      // Look for existing topics in the same stream to inherit settings
      const parentStreamJid = `zu:${streamId}`;
      let templateGroup = context.registeredGroups[parentStreamJid];

      if (!templateGroup) {
        const streamPrefix = `zu:${streamId}:`;
        for (const [existingJid, group] of Object.entries(context.registeredGroups)) {
          if (existingJid.startsWith(streamPrefix) && existingJid !== jid) {
            templateGroup = group;
            break;
          }
        }
      }

      // Auto-register if we found a template group OR if message contains trigger
      shouldAutoRegister =
        templateGroup !== undefined || context.triggerPattern.test(message.content);

      // Inherit settings from template group if it exists, otherwise use defaults
      trigger = templateGroup?.trigger ?? `@${context.assistantName}`;
      requiresTrigger = templateGroup?.requiresTrigger ?? true;
    }

    if (!shouldAutoRegister) {
      return { shouldRegister: false };
    }

    // Build folder name
    const streamName = `stream_${streamId}`;
    const sanitizedStream = streamName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    const sanitizedTopic = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const hash = jid.replace(/[^a-z0-9]+/g, '').substring(0, 12);
    const folderName = `zulip_${sanitizedStream}__${sanitizedTopic}_${hash}`.substring(
      0,
      64,
    );

    return {
      shouldRegister: true,
      group: {
        name: `${streamName} / ${topic}`,
        folder: folderName,
        trigger,
        added_at: new Date().toISOString(),
        requiresTrigger,
      },
    };
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
    'ZULIP_UPLOADS_PATH',
  ]);
  const email = process.env.ZULIP_BOT_EMAIL || envVars.ZULIP_BOT_EMAIL || '';
  const apiKey =
    process.env.ZULIP_BOT_API_KEY || envVars.ZULIP_BOT_API_KEY || '';
  const site = process.env.ZULIP_SITE || envVars.ZULIP_SITE || '';
  const uploadsPath =
    process.env.ZULIP_UPLOADS_PATH || envVars.ZULIP_UPLOADS_PATH;

  if (!email || !apiKey || !site) {
    logger.warn(
      'Zulip: credentials not set (ZULIP_BOT_EMAIL, ZULIP_BOT_API_KEY, ZULIP_SITE)',
    );
    return null;
  }

  return new ZulipChannel({ email, apiKey, site }, opts, uploadsPath);
});
