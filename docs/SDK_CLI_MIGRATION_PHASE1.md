# Phase 1: SDK → CLI Migration Implementation Plan

**Objective:** Replace `@anthropic-ai/claude-agent-sdk` with Claude Code CLI binary in the container agent-runner, while maintaining complete behavioral compatibility with existing NanoClaw infrastructure.

**Strategy:** Drop-in adapter pattern that isolates all SDK→CLI translation in new backend modules, leaving `index.ts` structurally identical to upstream for clean future merges.

---

## 1. Pre-Migration Verification

### 1.1 Current State Assessment

**Required checks before starting:**

1. **Verify Claude CLI binary availability in container**
   - Container image already installs `@anthropic-ai/claude-code` globally (Dockerfile:34)
   - Binary path: `/usr/local/bin/claude` (from npm global install)
   - **Action:** Build current container and verify CLI binary exists and is executable
   - **Test:** `docker run --rm nanoclaw:latest which claude`
   - **Expected:** `/usr/local/bin/claude`

2. **Document current SDK integration points**
   - Import location: `container/agent-runner/src/index.ts:19`
   - Exported types used: `query`, `HookCallback`, `PreCompactHookInput`
   - No other files in agent-runner import the SDK directly
   - **Verification:** `grep -r '@anthropic-ai/claude-agent-sdk' container/agent-runner/src/`

3. **Identify output contract**
   - Container-runner.ts expects output wrapped in `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` markers
   - JSON payload: `{ status, result, newSessionId?, error? }`
   - Multiple output pairs may be emitted (agent teams/swarms)
   - **Critical:** Markers are parsed as they stream (container-runner.ts:386-413), not buffered until completion
   - **Critical:** `newSessionId` is extracted from output (container-runner.ts:397-398) and must match the session ID format from `query()`

4. **Map session continuity mechanism**
   - Current: SDK `query()` accepts `options.resume: string` with session ID
   - Current: SDK emits session ID in `{ type: 'system', subtype: 'init', session_id: '...' }` message
   - Container-runner stores this as `newSessionId` and passes it back on next invocation
   - **Critical:** CLI must preserve session ID format and accept `--resume <session-id>`

### 1.2 Baseline Test

**Before making any changes:**

1. **Capture current behavior**
   ```bash
   # Build current container
   ./container/build.sh
   
   # Send test message to a registered group
   # Via WhatsApp/Telegram/Slack/Discord/whatever channel is active
   # Message: "Hello, test message before migration"
   
   # Verify:
   # - Agent responds correctly
   # - Session ID appears in logs
   # - Follow-up message in same session works
   # - Output appears in group chat
   ```

2. **Document session ID format**
   - Check `data/sessions/<group-folder>/.claude/` directory
   - List session directories, note naming pattern
   - **Example expected format:** UUID v4 or timestamp-based ID
   - **Save:** `ls -la data/sessions/main/.claude/ > pre-migration-sessions.txt`

3. **Archive current logs**
   ```bash
   # Capture current container runtime behavior
   journalctl --user -u nanoclaw -n 1000 > pre-migration-nanoclaw.log
   
   # Or if running via npm run dev:
   # Save last successful agent invocation output
   ```

---

## 2. File Integration Plan

### 2.1 New Files to Add (from PR #1266)

**Source branch:** `pr-1266` (already fetched locally)

#### File 1: `container/agent-runner/src/claude-backend.ts`

**Purpose:** Drop-in replacement for `@anthropic-ai/claude-agent-sdk`. Spawns Claude CLI binary instead of calling SDK directly.

**Key implementation details:**
- Exports SDK-compatible types: `HookCallback`, `PreCompactHookInput`, `QueryMessage`
- Exports `query()` function with identical signature to SDK
- Internally:
  - Consumes `prompt: AsyncIterable<SDKUserMessage>` in background
  - Queues follow-up messages as separate `--resume` invocations (not mid-turn injection)
  - Spawns `claude` CLI binary with `--output-format stream-json`
  - Parses NDJSON output stream via `parseStreamJson()`
  - Propagates SIGTERM to child CLI process for graceful shutdown
  - Tracks session ID from CLI's `{ type: 'system', subtype: 'init', session_id }` message

**Integration:**
```typescript
// Before (index.ts:19):
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

// After (index.ts:19):
import { query, HookCallback, PreCompactHookInput } from './claude-backend.js';
```

**Critical differences from SDK:**
- Follow-up messages pushed during CLI execution are **queued**, not injected mid-turn
  - SDK: Accepts messages into active query() stream, appears in same conversation turn
  - CLI: Each message becomes a new `claude --resume <session-id>` invocation after current CLI process exits
  - **Impact:** Brief gap between CLI process completion and next invocation start
  - **Mitigation:** Semantically equivalent for chat use cases; actually better for long coding tasks (clean process boundaries)

**Validation after integration:**
- TypeScript compilation must pass (no type errors)
- `query()` function signature must match SDK exactly
- All SDK message types cast in index.ts must have compatible shape

#### File 2: `container/agent-runner/src/cli-utils.ts`

**Purpose:** Low-level utilities for CLI interaction. No dependencies on SDK or index.ts internals.

**Exports:**
- `buildCliArgs(opts)` — Converts SDK-style options to CLI arguments
  - Maps tool names: SDK-only tools (`Task`, `TeamCreate`, etc.) → CLI `Agent` tool
  - Builds `--allowedTools`, `--mcp-config`, `--resume`, `--append-system-prompt`, etc.
- `parseStreamJson(child, onMessage)` — Parses NDJSON from CLI stdout
  - Handles partial lines (buffering)
  - Calls `onMessage(msg)` for each complete JSON line
  - Returns Promise<exitCode>
- `writeMcpConfig(mcpServers)` — Writes MCP config JSON to `/tmp/mcp-config.json`
- `writeHooksSettings(scriptPath)` — Writes CLI hooks config to `~/.claude/settings.json`
- `AsyncChannel<T>` — Async iterable for callback→stream conversion (used by claude-backend)

