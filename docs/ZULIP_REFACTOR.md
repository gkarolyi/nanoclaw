# Zulip Integration Refactor

**Date:** 2026-03-17  
**Branch:** `feat/zulip-integration`  
**Commit:** `923c3b8`

## Problem

Zulip-specific logic was hardcoded in `src/index.ts`, creating high conflict risk with upstream updates:

- **Auto-register logic** (~91 lines) in `onMessage` callback
- **Trigger requirement overrides** in 3 separate locations
- **Backfill command checks** with Zulip JID pattern matching
- **ZULIP_AUTO_REGISTER_STREAMS** imported and used in main orchestration layer

Every upstream change to message routing in `index.ts` required manual conflict resolution.

## Solution

Extended the `Channel` interface with optional methods that channels can implement:

```typescript
interface Channel {
  // Existing methods...
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
  
  // New extension points:
  shouldRequireTrigger?(jid: string): boolean;
  handleAutoRegister?(
    jid: string,
    message: NewMessage,
    context: {
      registeredGroups: Record<string, RegisteredGroup>;
      triggerPattern: RegExp;
      assistantName: string;
    },
  ): { shouldRegister: boolean; group?: RegisteredGroup } | null;
  backfillHistory?(jid: string): Promise<void>;
}
```

## Changes

### 1. `src/types.ts`
- Added three optional Channel methods for customization hooks

### 2. `src/channels/zulip.ts`
**Added implementations:**
- `shouldRequireTrigger(jid)` - Returns false for auto-register streams
- `handleAutoRegister(jid, message, context)` - Full auto-registration logic
- `backfillHistory(jid)` - Renamed from `backfillTopicHistory` for generic interface

All Zulip-specific logic now lives in the Zulip channel implementation.

### 3. `src/index.ts`
**Removed:**
- ~91 lines of Zulip auto-register logic
- ~20 lines of trigger requirement override (3 locations)
- ~15 lines of backfill JID checks
- `ZULIP_AUTO_REGISTER_STREAMS` import

**Replaced with:**
- Generic channel method calls:
  ```typescript
  // Trigger requirement
  if (requiresTrigger && channel.shouldRequireTrigger) {
    requiresTrigger = channel.shouldRequireTrigger(chatJid);
  }
  
  // Auto-registration
  if (!registeredGroups[chatJid] && channel.handleAutoRegister) {
    const result = channel.handleAutoRegister(chatJid, msg, context);
    // ...
  }
  
  // Backfill
  if (channel.backfillHistory) {
    await channel.backfillHistory(chatJid);
  }
  ```

## Benefits

### Immediate
- ✅ **Lower conflict risk**: `index.ts` message routing can update independently
- ✅ **Better locality**: All Zulip logic in one file (`src/channels/zulip.ts`)
- ✅ **Generic threading model**: `handleAutoRegister` pattern works for Discord threads, Slack threads, etc.

### Future
- 🎯 **Upstreamable**: Clean separation makes Zulip channel proposable as a skill branch
- 🎯 **Extensible**: Other channels can use same hooks (Discord auto-register roles, Slack auto-register workspace channels)
- 🎯 **Testable**: Channel logic testable in isolation from orchestration layer

## Stats

**Lines changed:**
- `src/index.ts`: -126 lines
- `src/channels/zulip.ts`: +107 lines
- `src/types.ts`: +15 lines
- **Net:** -4 lines (consolidation)

**Test coverage:**
- All 329 tests pass
- No tests needed updating (behavior preserved)

## Migration Path

### For future Zulip updates
Work on `feat/zulip-integration` branch, merge upstream `main`:
```bash
git checkout feat/zulip-integration
git fetch upstream
git merge upstream/main  # Should have minimal conflicts in index.ts
```

### To propose upstream
Create skill branch with just Zulip files:
```bash
git checkout -b skill/zulip
git cherry-pick <zulip-commits>
# Push to fork, open PR to qwibitai/nanoclaw skill/zulip branch
```

## Threading Model

The refactor makes the threading pattern generic, though it was designed for Zulip:

**Zulip topics** = threads with:
- Auto-register from configured streams
- Trigger inheritance from parent stream
- Folder naming: `zulip_stream-name__topic-name_hash`

**Extensible to:**
- Discord forum channels (threads auto-register from forum)
- Slack workspace channels (topics auto-register from workspace)
- Telegram topics (auto-register from supergroups)

## Next Steps

1. ✅ ~~Refactor Zulip logic from index.ts~~ (Done)
2. 📝 Test in production with Zulip integration
3. 🎯 Add new long-running agent features on clean foundation
4. 🎯 Consider proposing Channel interface extensions to upstream
5. 🎯 Consider proposing Zulip as skill branch to upstream
