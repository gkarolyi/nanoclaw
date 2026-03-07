---
name: add-zulip
description: Add Zulip as a channel with topic-level threading and MCP tools for stream/topic search.
---

# Add Zulip Channel

This skill adds Zulip support to NanoClaw and enables topic-level threading. Each Zulip topic becomes its own conversation context.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `zulip` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

- Zulip organization URL (e.g., `https://chat.example.com`)
- Zulip bot/user email
- Zulip API key

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-zulip
```

This deterministically:
- Adds `src/channels/zulip.ts` and `src/channels/zulip.test.ts`
- Appends `import './zulip.js'` to `src/channels/index.ts`
- Extends core types/db/index routing to support topic threading
- Adds Zulip MCP tools for listing channels/topics and searching messages
- Updates `.env.example` with Zulip credentials
- Records the application in `.nanoclaw/state.yaml`

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass before proceeding.

## Phase 3: Setup

### Configure environment

Add to `.env`:

```bash
ZULIP_SITE=https://chat.example.com
ZULIP_EMAIL=bot@example.com
ZULIP_API_KEY=your-api-key
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Registration

Register the **stream** you want NanoClaw to listen to. Topics will auto-register on first message.

Stream JID format:

```
zulip:<stream-id>
```

Example:

```typescript
registerGroup("zulip:5", {
  name: "testing-channel",
  folder: "zulip_testing-channel",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

Topic groups are created automatically using the stream group as a template. Each topic gets its own folder and conversation history.

## Phase 5: Verify

### Test the connection

Send a message to a topic in the registered stream. The bot should respond within a few seconds, using only that topic's history as context.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

- Ensure `ZULIP_SITE`, `ZULIP_EMAIL`, and `ZULIP_API_KEY` are set in `.env` and synced to `data/env/env`.
- Ensure the bot/user is subscribed to the target stream.
- If messages are not delivered, check for event-queue errors in the logs.

## After Setup

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```
