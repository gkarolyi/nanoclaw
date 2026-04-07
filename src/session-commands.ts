import type { NewMessage } from './types.js';
import { logger } from './logger.js';
import { loadSenderAllowlist, isTriggerAllowed } from './sender-allowlist.js';

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command (e.g., '/compact') or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  const trimmed = content.trim();

  // Standalone commands - work without trigger, must be exact match
  if (trimmed === '/register') return '/register';
  if (trimmed === '/unregister') return '/unregister';
  if (trimmed === '/backfill') return '/backfill';
  if (trimmed === '/stop') return '/stop';
  if (trimmed === '/commands') return '/commands';
  if (trimmed === '/help') return '/commands'; // Alias for /commands

  // Agent commands - require trigger, passed to agent
  let text = trimmed;
  // Strip all leading trigger patterns (handles duplicate mentions)
  while (triggerPattern.test(text)) {
    text = text.replace(triggerPattern, '').trim();
  }
  if (text === '/compact') return '/compact';

  return null;
}

/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
  /** Chat JID for the current group. */
  chatJid: string;
  /** Trigger backfill for Zulip topics. */
  triggerBackfill?: () => Promise<{ success: boolean; message: string }>;
  /** Register the current topic to receive all messages without trigger. */
  registerTopic?: () => Promise<{ success: boolean; message: string }>;
  /** Unregister the current topic from receiving all messages without trigger. */
  unregisterTopic?: () => Promise<{ success: boolean; message: string }>;
  /** Interrupt the currently running agent (simulates Escape). */
  stopAgent?: () => void;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;
  if (!command || !cmdMsg) return { handled: false };

  // Authorization: main group (any sender) OR sender is authorized (from_me or allowlisted)
  // Session commands don't require a trigger — they ARE the trigger
  const isAuthorized =
    isMainGroup ||
    cmdMsg.is_from_me ||
    // For non-main groups that require triggers, check if sender is allowed
    (() => {
      const allowlistCfg = loadSenderAllowlist();
      return isTriggerAllowed(deps.chatJid, cmdMsg.sender, allowlistCfg);
    })();

  if (!isAuthorized) {
    // DENIED: silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // Handle /backfill specially - doesn't need agent processing
  if (command === '/backfill') {
    logger.info({ group: groupName }, 'Backfill command');
    await deps.setTyping(true);

    if (!deps.triggerBackfill) {
      await deps.sendMessage(
        'Backfill is not supported for this channel type.',
      );
      deps.advanceCursor(cmdMsg.timestamp);
      await deps.setTyping(false);
      return { handled: true, success: true };
    }

    const result = await deps.triggerBackfill();
    await deps.sendMessage(result.message);
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.setTyping(false);
    return { handled: true, success: result.success };
  }

  // Handle /register command
  if (command === '/register') {
    logger.info({ group: groupName }, 'Register topic command');
    await deps.setTyping(true);

    if (!deps.registerTopic) {
      await deps.sendMessage(
        'Topic registration is not supported for this channel type.',
      );
      deps.advanceCursor(cmdMsg.timestamp);
      await deps.setTyping(false);
      return { handled: true, success: true };
    }

    const result = await deps.registerTopic();
    await deps.sendMessage(result.message);
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.setTyping(false);
    return { handled: true, success: result.success };
  }

  // Handle /unregister command
  if (command === '/unregister') {
    logger.info({ group: groupName }, 'Unregister topic command');
    await deps.setTyping(true);

    if (!deps.unregisterTopic) {
      await deps.sendMessage(
        'Topic unregistration is not supported for this channel type.',
      );
      deps.advanceCursor(cmdMsg.timestamp);
      await deps.setTyping(false);
      return { handled: true, success: true };
    }

    const result = await deps.unregisterTopic();
    await deps.sendMessage(result.message);
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.setTyping(false);
    return { handled: true, success: result.success };
  }

  // Handle /stop command
  if (command === '/stop') {
    logger.info({ group: groupName }, 'Stop command');

    deps.stopAgent?.();
    await deps.sendMessage('Stopped.');
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // Handle /commands (and /help) command
  if (command === '/commands') {
    logger.info({ group: groupName }, 'Commands help requested');
    await deps.setTyping(true);

    const commandsHelp = `**Available Session Commands:**

• **/register** - Register this topic to receive all messages without requiring @mention
  Example: \`/register\`

• **/unregister** - Unregister this topic (return to requiring @mention)
  Example: \`/unregister\`

• **/backfill** - Load previous messages from this topic into conversation context
  Example: \`/backfill\`

• **/stop** - Interrupt the currently running agent (like pressing Escape)
  Example: \`/stop\`

• **/compact** - Compress conversation context to save memory (requires @mention)
  Example: \`@AssistantName /compact\`

• **/commands** or **/help** - Show this help message
  Example: \`/commands\`

Session commands are meta-commands about the conversation itself.`;

    await deps.sendMessage(commandsHelp);
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.setTyping(false);
    return { handled: true, success: true };
  }

  // AUTHORIZED: process pre-compact messages first, then run the command
  logger.info({ group: groupName, command }, 'Session command');

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs = missedMessages.slice(0, cmdIndex);

  // Send pre-compact messages to the agent so they're in the session context.
  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCompactMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past pre-compact messages, leave command pending.
        deps.advanceCursor(preCompactMsgs[preCompactMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
