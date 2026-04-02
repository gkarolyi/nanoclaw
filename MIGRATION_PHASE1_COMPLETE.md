# SDK → CLI Migration Phase 1: Complete

## Summary

Successfully migrated NanoClaw container agent-runner from `@anthropic-ai/claude-agent-sdk` to Claude Code CLI binary using the drop-in adapter pattern.

## Changes Made

### Files Added (657 lines)
- `container/agent-runner/src/claude-backend.ts` — CLI adapter implementing SDK-compatible query() interface
- `container/agent-runner/src/cli-utils.ts` — CLI argument building, NDJSON parsing, MCP config management
- `container/agent-runner/src/precompact-hook.ts` — Standalone hook script for conversation archiving
- `container/agent-runner/src/cli-utils.test.ts` — Unit tests for CLI utilities
- `container/agent-runner/src/precompact-hook.test.ts` — Unit tests for precompact hook

### Files Modified
- `container/agent-runner/src/index.ts` — 1 line import change + 5 lines env var setup
- `container/agent-runner/package.json` — Removed SDK dependency, added vitest
- `container/agent-runner/package-lock.json` — Regenerated (SDK removed, vitest + dependencies added)
- `container/Dockerfile` — Updated comment, added `exec` for clean process management

### Additional Changes
- Backed up 27 per-group agent-runner source copies to `migration-backup/`
- Cleared all per-group source copies (will be regenerated from new source on next run)

## Build Verification ✓

- [x] TypeScript compilation passes
- [x] Unit tests pass (38/38)
- [x] Container image builds successfully
- [x] Claude CLI binary exists at `/usr/local/bin/claude`
- [x] Claude CLI version: 2.1.80
- [x] SDK completely removed from container node_modules
- [x] Backend files present in container: claude-backend.ts, cli-utils.ts, precompact-hook.ts

## Known Differences from SDK

1. **Follow-up messages**: Queued and processed sequentially via `--resume` instead of mid-turn injection
2. **Tool mapping**: SDK-specific tools (Task, TeamCreate, etc.) mapped to CLI `Agent` tool
3. **PreCompact hook**: External process (stdin/stdout JSON) instead of in-process callback

## Next Steps

### Integration Testing Required

1. **Basic invocation test**
   - Send test message to a registered group
   - Verify agent responds
   - Confirm session ID is captured
   - Check output appears in channel

2. **Session continuity test**
   - Send follow-up message in same session
   - Verify agent maintains context
   - Confirm `--resume` flag is used

3. **PreCompact hook test**
   - Trigger context compaction (long conversation or `/compact` command)
   - Verify conversation archived to `/workspace/group/conversations/`
   - Confirm agent continues after compaction

4. **Multi-group test**
   - Send messages to multiple groups simultaneously
   - Verify session isolation
   - Check parallel container spawning

### Deployment Steps

1. Stop running NanoClaw instance
2. Pull this branch: `sdk-cli-migration-phase1`
3. Rebuild container: `./container/build.sh`
4. Start NanoClaw
5. Monitor logs for:
   - "Session initialized" messages
   - No "Failed to parse streamed output" errors
   - CLI process invocations

### Rollback Plan

If issues occur:
```bash
# Stop NanoClaw
systemctl --user stop nanoclaw

# Revert to previous branch
git checkout feat/zulip-integration  # or main branch
git branch -D sdk-cli-migration-phase1

# Restore per-group source copies (if needed)
cp -r migration-backup/agent-runner-src data/sessions/main/

# Rebuild container
./container/build.sh

# Restart
systemctl --user start nanoclaw
```

## Git History

```
16c3829 Cleared per-group agent-runner source copies
10788af Update Dockerfile: use exec for clean process management
cf8ddf0 Switch index.ts to use CLI backend
3c374e8 Update package-lock after removing SDK
f9b15e6 Remove SDK dependency, add vitest
bc310ff Add CLI backend tests
335ace1 Add CLI backend adapter files
```

## Phase 2 Scope (Future)

- Remove MessageStream class (vestigial)
- Simplify IPC polling loop
- Optimize follow-up message batching
- Add CLI-specific telemetry
- Update documentation

---

**Status**: Ready for integration testing
**Risk level**: Low (adapter pattern isolates changes)
**Rollback time**: < 5 minutes
