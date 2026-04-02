---
name: sync-forgejo
description: Merge changes from Forgejo remote into local branch and restart NanoClaw. Use when the user wants to pull updates from their Forgejo instance.
---

# About

Synchronize your local NanoClaw installation with changes from your Forgejo remote. This skill fetches from the `forgejo` remote, previews what changed, merges the updates, and restarts the service.

Run `/sync-forgejo` in Claude Code.

## How it works

**Preflight**: Checks for clean working tree and verifies the `forgejo` remote exists.

**Fetch**: Pulls latest refs from the Forgejo remote.

**Preview**: Shows commits and file changes that would be merged, grouped by category (skills, source, config).

**Merge**: Integrates Forgejo changes into your current branch with conflict resolution if needed.

**Build**: Compiles TypeScript and verifies the build succeeds.

**Restart**: Stops and starts the NanoClaw service using the appropriate service manager for your platform.

## Rollback

If something goes wrong, you can undo the merge before it's pushed:
```bash
git reset --hard ORIG_HEAD
```

---

# Goal

Help the user incorporate changes from their Forgejo remote into their local working copy, then restart the service to apply the changes.

# Operating principles
- Never proceed with a dirty working tree.
- Always preview before merging.
- Default to MERGE strategy (preserves history).
- Only restart the service after successful build.
- Platform-specific service restart (launchd, systemd, or manual).

# Step 0: Preflight

Run:
- `git status --porcelain`

If output is non-empty:
- Tell the user to commit or stash first, then stop.

Verify forgejo remote exists:
- `git remote -v`

If `forgejo` is missing:
- Tell the user the `forgejo` remote doesn't exist. Ask if they want to add it.
- If yes, ask for the Forgejo repo URL.
- Add it: `git remote add forgejo <url>`

Determine which branch to sync:
- `git branch --show-current`
- Store as LOCAL_BRANCH

Determine the target Forgejo branch:
- Default to the same branch name as LOCAL_BRANCH
- Ask the user: "Sync from forgejo/${LOCAL_BRANCH}?"
  - Yes: use forgejo/${LOCAL_BRANCH}
  - No: ask which forgejo branch to use
- Store as FORGEJO_BRANCH

# Step 1: Fetch

Run:
- `git fetch forgejo --prune`

# Step 2: Preview

Show what changed on Forgejo since the local branch diverged:

Compute the merge base:
- `BASE=$(git merge-base HEAD forgejo/${FORGEJO_BRANCH})`

Show Forgejo commits since BASE:
- `git log --oneline $BASE..forgejo/${FORGEJO_BRANCH}`

Show local commits since BASE:
- `git log --oneline $BASE..HEAD`

Show file-level changes from Forgejo:
- `git diff --name-only $BASE..forgejo/${FORGEJO_BRANCH}`

Bucket the changed files:
- **Skills** (`.claude/skills/`): unlikely to conflict
- **Source** (`src/`): may conflict if locally modified
- **Build/config** (`package.json`, `package-lock.json`, `tsconfig*.json`, `container/`, `launchd/`): review needed
- **Other**: docs, tests, misc

Present the summary to the user and ask using AskUserQuestion:
- A) **Proceed with merge**: merge all Forgejo changes
- B) **Abort**: just view the preview, change nothing

If Abort: stop here.

# Step 3: Merge

Run:
- `git merge forgejo/${FORGEJO_BRANCH} --no-edit`

If conflicts occur:
- Run `git status` and identify conflicted files.
- For each conflicted file:
  - Open the file.
  - Resolve conflict markers.
  - Preserve local customizations.
  - Incorporate Forgejo changes.
  - `git add <file>`
- When all resolved:
  - `git commit --no-edit`

# Step 4: Build

Run:
- `npm install` (in case package.json changed)
- `npm run build`

If build fails:
- Show the error.
- Fix issues clearly caused by the merge (missing imports, type mismatches).
- Do not refactor unrelated code.
- Re-run `npm run build` after fixes.

# Step 5: Restart Service

Detect the platform:
- `uname -s`
  - `Darwin` → macOS
  - `Linux` → Linux

## macOS (launchd)

Check if service is loaded:
- `launchctl list | grep com.nanoclaw`

If loaded:
- Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

If not loaded:
- Load: `launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist`

## Linux (systemd)

Check if service exists:
- `systemctl --user list-unit-files | grep nanoclaw` or `systemctl list-unit-files | grep nanoclaw`

If user service:
- Restart: `systemctl --user restart nanoclaw`

If system service:
- Restart: `sudo systemctl restart nanoclaw`

If no service found:
- Tell the user: "No systemd service found. If you're running manually with `npm run dev`, restart it manually."

## WSL or Manual

If neither launchd nor systemd service exists:
- Tell the user to restart their `npm run dev` process manually.

# Step 6: Verify

Wait 2 seconds for service to start, then:
- `tail -20 logs/nanoclaw.log`

Check for:
- "Ready" or "Listening" messages
- No error traces

If errors:
- Show the error.
- Attempt to diagnose (missing credentials, container not running, etc.).

# Step 7: Summary

Show:
- Local branch: ${LOCAL_BRANCH}
- Forgejo branch merged: ${FORGEJO_BRANCH}
- New HEAD: `git rev-parse --short HEAD`
- Service status: running / failed
- Rollback command: `git reset --hard ORIG_HEAD` (if not pushed yet)

Tell the user:
- Changes are merged and service restarted.
- To push to GitHub: `git push origin ${LOCAL_BRANCH}`
- To undo before pushing: `git reset --hard ORIG_HEAD`