**Key implementation notes:**
- Tool mapping is critical:
  - SDK tools `Task`, `TaskOutput`, `TaskStop` don't exist in CLI
  - SDK tools `TeamCreate`, `TeamDelete`, `SendMessage` don't exist in CLI
  - CLI equivalent: `Agent` tool (spawns subagent sessions)
  - **Validation:** If SDK allows `['Task', 'Bash', 'Read']`, CLI must get `['Agent', 'Bash', 'Read']`

**Integration:**
- Imported only by `claude-backend.ts`
- No changes needed in `index.ts`

#### File 3: `container/agent-runner/src/precompact-hook.ts`

**Purpose:** Standalone script for CLI PreCompact hook. Archives conversation transcripts before context compaction.

**Behavior:**
- CLI invokes as external command: `node precompact-hook.js`
- Reads `PreCompactInput` JSON from stdin
- Archives transcript to `/workspace/group/conversations/<date>-<summary>.md`
- Reads session summary from `.claude/sessions-index.json` (if exists)
- Outputs `{ continue: true }` to stdout, exits 0 (success)
- On error: outputs `{ continue: false }`, exits 2 (blocks compaction)

**Critical differences from SDK hook:**
- SDK hook: in-process callback, receives `PreCompactHookInput`, returns `Promise<object>`
- CLI hook: external process, stdin/stdout JSON, exit code signals success/failure
- **Translation handled by:** `claude-backend.ts` calls `writeHooksSettings()` which configures CLI to invoke this script

**Environment variable:**
- `NANOCLAW_ASSISTANT_NAME` — passed by index.ts (modified line in PR)
- Used for formatting archived conversation markdown

**Validation:**
- Must be executable in container (compiled to JS, invoked via `node`)
- Must create `/workspace/group/conversations/` directory
- Must handle missing transcript gracefully (compaction during initialization)

#### File 4: Test files (optional for Phase 1, required before production)

**Added by PR:**
- `container/agent-runner/src/cli-utils.test.ts` — Tests for `buildCliArgs`, `mapAllowedTools`, etc.
- `container/agent-runner/src/precompact-hook.test.ts` — Tests for transcript parsing, archiving logic

**Phase 1 scope:**
- Copy test files but mark as **optional** for initial deployment
- Run tests locally before Phase 1 deployment: `npm test` in `container/agent-runner/`
- **Acceptance:** Tests pass (vitest exit 0)
- **Blocker:** If tests fail, investigate before deploying

---

### 2.2 Modified Files (from PR #1266)

#### Modification 1: `container/agent-runner/src/index.ts`

**Changes:**
1. Line 19: Import from `./claude-backend.js` instead of SDK
2. Lines 490-492: Pass `NANOCLAW_ASSISTANT_NAME` env var for precompact hook

**Diff:**
```diff
-import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
+import { query, HookCallback, PreCompactHookInput } from './claude-backend.js';

   const sdkEnv: Record<string, string | undefined> = { ...process.env };

+  // Pass assistant name via env so the standalone precompact-hook script can use it
+  if (containerInput.assistantName) {
+    sdkEnv.NANOCLAW_ASSISTANT_NAME = containerInput.assistantName;
+  }
+
   const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

**Validation:**
- TypeScript build must pass (types must match)
- No functional changes to `index.ts` control flow
- MessageStream class stays (will be removed in Phase 2, vestigial in Phase 1)
- IPC polling logic stays (will be simplified in Phase 2)

**Critical:** This is a **one-line functional change** plus three lines of env setup. Everything else in index.ts is untouched. This is by design — keeps upstream merges clean.

#### Modification 2: `container/agent-runner/package.json`

**Changes:**
1. **Remove dependency:** `@anthropic-ai/claude-agent-sdk`
2. **Add devDependency:** `vitest` (for testing)
3. **Add scripts:** `test`, `test:watch`

**Diff:**
```diff
   "dependencies": {
-    "@anthropic-ai/claude-agent-sdk": "^0.2.76",
     "@modelcontextprotocol/sdk": "^1.12.1",
     "cron-parser": "^5.0.0",
     "zod": "^4.0.0"
   },
   "devDependencies": {
     "@types/node": "^22.10.7",
-    "typescript": "^5.7.3"
+    "typescript": "^5.7.3",
+    "vitest": "^4.1.0"
   }
```

**Validation:**
- After change, run `npm install` in `container/agent-runner/`
- Verify SDK is removed from `node_modules/`
- Verify `vitest` is installed in `devDependencies`

**Lock file:**
- PR includes updated `package-lock.json`
- Must regenerate or cherry-pick from PR to avoid npm install conflicts

#### Modification 3: `container/Dockerfile`

**Changes:**
1. Line 2: Update comment (SDK → CLI)
2. Line 58: Add `exec` to entrypoint for clean process management

**Diff:**
```diff
-# Runs Claude Agent SDK in isolated Linux VM with browser automation
+# Runs Claude Code CLI in isolated Linux VM with browser automation

-RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh
+RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nexec node /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh
```

**Rationale for `exec`:**
- Without `exec`: bash PID 1, node is child process
- With `exec`: node replaces bash, becomes PID 1
- **Benefit:** SIGTERM sent to container goes directly to node process
- **Benefit:** Node's SIGTERM handler in `claude-backend.ts` can propagate to `claude` CLI child
- **Critical:** Enables graceful shutdown of CLI processes during container stop

**Validation:**
- Rebuild container image
- Check running container: `docker exec <container> ps aux`
- PID 1 should be `node /tmp/dist/index.js`, not `bash`

#### Modification 4: `CLAUDE.md` (documentation only)

**Changes:** Added note about clearing per-group source copies after migration.

**Relevance to Phase 1:**
- Container copies agent-runner source to `/data/sessions/<group>/agent-runner-src/` for per-group customization
- After migration, these copies still reference the SDK
- **Action:** Delete all `/data/sessions/*/agent-runner-src/` directories to force recompile from new source

**Command:**
```bash
# After deploying new container image
rm -rf data/sessions/*/agent-runner-src/
# Next container run will copy fresh source (with CLI backend)
```

---

## 3. Integration Procedure

### 3.1 Preparation

**Before touching code:**

1. **Create migration branch**
   ```bash
   git checkout -b sdk-cli-migration-phase1
   git fetch upstream pull/1266/head:pr-1266  # Already done
   ```

2. **Verify PR branch integrity**
   ```bash
   git checkout pr-1266
   cd container/agent-runner
   npm install
   npm run build
   npm test
   cd ../..
   git checkout sdk-cli-migration-phase1
   ```
   **Acceptance:** Build and tests pass on PR branch

3. **Stop running NanoClaw instance**
   ```bash
   systemctl --user stop nanoclaw
   # Or kill `npm run dev` process
   ```

### 3.2 File Cherry-Pick Strategy

**Option A: Manual file copy (safer, more control)**

```bash
# Copy new files
git checkout pr-1266 -- container/agent-runner/src/claude-backend.ts
git checkout pr-1266 -- container/agent-runner/src/cli-utils.ts
git checkout pr-1266 -- container/agent-runner/src/precompact-hook.ts
git checkout pr-1266 -- container/agent-runner/src/cli-utils.test.ts
git checkout pr-1266 -- container/agent-runner/src/precompact-hook.test.ts

# Apply modifications manually to avoid merge conflicts
# (Safer than git checkout for files that might have local changes)
```

**Option B: Cherry-pick PR commits (faster, riskier)**

```bash
# Get PR commit range
git log upstream/main..pr-1266 --oneline

# Cherry-pick each commit
git cherry-pick <commit-hash-1>
git cherry-pick <commit-hash-2>
# ... resolve conflicts if any
```

**Recommendation:** Use Option A for Phase 1 to minimize risk and maintain visibility into each change.

### 3.3 Step-by-Step Integration

#### Step 1: Add new backend files

```bash
# From sdk-cli-migration-phase1 branch
git checkout pr-1266 -- container/agent-runner/src/claude-backend.ts
git checkout pr-1266 -- container/agent-runner/src/cli-utils.ts
git checkout pr-1266 -- container/agent-runner/src/precompact-hook.ts
git add container/agent-runner/src/claude-backend.ts \
        container/agent-runner/src/cli-utils.ts \
        container/agent-runner/src/precompact-hook.ts
git commit -m "Add CLI backend adapter files"
```

**Validation:**
- Files exist in `container/agent-runner/src/`
- No TypeScript errors yet (index.ts still imports SDK, these files are orphaned)

#### Step 2: Add test files

```bash
git checkout pr-1266 -- container/agent-runner/src/cli-utils.test.ts
git checkout pr-1266 -- container/agent-runner/src/precompact-hook.test.ts
git add container/agent-runner/src/*.test.ts
git commit -m "Add CLI backend tests"
```

#### Step 3: Update package.json

**Manual edit required** (don't blindly cherry-pick — local customizations may exist)

```bash
# Edit container/agent-runner/package.json:
# 1. Remove "@anthropic-ai/claude-agent-sdk" from dependencies
# 2. Add "vitest": "^4.1.0" to devDependencies
# 3. Add test scripts if missing

# Verify diff before committing
git diff container/agent-runner/package.json

# Commit
git add container/agent-runner/package.json
git commit -m "Remove SDK dependency, add vitest"
```

**Then update lock file:**

```bash
cd container/agent-runner
npm install  # Regenerates package-lock.json
cd ../..
git add container/agent-runner/package-lock.json
git commit -m "Update package-lock after removing SDK"
```

**Validation:**
```bash
# SDK must be gone
! grep -r 'claude-agent-sdk' container/agent-runner/node_modules/
echo $?  # Should be 0 (grep found nothing)

# Vitest must be present
test -f container/agent-runner/node_modules/.bin/vitest
echo $?  # Should be 0 (file exists)
```

#### Step 4: Modify index.ts

**Edit `container/agent-runner/src/index.ts`:**

Line 19:
```diff
-import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
+import { query, HookCallback, PreCompactHookInput } from './claude-backend.js';
```

After line ~489 (in `async function main()`, after `const sdkEnv = ...`):
```diff
   const sdkEnv: Record<string, string | undefined> = { ...process.env };

+  // Pass assistant name via env so the standalone precompact-hook script can use it
+  if (containerInput.assistantName) {
+    sdkEnv.NANOCLAW_ASSISTANT_NAME = containerInput.assistantName;
+  }
+
   const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

**Commit:**
```bash
git add container/agent-runner/src/index.ts
git commit -m "Switch index.ts to use CLI backend"
```

**Validation:**
```bash
cd container/agent-runner
npm run build
echo $?  # Must be 0 (build successful)
```

**Critical check:**
- TypeScript compilation passes
- No import errors
- No type mismatches
- `MessageStream` class is still present (not removed in Phase 1)
- IPC polling logic is still present

#### Step 5: Update Dockerfile

**Edit `container/Dockerfile`:**

Line 2:
```diff
-# Runs Claude Agent SDK in isolated Linux VM with browser automation
+# Runs Claude Code CLI in isolated Linux VM with browser automation
```

Line 58 (entrypoint RUN command):
```diff
-RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh
+RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nexec node /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh
```

**Commit:**
```bash
git add container/Dockerfile
git commit -m "Update Dockerfile: use exec for clean process management"
```

#### Step 6: Clear per-group agent-runner source copies

**Critical:** Per-group customization copies must be deleted to force recompile.

```bash
# Backup existing copies (optional, for rollback)
mkdir -p migration-backup
cp -r data/sessions/*/agent-runner-src migration-backup/ 2>/dev/null || true

