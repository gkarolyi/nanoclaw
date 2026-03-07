---
name: add-zulip
description: Add Zulip as a channel. Uses REST API with long-polling for real-time events. No external npm dependencies required.
---

# Add Zulip Channel

This skill adds Zulip support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `zulip` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Zulip bot configured, or do you need to create one?

If they have credentials, collect them now. If not, we'll create one in Phase 3.

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
- Adds `src/channels/zulip.ts` (ZulipChannel class with self-registration via `registerChannel`)
- Adds `src/channels/zulip.test.ts` (unit tests)
- Appends `import './zulip.js'` to the channel barrel file `src/channels/index.ts`
- Updates `.env.example` with `ZULIP_BOT_EMAIL`, `ZULIP_BOT_API_KEY`, `ZULIP_SITE`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Create Zulip Bot (if needed)

If the user doesn't have bot credentials, tell them:

> I need you to create a Zulip bot:
>
> 1. Go to your Zulip organization settings
> 2. Navigate to **Organization** > **Bots** (or go to `/#organization/bot-list-admin`)
> 3. Click **Add a new bot**
> 4. Choose **Generic bot** type
> 5. Set the bot name (e.g., "Andy") and email prefix
> 6. Copy the **API key** after creation
>
> You'll need three values:
> - **Bot email**: e.g., `andy-bot@your-org.zulipchat.com`
> - **API key**: shown after bot creation
> - **Site URL**: e.g., `https://your-org.zulipchat.com`

Wait for the user to provide the credentials.

### Configure environment

Add to `.env`:

```bash
ZULIP_BOT_EMAIL=<bot-email>
ZULIP_BOT_API_KEY=<api-key>
ZULIP_SITE=<site-url>
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Stream ID

Tell the user:

> To register a Zulip stream, I need the stream ID. You can find it by:
>
> 1. Open the stream in Zulip
> 2. Click the stream name in the sidebar
> 3. Look at the URL — it contains the stream ID (e.g., `#narrow/stream/42-general` means stream ID is `42`)
>
> For DMs, use the user's numeric ID (visible in their profile URL).

Wait for the user to provide the stream ID.

The JID format is:
- Streams: `zu:{stream_id}` (e.g., `zu:42`)
- DMs: `zu:dm:{user_id}` (e.g., `zu:dm:99`)

### Register the chat

For a main chat (responds to all messages):

```typescript
registerGroup("zu:<stream-id>", {
  name: "<stream-name>",
  folder: "zulip_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("zu:<stream-id>", {
  name: "<stream-name>",
  folder: "zulip_<stream-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Zulip stream:
> - For main chat: Any message works
> - For non-main: `@Andy hello` or use `@**BotName**` mention
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `ZULIP_BOT_EMAIL`, `ZULIP_BOT_API_KEY`, `ZULIP_SITE` are set in `.env` AND synced to `data/env/env`
2. Chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'zu:%'"`
3. For non-main chats: message includes trigger pattern (use `@**BotName**` in Zulip)
4. Service is running: `systemctl --user status nanoclaw` (Linux) or `launchctl list | grep nanoclaw` (macOS)

### Bot only responds to @mentions

This is expected for non-main groups (requiresTrigger=true). Either:
- Register as main (`isMain: true`)
- Use `@**BotName**` to trigger

### Topic tracking

The bot replies to the same topic that last triggered it in each stream. If you change topics mid-conversation, the bot follows. Default topic is "chat" if none tracked yet.

### API authentication errors

Verify credentials:
```bash
curl -s -u "BOT_EMAIL:API_KEY" https://YOUR-SITE/api/v1/users/me
```

## Features

### File Attachments

The Zulip channel supports two modes for handling file attachments:

#### Mode 1: Download (Default)

When a user sends a file:

1. The attachment is detected from the Zulip message content (markdown links to `/user_uploads/...`)
2. The file is downloaded from the Zulip server using authenticated requests
3. Files are stored in `data/uploads/` on the host and mounted to `/user_uploads/` in the container
4. The agent receives the message with an `attachments` array containing:
   - `filename`: Original filename
   - `path`: Container filesystem path (accessible to the agent)
   - `url`: Original Zulip URL
   - `size`: File size in bytes
   - `mimeType`: Content type (if available)

#### Mode 2: Direct Mount (Zero-Copy)

If Zulip is running via Docker on the same host, you can mount Zulip's uploads directory directly instead of downloading files. This provides:

- **Zero-copy access** - No network download overhead
- **Real-time availability** - Files accessible immediately when uploaded
- **Reduced disk usage** - Files stored once, not duplicated
- **Path alignment** - Container paths match Zulip's URL structure exactly

To enable direct mount mode:

1. Find your Zulip uploads path:
   ```bash
   # For homelab compose setup (../compose/zulip.yml), volume is homelab_zulip_data
   docker volume inspect homelab_zulip_data --format '{{ .Mountpoint }}'
   # Then append /uploads to the result
   
   # Or for other setups, find the Zulip volume:
   docker volume ls | grep zulip
   docker volume inspect <volume-name> --format '{{ .Mountpoint }}'
   # The uploads are at: <mountpoint>/uploads
   ```

2. Add to `.env`:
   ```bash
   # For homelab compose setup:
   ZULIP_UPLOADS_PATH=/var/lib/docker/volumes/homelab_zulip_data/_data/uploads
   ```

3. Sync to container environment:
   ```bash
   mkdir -p data/env && cp .env data/env/env
   ```

4. Rebuild and restart NanoClaw:
   ```bash
   npm run build
   # Linux: systemctl --user restart nanoclaw
   # macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```

In direct mount mode, files are accessed directly from Zulip's storage without downloading. The container path matches the URL structure exactly:

```
Zulip URL:      /user_uploads/2/a1/abc123/filename.pdf
Container path: /user_uploads/2/a1/abc123/filename.pdf
```

This makes it easy for agents to:
- Understand file locations intuitively
- Construct Zulip URLs from file paths
- Link to files in responses

### Topic Search

The Zulip channel provides a `searchTopicMessages()` method to retrieve messages from a specific topic within a stream:

```typescript
const messages = await zulipChannel.searchTopicMessages(
  streamId,  // e.g., '42'
  topic,     // e.g., 'project-updates'
  limit,     // optional, defaults to 100
);
```

This returns an array of message objects from the specified topic, enabling the agent to:
- Review conversation history
- Search for specific information within topics
- Analyze topic-specific discussions


## After Setup

If running `npm run dev` while the service is active:
```bash
# Linux:
systemctl --user stop nanoclaw
npm run dev
# When done testing:
systemctl --user start nanoclaw
# macOS:
# launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
# npm run dev
# launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Removal

To remove Zulip integration:

1. Delete `src/channels/zulip.ts` and `src/channels/zulip.test.ts`
2. Remove `import './zulip.js'` from `src/channels/index.ts`
3. Remove `ZULIP_BOT_EMAIL`, `ZULIP_BOT_API_KEY`, `ZULIP_SITE` from `.env`
4. Remove Zulip registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'zu:%'"`
5. Rebuild: `npm run build && systemctl --user restart nanoclaw` (Linux) or `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
