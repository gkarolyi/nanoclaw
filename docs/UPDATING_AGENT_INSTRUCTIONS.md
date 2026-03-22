# Updating Agent Instructions

## The Problem

When you update agent instructions (CLAUDE.md) or add new tools, existing agent containers don't automatically pick up the changes. This is because:

1. **Containers mount at startup**: When an agent container starts, it mounts `groups/global/` and reads `CLAUDE.md`
2. **Claude Code caches instructions**: Claude Code reads and caches CLAUDE.md content at initialization
3. **Long-running containers**: Agent containers can run for hours/days, keeping stale instructions in memory

## The Solution

After making changes, you must force new containers to spawn.

### Step 1: Make Your Changes

Edit the appropriate file:
- **`groups/global/CLAUDE.md`** — Instructions for ALL agents (recommended for most changes)
- **`groups/main/CLAUDE.md`** — Instructions ONLY for main group agents
- **`groups/<group-name>/CLAUDE.md`** — Instructions for specific group

Add documentation/tools:
- **`groups/global/docs/`** — Shared documentation accessible to all agents
- **`container/`** — Scripts/tools to be built into container image

### Step 2: If You Changed Container Files

If you modified anything in `container/` (like adding the `forgejo` script):

```bash
# Rebuild the container image
./container/build.sh

# Restart NanoClaw service
systemctl --user restart nanoclaw
```

### Step 3: Stop Existing Agent Containers

Even after restarting the service, existing agent containers will have stale instructions.

```bash
# List running agent containers
docker ps --filter "ancestor=nanoclaw-agent:latest"

# Stop all agent containers
docker ps --filter "ancestor=nanoclaw-agent:latest" -q | xargs -r docker stop
```

### Step 4: Verify

The next time a user messages an agent, NanoClaw will spawn a fresh container with:
- ✅ New container image (if rebuilt)
- ✅ Updated CLAUDE.md instructions
- ✅ New documentation files
- ✅ Latest tools/scripts

## Quick Reference

### Common Update Scenarios

**Adding instructions (no new tools):**
```bash
# 1. Edit groups/global/CLAUDE.md
# 2. Stop containers
docker ps --filter "ancestor=nanoclaw-agent:latest" -q | xargs -r docker stop
```

**Adding a new script/tool:**
```bash
# 1. Add script to container/
# 2. Update container/Dockerfile to install it
# 3. Edit groups/global/CLAUDE.md with instructions
./container/build.sh
systemctl --user restart nanoclaw
docker ps --filter "ancestor=nanoclaw-agent:latest" -q | xargs -r docker stop
```

**Adding documentation:**
```bash
# 1. Add docs to groups/global/docs/
# 2. Reference in groups/global/CLAUDE.md
# 3. Stop containers
docker ps --filter "ancestor=nanoclaw-agent:latest" -q | xargs -r docker stop
```

## Why Not Automatic?

You might ask: why doesn't NanoClaw automatically reload instructions?

**Trade-offs:**
- ✅ **Current**: Stable agents, predictable behavior, explicit updates
- ❌ **Auto-reload**: Mid-conversation instruction changes, race conditions, harder to debug

The current design prioritizes stability over convenience. Agents complete their work with consistent instructions.

## Troubleshooting

### "Agent still using old instructions"

Check when the container started:
```bash
docker ps --filter "ancestor=nanoclaw-agent:latest" --format "{{.ID}}\t{{.CreatedAt}}"
```

If created before your update, stop it:
```bash
docker stop <container-id>
```

### "Changes not appearing in new containers"

Verify the file was actually updated:
```bash
ls -lh groups/global/CLAUDE.md groups/global/docs/
```

Check the container mounts (requires a running container):
```bash
docker inspect <container-id> | grep -A 20 Mounts
```

### "Container rebuild didn't work"

Verify the new image was created:
```bash
docker images nanoclaw-agent:latest
```

The `Created` timestamp should be recent. If not:
```bash
# Force rebuild without cache
docker build --no-cache -f container/Dockerfile -t nanoclaw-agent:latest .
```

## File Locations Reference

| File | Scope | Mounted At | Purpose |
|------|-------|------------|---------|
| `groups/global/CLAUDE.md` | All agents | `/workspace/global/CLAUDE.md` | Shared instructions |
| `groups/main/CLAUDE.md` | Main group only | `/workspace/group/CLAUDE.md` | Main-specific instructions |
| `groups/global/docs/` | All agents | `/workspace/global/docs/` | Shared documentation |
| `container/*` | All agents | Various (`/usr/local/bin/`, etc.) | Built into image |

## Best Practices

1. **Default to global**: Put instructions in `groups/global/CLAUDE.md` unless they're truly group-specific
2. **Document tools**: When adding a tool, also add docs to `groups/global/docs/`
3. **Test in isolation**: After updating, test with a simple message to verify instructions loaded
4. **Version control**: Commit instruction changes so you can track what agents know
5. **Stop containers proactively**: When you update, immediately stop containers rather than waiting for issues