# Delete all per-group source copies
rm -rf data/sessions/*/agent-runner-src/

# Commit as documentation
git add .  # Nothing to add (data/ is gitignored)
git commit --allow-empty -m "Cleared per-group agent-runner source copies"
```

**Rationale:**
- Container mounts `/data/sessions/<group>/agent-runner-src/` → `/app/src/`
- If old SDK-based source exists, container will compile and run **old code**
- Deleting forces container to copy fresh source from `container/agent-runner/src/`
- See `container-runner.ts:211-230` for copy logic

---

## 4. Testing Protocol

### 4.1 Unit Tests

**Run before building container:**

```bash
cd container/agent-runner
npm test
```

**Expected:**
- All tests pass
- `cli-utils.test.ts`: Tests CLI arg building, tool mapping
- `precompact-hook.test.ts`: Tests transcript parsing, markdown formatting

**If tests fail:**
- Review test output
- Fix issues before proceeding to container build
- **Do not deploy** with failing tests

### 4.2 Container Build Test

```bash
./container/build.sh
```

**Expected:**
- Build completes without errors
- Image tagged as `nanoclaw:latest`
- Claude CLI binary exists in image

**Validation:**
```bash
docker run --rm nanoclaw:latest which claude
# Expected: /usr/local/bin/claude

docker run --rm nanoclaw:latest claude --version
# Expected: claude X.Y.Z (some version number)

docker run --rm nanoclaw:latest ls -la /app/src/
# Expected: claude-backend.js, cli-utils.js, precompact-hook.js, index.js
```

### 4.3 Integration Test — Single Message

**Test 1: Basic invocation**

```bash
# Start NanoClaw
npm run dev
# Or: systemctl --user start nanoclaw

# Send test message to main group
# Via your registered channel (WhatsApp/Telegram/etc)
# Message: "Hello, this is a test after CLI migration."

# Observe logs:
# - Container spawns
# - CLI process starts
# - Output markers appear in stdout
# - Session ID is captured
# - Response appears in channel
```

**Expected behavior:**
- Agent responds normally
- No errors in logs
- Output appears in channel

**Success criteria:**
- Agent responds with relevant content
- Logs show `Session initialized: <session-id>` (from index.ts:442)
- No "Failed to parse streamed output chunk" warnings

**If it fails:**
- Check container logs: `docker logs <container-name>`
- Check CLI stderr output in NanoClaw logs
- Verify Claude CLI binary works: `docker exec <container> claude --version`

**Test 2: Session continuity**

```bash
# Send follow-up message to same group
# Message: "What did I just ask you?"

# Expected:
# - CLI invoked with --resume <session-id>
# - Agent remembers previous message
# - Responds with context from first message
```

**Success criteria:**
- Agent correctly references prior conversation
- Session ID in logs matches first invocation
- No session reset (agent doesn't say "I don't have prior context")

**If it fails:**
- Check session ID format: `ls -la data/sessions/<group>/.claude/`
- Verify `--resume` flag in CLI invocation (should appear in logs)
- Check container-runner.ts:397 — is `newSessionId` being captured?

**Test 3: PreCompact hook**

```bash
# Trigger context compaction (long conversation or explicit compact)
# Either:
# 1. Send many messages until context limit approached
# 2. Or manually trigger (if session command exists)

# Expected:
# - Precompact hook executes
# - Conversation archived to /workspace/group/conversations/
# - Compaction proceeds (agent continues functioning)
```

**Success criteria:**
- Archive file appears: `data/groups/<group>/conversations/<date>-<name>.md`
- File contains conversation transcript in markdown format
- Agent continues responding after compaction

**If it fails:**
- Check hook stderr in CLI output
- Verify precompact-hook.js is compiled: `docker exec <container> ls -la /tmp/dist/`
- Verify settings.json hook config: `cat data/sessions/<group>/.claude/settings.json`

### 4.4 Integration Test — Multi-Message Session

**Test scenario: Coding task with follow-ups**

```bash
# Message 1: "Create a TypeScript function that reverses a string."
# Expected: Agent writes code

# Message 2: "Add unit tests for that function."
# Expected: Agent adds tests, remembers prior code

# Message 3: "Make it handle Unicode properly."
# Expected: Agent updates code, maintains session context
```

**Success criteria:**
- All three messages handled correctly
- Session ID consistent across all three
- Agent maintains context (doesn't re-create function from scratch in message 2-3)

### 4.5 Integration Test — IPC Follow-Up Messages

**Test scenario: Container receives follow-up via IPC while CLI is running**

**Setup:**
```bash
# In one terminal: monitor IPC directory
watch -n 1 'ls -la data/groups/main/ipc/input/'

# In another terminal: send message to trigger agent
# Message: "Count to 10 slowly, one number per line."
```

**While agent is responding:**
```bash
# Manually write IPC message
echo '{"type":"message","text":"Stop! Change to counting backwards from 10."}' > \
  data/groups/main/ipc/input/$(date +%s%N).json
```

**Expected behavior (Phase 1):**
- First CLI process completes (counts to 10)
- Second CLI process starts with `--resume` (receives "count backwards" message)
- Agent responds to second message in same session

**Observed behavior difference from SDK:**
- SDK: Would inject message mid-turn, agent might interrupt counting
- CLI: Message is queued, processed after first CLI finishes
- **This is expected and acceptable** — follow-up messages arrive slightly later

**Success criteria:**
- Both messages are processed
- No IPC messages lost
- Session continuity maintained (same session ID)

### 4.6 Stress Test — Parallel Groups

**Test scenario: Multiple groups active simultaneously**

```bash
# Register 3 test groups (if not already)
# Send messages to all 3 at the same time (different channels/threads)
# Each message triggers container spawn

# Expected:
# - 3 containers running in parallel
# - Each uses CLI backend independently
# - No cross-group session leakage
# - All respond correctly
```

**Validation:**
```bash
docker ps  # Should show 3 nanoclaw containers

# Check session isolation
ls -la data/sessions/group1/.claude/
ls -la data/sessions/group2/.claude/
ls -la data/sessions/group3/.claude/
# Different session IDs, no overlap
```

---

## 5. Verification Checklist

### 5.1 Build-Time Checks

- [ ] TypeScript compilation passes (`npm run build` in container/agent-runner)
- [ ] No import errors for `claude-backend.ts`
- [ ] SDK completely removed from `node_modules/`
- [ ] Vitest installed in devDependencies
- [ ] Unit tests pass (`npm test` in container/agent-runner)
- [ ] Container image builds successfully (`./container/build.sh`)
- [ ] Claude CLI binary exists in image (`docker run --rm nanoclaw:latest which claude`)

### 5.2 Runtime Checks

- [ ] Container spawns successfully (no immediate crash)
- [ ] CLI process starts (`claude` appears in container logs)
- [ ] NDJSON stream-json output is parsed correctly
- [ ] Session ID captured from `{ type: 'system', subtype: 'init', session_id }` message
- [ ] Output markers `---NANOCLAW_OUTPUT_START---` / `---END---` are emitted
- [ ] Container-runner parses output markers correctly (no parse failures)
- [ ] Agent response appears in channel
- [ ] No "Failed to parse streamed output chunk" warnings

### 5.3 Session Continuity Checks

- [ ] Session ID is non-empty after first message
- [ ] Session ID persists in database (`sessions` table)
- [ ] Follow-up message uses `--resume <session-id>`
- [ ] CLI accepts `--resume` flag (process starts, no arg error)
- [ ] Agent maintains context across messages (remembers prior conversation)
- [ ] Session directory exists: `data/sessions/<group>/.claude/<session-id>/`
- [ ] Session transcripts exist in Claude's session directory

### 5.4 PreCompact Hook Checks

- [ ] Hook settings written to `~/.claude/settings.json` in container
- [ ] Hook command path: `node /tmp/dist/precompact-hook.js`
- [ ] Hook executes when context limit approached
- [ ] Transcript archived to `/workspace/group/conversations/`
- [ ] Archive markdown format is valid
- [ ] Assistant name appears in archive (from env var)
- [ ] Hook exits 0 (compaction proceeds)
- [ ] Agent continues functioning after compaction

### 5.5 Behavioral Parity Checks

- [ ] Single message → response works
- [ ] Multi-message session works
- [ ] Follow-up messages via IPC work (queued, processed sequentially)
- [ ] Agent Teams/swarms still work (CLI `Agent` tool enabled)
- [ ] File operations work (Read/Write/Edit tools)
- [ ] Bash tool works
- [ ] MCP tools work (credential proxy routing)
- [ ] Long-running tasks work (timeout handling)
- [ ] Graceful shutdown works (SIGTERM propagation)

### 5.6 Regression Checks

- [ ] Main group functionality unchanged
- [ ] Non-main groups work (trigger requirement logic)
- [ ] Scheduled tasks work (isScheduledTask flag)
- [ ] Remote control works (if enabled)
- [ ] IPC message routing works
- [ ] Task scheduler integration works
- [ ] Group queue processes messages sequentially
- [ ] Channel-specific logic unaffected (WhatsApp/Telegram/Slack/Discord/Gmail/Zulip)

---

## 6. Rollback Plan

### 6.1 Rollback Triggers

**Abort migration if:**
1. Container fails to build
2. Unit tests fail and can't be fixed quickly
3. Claude CLI binary missing from container image
4. Agent doesn't respond to test message
5. Session continuity broken (agent forgets prior messages)
6. Output marker parsing fails consistently
7. Critical production group affected (main group or high-priority groups)

### 6.2 Rollback Procedure

**Immediate rollback (before production deployment):**

```bash
# Stop NanoClaw
systemctl --user stop nanoclaw
# Or: kill npm run dev

# Revert git changes
git checkout feat/zulip-integration  # Or whatever branch you started from
git branch -D sdk-cli-migration-phase1

# Rebuild container with old code
./container/build.sh

# Restore per-group source copies (if backed up)
cp -r migration-backup/agent-runner-src data/sessions/main/
# ... for each group

# Restart NanoClaw
systemctl --user start nanoclaw

# Verify functionality restored
# Send test message, confirm agent responds
```

**Rollback after production deployment:**

```bash
# Same as above, plus:

# Restore database session state (if corrupted)
sqlite3 data/nanoclaw.db "DELETE FROM router_state WHERE key = 'last_agent_timestamp';"
# Forces fresh session start, discards broken session IDs

# Clean up CLI session directories (if causing issues)
rm -rf data/sessions/*/.claude/*/
# Agents will start fresh sessions

# Verify rollback
# Send test message to each affected group
# Confirm SDK-based agent responds correctly
```

### 6.3 Partial Rollback (Hybrid Mode — NOT RECOMMENDED)

**If rollback needed for specific groups only:**

- Restore SDK source to per-group `agent-runner-src/` directory
- Leave other groups on CLI backend
- **Risk:** Divergent behavior, hard to debug
- **Only use if:** Critical production group affected, others working fine

---

## 7. Post-Migration Validation

### 7.1 Monitoring (First 24 Hours)

**Watch for:**
1. Error rate increase in logs
2. Session ID format mismatches (UUID vs timestamp)
3. Session continuity failures (agent forgets context)
4. Output marker parsing failures
5. Increased container timeouts
6. MCP tool invocation failures
7. PreCompact hook errors

**Log queries:**
```bash
# Session initialization success
journalctl --user -u nanoclaw | grep 'Session initialized'

# Output parsing failures
journalctl --user -u nanoclaw | grep 'Failed to parse streamed output'

# Container errors
journalctl --user -u nanoclaw | grep 'Container.*error'

# CLI process failures
journalctl --user -u nanoclaw | grep 'claude CLI exited'
```

### 7.2 User-Facing Validation

**Coordinate with active users:**
- Announce migration in main group (if appropriate)
- Ask for feedback on response quality
- Monitor for "agent acting weird" reports
- Watch for context loss complaints

**Known expected changes:**
- Follow-up messages may arrive slightly later (CLI restart gap)
- No user-facing functional changes otherwise

### 7.3 Performance Baseline

**Capture metrics:**
- Average response time (first message)
- Average response time (follow-up message with `--resume`)
- Container spawn to first output duration
- Session continuity success rate (% of follow-ups that maintain context)

**Compare to pre-migration baseline:**
- Expect: Similar or slightly faster (cleaner process boundaries)
- Red flag: 2x slower or session continuity below 95%

---

## 8. Known Risks & Mitigations

### 8.1 Risk: Session ID Format Mismatch

**Risk:** CLI generates different session ID format than SDK, container-runner doesn't recognize it.

**Detection:**
- `newSessionId` is undefined or malformed
- Follow-up messages don't use `--resume` (agent forgets context)
- Logs show "Session initialized: undefined"

**Mitigation:**
- PR has been tested by kyuwoo-choi, session IDs are compatible
- Both SDK and CLI use same session directory structure
- If issue found: Check CLI source, add UUID normalization in `claude-backend.ts`

**Validation test:**
```bash
# After first message, check session ID format
sqlite3 data/nanoclaw.db "SELECT * FROM sessions WHERE group_jid = '<test-group-jid>';"
# Should show valid UUID or timestamp-based ID

ls -la data/sessions/<group>/.claude/
# Should show session directory matching the ID
```

### 8.2 Risk: Output Marker Position

**Risk:** CLI emits markers in different positions than SDK, causing parse failures.

**Detection:**
- "Failed to parse streamed output chunk" warnings
- Agent responses don't appear in channel
- `result` is null in all outputs

**Mitigation:**
- `claude-backend.ts` writes OUTPUT_START/END markers manually (see index.ts:111-113 for reference)
- Markers must appear in same stdout positions as SDK
- If issue found: Add markers around CLI output in `claude-backend.ts`

**Validation test:**
```bash
# Watch container stdout during test message
docker logs -f <container-name> 2>&1 | grep NANOCLAW_OUTPUT
# Should see:
# ---NANOCLAW_OUTPUT_START---
# {"status":"success","result":"...","newSessionId":"..."}
# ---NANOCLAW_OUTPUT_END---
```

**Critical:** The PR may not emit markers exactly as SDK does. If parse failures occur:
1. Check `container/agent-runner/src/index.ts:111-113` for marker emission code
2. Ensure `claude-backend.ts` yields messages that get wrapped by index.ts markers
3. The markers are emitted by **index.ts**, not claude-backend.ts — backend just yields message objects

### 8.3 Risk: Follow-Up Message Queue Starvation

**Risk:** IPC messages pile up while CLI processes one at a time, causing long delays.

**Detection:**
- Many `.json` files accumulate in `/workspace/ipc/input/`
- Follow-up messages delayed by minutes
- Users report "agent is slow to respond to follow-ups"

**Mitigation:**
- Phase 1 accepts this as known behavior (sequential processing)
- CLI invocations are generally faster than SDK (less overhead)
- Phase 2 will optimize if needed (batch multiple IPC messages per CLI invocation)

**Monitoring:**
```bash
# Check IPC queue depth during active session
watch -n 1 'ls data/groups/main/ipc/input/*.json 2>/dev/null | wc -l'
# Should stay near 0 or low single digits
# If consistently >5, follow-up processing is backlogged
```

### 8.4 Risk: PreCompact Hook Failure Blocks Compaction

**Risk:** Hook script crashes, exits 2, prevents compaction, session becomes unusable.

**Detection:**
- Agent stops responding after long conversation
- Logs show "PreCompact hook failed"
- Context limit reached but compaction didn't happen

**Mitigation:**
- Hook is defensive (catches errors, logs, tries to continue)
- Exit code 2 only on critical failures (can't write archive)
- If hook fails, compaction is blocked to prevent data loss
- Manual intervention: Delete session, start fresh

**Recovery:**
```bash
# If session stuck due to hook failure
rm -rf data/sessions/<group>/.claude/<session-id>/
# Next message starts new session

# Or fix hook and retry:
docker exec -it <container> node /tmp/dist/precompact-hook.js < test-input.json
# Debug hook directly
```

### 8.5 Risk: SIGTERM Propagation Failure

**Risk:** Container stop doesn't propagate to CLI child, leaves zombie processes.

**Detection:**
- Orphan `claude` processes remain after container stop
- Container stop hangs (waits for timeout)
- Next container start fails (port/resource conflict)

**Mitigation:**
- Dockerfile uses `exec` to make node PID 1
- `claude-backend.ts` has SIGTERM handler that kills child
- If issue found: Check process tree, ensure node is PID 1

**Validation:**
```bash
# Start container, check process tree
docker exec <container> ps aux
# PID 1 should be: node /tmp/dist/index.js

# Send SIGTERM, verify cleanup
docker stop <container>
# Should stop within 5 seconds (grace period)

# Check for orphans
ps aux | grep claude
# Should not show any claude processes from stopped container
```

---

## 9. Success Criteria

### 9.1 Phase 1 Complete When:

1. **Build passes:**
   - [ ] TypeScript compilation succeeds
   - [ ] Unit tests pass
   - [ ] Container image builds
   - [ ] Claude CLI binary verified in image

2. **Functional parity:**
   - [ ] Agent responds to single message
   - [ ] Session continuity works (follow-up messages maintain context)
   - [ ] Output appears in channel correctly
   - [ ] PreCompact hook archives conversations
   - [ ] MCP tools work (credential proxy, IPC, etc.)

3. **No regressions:**
   - [ ] Main group functionality unchanged
   - [ ] All registered groups work
   - [ ] Scheduled tasks work
   - [ ] IPC message routing works
   - [ ] Channel integrations unaffected

4. **Monitoring clean:**
   - [ ] No "Failed to parse streamed output" errors
   - [ ] No session ID format warnings
   - [ ] No container timeout spikes
   - [ ] No CLI crash loops

5. **User-facing:**
   - [ ] No quality degradation reported
   - [ ] No "agent forgot context" complaints
   - [ ] Response times acceptable

### 9.2 Ready for Production When:

- All checklist items above pass
- 24 hours of test deployment with no critical issues
- Rollback plan validated (can revert if needed)
- Team approval (if team exists)

---

## 10. Phase 2 Preview (Not in Scope for Phase 1)

**After Phase 1 stabilizes, Phase 2 will:**

1. **Remove MessageStream class**
   - Simplify index.ts IPC polling loop
   - Adopt PR's sequential `--resume` model fully
   - Remove vestigial SDK-era code

2. **Optimize follow-up message handling**
   - Batch multiple IPC messages per CLI invocation
   - Reduce CLI restart overhead for rapid follow-ups

3. **Add CLI-specific features**
   - Direct use of CLI tools (no MCP wrapper needed for many ops)
   - Better error messages from CLI stderr
   - Telemetry/metrics from CLI output

4. **Cleanup**
   - Remove SDK compatibility shims
   - Simplify type definitions
   - Update documentation to reflect CLI-native architecture

**Phase 1 explicitly does NOT touch:**
- MessageStream class (stays, vestigial)
- IPC polling loop (stays, unchanged)
- Container-runner output parsing (minimal changes)
- Any code outside `container/agent-runner/`

---

## 11. Technical Deep Dives

### 11.1 Query Flow Comparison

**SDK (before):**
```
index.ts
  ↓ query({ prompt: stream, options })
  ↓ @anthropic-ai/claude-agent-sdk (in-process)
  ↓ HTTP to Anthropic API
  ↓ Streaming response
  ↓ yield messages to caller
  ↓ Follow-up: stream.push(message) → SDK injects mid-turn
```

**CLI (after):**
```
index.ts
  ↓ query({ prompt: stream, options })
  ↓ claude-backend.ts (adapter)
  ↓ spawn('claude', args) → child process
  ↓ Claude CLI → HTTP to Anthropic API
  ↓ NDJSON stdout stream
  ↓ parseStreamJson() → yield messages
  ↓ Follow-up: queued → next CLI invocation with --resume
```

**Key difference:** Follow-up messages are sequential CLI invocations, not mid-turn injections.

### 11.2 MCP Config Translation

**SDK format (in-process):**
```typescript
options.mcpServers = {
  'ipc-mcp': {
    command: 'node',
    args: ['/app/src/ipc-mcp-stdio.js'],
    env: { ... }
  }
}
```

**CLI format (external config file):**
```json
{
  "mcpServers": {
    "ipc-mcp": {
      "command": "node",
      "args": ["/app/src/ipc-mcp-stdio.js"],
      "env": { ... }
    }
  }
}
```

**Translation:** `cli-utils.ts:writeMcpConfig()` writes SDK format to `/tmp/mcp-config.json`, passes to CLI via `--mcp-config`.

### 11.3 PreCompact Hook Translation

**SDK (in-process callback):**
```typescript
hooks: {
  PreCompact: [{
    hooks: [async (input, toolUseId, context) => {
      // Archive logic here
      return { continue: true };
    }]
  }]
}
```

**CLI (external command):**
```json
// ~/.claude/settings.json
{
  "hooks": {
    "PreCompact": [{
      "hooks": [{
        "type": "command",
        "command": "node /tmp/dist/precompact-hook.js"
      }]
    }]
  }
}
```

**CLI invokes:** `node /tmp/dist/precompact-hook.js < input.json > output.json`

**Input JSON:**
```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "...",
  "hook_event_name": "PreCompact",
  "trigger": "...",
  "custom_instructions": "..."
}
```

**Output JSON:**
```json
{ "continue": true }
```

**Exit codes:**
- 0: Success, compaction proceeds
- 2: Blocking error, compaction prevented

### 11.4 Tool Mapping Details

**SDK → CLI mapping:**

| SDK Tool | CLI Tool | Notes |
|----------|----------|-------|
| `Task` | `Agent` | SDK's subagent spawn |
| `TaskOutput` | `Agent` | SDK's subagent return |
| `TaskStop` | `Agent` | SDK's subagent abort |
| `TeamCreate` | `Agent` | SDK's agent swarm |
| `TeamDelete` | `Agent` | SDK's agent cleanup |
| `SendMessage` | `Agent` | SDK's inter-agent messaging |
| `Bash` | `Bash` | Direct mapping |
| `Read` | `Read` | Direct mapping |
| `Write` | `Write` | Direct mapping |
| `Edit` | `Edit` | Direct mapping |
| `Glob` | `Glob` | Direct mapping |
| `Grep` | `Grep` | Direct mapping |
| `LSP` | `LSP` | Direct mapping |
| `AstGrep` | `AstGrep` | Direct mapping |
| `AstEdit` | `AstEdit` | Direct mapping |

**Implementation:** `cli-utils.ts:mapAllowedTools()`

**Critical:** If SDK allows any of the 6 SDK-only tools, CLI must enable `Agent` tool. Otherwise, subagent spawning will fail.

---

## 12. Appendix: File Manifest

### Files to Add

```
container/agent-runner/src/claude-backend.ts         (230 lines, core adapter)
container/agent-runner/src/cli-utils.ts              (228 lines, utilities)
container/agent-runner/src/precompact-hook.ts        (202 lines, hook script)
container/agent-runner/src/cli-utils.test.ts         (test suite)
container/agent-runner/src/precompact-hook.test.ts   (test suite)
```

### Files to Modify

```
container/agent-runner/src/index.ts                  (1 line import, 3 lines env)
container/agent-runner/package.json                  (remove SDK, add vitest)
container/agent-runner/package-lock.json             (regenerated)
container/Dockerfile                                 (1 line comment, 1 line exec)
CLAUDE.md                                            (documentation, optional)
```

### Files NOT Modified in Phase 1

```
src/index.ts                    (orchestrator — unchanged)
src/container-runner.ts         (minimal changes, output parsing stays)
src/ipc.ts                      (unchanged)
src/router.ts                   (unchanged)
src/channels/*                  (unchanged)
All other files in src/         (unchanged)
```

**Total changeset:** ~650 lines added, ~10 lines modified, 0 lines in core orchestrator/router/channels.

---

## 13. Appendix: Command Reference

### Build & Test Commands

```bash
# Build container
./container/build.sh

# Run unit tests
cd container/agent-runner && npm test

# Type check
cd container/agent-runner && npm run build

# Start NanoClaw (dev)
npm run dev

# Start NanoClaw (systemd)
systemctl --user start nanoclaw

# View logs (systemd)
journalctl --user -u nanoclaw -f

# View logs (dev)
# Stdout/stderr already visible in terminal
```

### Container Inspection Commands

```bash
# List running containers
docker ps

# Check container logs
docker logs <container-name>
docker logs -f <container-name>  # Follow

# Exec into container
docker exec -it <container-name> /bin/bash

# Check process tree
docker exec <container-name> ps aux

# Check CLI binary
docker exec <container-name> which claude
docker exec <container-name> claude --version

# Check compiled source
docker exec <container-name> ls -la /tmp/dist/
```

### Database Inspection Commands

```bash
# View sessions
sqlite3 data/nanoclaw.db "SELECT * FROM sessions;"

# View router state
sqlite3 data/nanoclaw.db "SELECT * FROM router_state;"

# Clear agent timestamp (force new session)
sqlite3 data/nanoclaw.db "DELETE FROM router_state WHERE key = 'last_agent_timestamp';"
```

### File System Inspection Commands

```bash
# Check per-group sessions
ls -la data/sessions/<group>/.claude/

# Check conversations archive
ls -la data/groups/<group>/conversations/

# Check IPC queue
ls -la data/groups/<group>/ipc/input/

# Check agent-runner source copies
ls -la data/sessions/*/agent-runner-src/
```

---

## 14. Appendix: Debugging Scenarios

### Scenario 1: Agent doesn't respond

**Symptoms:**
- Message sent, no response in channel
- Container spawns, exits quickly
- No output in logs

**Debug steps:**
1. Check container logs: `docker logs <container-name>`
2. Look for CLI stderr: "claude CLI exited with code X"
3. Check session ID: Is `newSessionId` undefined?
4. Check output markers: Do `NANOCLAW_OUTPUT_START/END` appear?
5. Manually run CLI in container:
   ```bash
   docker exec -it <container> /bin/bash
   cd /workspace/group
   claude -p "Hello" --output-format stream-json
   # Does CLI work?
   ```

**Common causes:**
- Claude CLI binary missing → Rebuild container
- MCP config invalid → Check `/tmp/mcp-config.json` format
- Credentials missing → Check credential proxy is running
- Session directory unwritable → Check permissions on `/home/node/.claude/`

### Scenario 2: Agent forgets context

**Symptoms:**
- First message works
- Follow-up message treated as new conversation
- Agent says "I don't have prior context"

**Debug steps:**
1. Check session ID continuity:
   ```bash
   sqlite3 data/nanoclaw.db "SELECT * FROM sessions WHERE group_jid = '<jid>';"
   ```
2. Verify `--resume` flag in CLI invocation (should appear in logs)
3. Check session directory exists:
   ```bash
   ls -la data/sessions/<group>/.claude/<session-id>/
   ```
4. Check transcript file:
   ```bash
   cat data/sessions/<group>/.claude/<session-id>/transcript.ndjson
   ```

**Common causes:**
- Session ID not captured → Bug in claude-backend.ts message parsing
- Session ID format mismatch → CLI generates different format than expected
- Session directory deleted → Permissions issue or cleanup bug
- `--resume` not passed → Bug in buildCliArgs()

### Scenario 3: Output parsing failures

**Symptoms:**
- "Failed to parse streamed output chunk" warnings in logs
- Agent responses truncated or garbled
- Multiple partial results appear in channel

**Debug steps:**
1. Check raw stdout:
   ```bash
   docker logs <container-name> 2>&1 | grep -A 10 NANOCLAW_OUTPUT_START
   ```
2. Verify JSON is valid between markers
3. Check for stderr noise mixing into stdout
4. Verify marker positions match SDK behavior

**Common causes:**
- Markers in wrong position → index.ts emits markers, verify timing
- JSON malformed → Bug in output object construction
- Stderr mixed with stdout → CLI verbose mode pollution
- Multiple result objects without markers → Agent Teams output needs markers per result

### Scenario 4: PreCompact hook errors

**Symptoms:**
- Long conversation stops responding
- Logs show "PreCompact hook failed"
- Session stuck at context limit

**Debug steps:**
1. Check hook settings:
   ```bash
   cat data/sessions/<group>/.claude/settings.json
   ```
2. Manually run hook:
   ```bash
   echo '{"session_id":"test","transcript_path":"/workspace/group/.claude/<session>/transcript.ndjson"}' | \
   docker exec -i <container> node /tmp/dist/precompact-hook.js
   ```
3. Check archive directory:
   ```bash
   ls -la data/groups/<group>/conversations/
   ```
4. Check hook exit code (should be 0 or 2)

**Common causes:**
- Transcript path invalid → Session not initialized properly
- Conversations directory unwritable → Permissions issue
- JSON parse error on stdin → Hook input format mismatch
- Assistant name env var missing → Not critical, but affects archive formatting

---

**End of Phase 1 Implementation Plan**

This plan provides complete specifications for an agent to execute Phase 1 of the SDK→CLI migration. All file changes, test protocols, validation steps, and rollback procedures are documented. The plan assumes the agent has access to the `pr-1266` branch and can execute git, npm, docker, and file system operations.
