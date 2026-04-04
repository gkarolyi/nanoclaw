# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.


## Communication

Output information directly in the chat using markdown. **MUST NOT** use `cat << EOF`, `echo`, or similar methods to write temporary files just to display content to the user. Present plans, analyses, and documentation inline.
Always ask questions one at a time using the ask_user tool.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |


## Integrations

### Forgejo Integration

Agents can interact with local Forgejo instances via REST API and git operations using credential proxy pattern.

**Architecture:**
- API calls route through credential proxy: `http://host.docker.internal:3001/forgejo/*`
- Git operations use credential helper that fetches tokens from proxy on-demand
- Credentials (`FORGEJO_TOKEN`) never enter container filesystems

**Configuration:**
- `.env`: `FORGEJO_URL`, `FORGEJO_TOKEN`
- `src/credential-proxy.ts`: Routing logic for `/forgejo/*` and `/git-credentials` endpoints
- `container/git-credential-helper.sh`: Git credential helper script
- `container/Dockerfile`: Installs `jq` and configures git to use credential helper
- `groups/main/CLAUDE.md`: Agent instructions (API examples, workflows)

**User Setup:** See [docs/FORGEJO_INTEGRATION.md](docs/FORGEJO_INTEGRATION.md)

**Implementation Plan:** See [docs/FORGEJO_INTEGRATION_PLAN.md](docs/FORGEJO_INTEGRATION_PLAN.md)

### Zulip Integration

Agents can access Zulip attachments directly via mounted filesystem.

**Architecture:**
- Zulip's uploads directory is mounted at `/user_uploads` in containers
- Path structure matches Zulip URL structure exactly
- Zero-copy access — no download overhead
- Read-only mount for security

**Configuration:**
- `.env`: `ZULIP_UPLOADS_PATH` (optional, defaults to downloading to `data/uploads/`)
- `src/container-runner.ts`: Mount logic
- `groups/{name}/CLAUDE.md`: Agent instructions to use mounted paths instead of downloading

**Example:**
- Zulip URL: `/user_uploads/2/a1/abc123/report.pdf`
- Container path: `/user_uploads/2/a1/abc123/report.pdf`
- Agent reads file directly without HTTP request

**Agent Instructions:** Agents are instructed to extract the path from Zulip attachment URLs and read files directly from `/user_uploads/` instead of downloading them.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Security

### Secrets and Credentials

**ABSOLUTE PROHIBITION:** You **MUST NEVER** read, display, or log the contents of `.env` files or any files containing secrets, API keys, tokens, or passwords.
**ABSOLUTE PROHIBITION:** You **MUST NEVER** attempt to use any command with `sudo`. Any attemt to do this will cause the session to be terminated immediately.

### Tool Version Management (mise)

Containers have `mise` installed for managing language toolchains (Node.js, Python, Go, Rust, etc.).

**Per-group persistence**: Tools installed via mise persist across container restarts, isolated per group.

**Usage**:
```bash
# Install a specific version
mise use -g node@20
mise use -g python@3.12
mise use -g go@1.23

# List installed tools
mise list

# Run commands with mise-installed tools (REQUIRED)
mise exec -- node --version
mise exec -- python script.py
mise exec -- go build
```

**Critical**: Mise-installed tools are **not** on PATH. You **MUST** use `mise exec --` to run them.

- ✅ `mise exec -- node script.js`
- ❌ `node script.js` (will fail)

Tools persist at `data/sessions/{group}/local/` on the host. See `docs/MISE_IMPLEMENTATION.md` for details.

**Specifically forbidden:**
- `cat .env`
- `grep TOKEN .env`
- `read(path=".env")`
- Any command or tool that would reveal secret values

**Why this matters:**
- Secrets in `.env` are meant to stay on the host only
- Reading them exposes them in logs, conversation history, and artifacts
- Even "just checking" creates a security incident

**What you CAN do:**
- Check if a variable is *set*: `[ -n "$FORGEJO_TOKEN" ] && echo "set" || echo "not set"`
- Verify configuration files *exist*: `[ -f .env ] && echo "exists"`
- Read `.env.example` (never contains real secrets)

**If you need to verify configuration:**
1. Ask the user if the variable is set
2. Test the *functionality* (e.g., make an API call and check if auth works)
3. Never read the actual secret value

This is non-negotiable. Violating this erodes trust and creates security risks.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
