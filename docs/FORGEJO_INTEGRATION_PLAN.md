# Forgejo Integration Plan

## Overview

Enable NanoClaw agents to interact with a local Forgejo instance via REST API and git operations, using the existing credential proxy pattern to maintain security isolation.

### Architecture Summary

NanoClaw agents run in isolated Docker containers with:
- Read-only project root access (main group only)
- Per-group writable workspace at `/workspace/group`
- Credential proxy at `host.docker.internal:3001` (currently routes Anthropic API traffic)
- IPC-based host communication via `/workspace/ipc/`
- Per-group instructions via `CLAUDE.md` files

**Goal:** Enable containerized agents to interact with Forgejo via API and git operations without exposing credentials inside containers.

### Key Architecture Decisions

**Webhook Integration via Zulip**
- Forgejo webhooks → Zulip (native integration) → agents respond
- No custom webhook receiver in NanoClaw
- PR review comments appear as Zulip messages in topic threads
- Agents read PR details via API, make changes, push, reply

**Dual URL Configuration**
- `FORGEJO_URL` — Host proxy reaches Forgejo at `http://localhost:PORT`
- `FORGEJO_GIT_URL` — Containers use Tailscale DNS (e.g., `https://forgejo.example.ts.net`)
- API calls route through proxy for credential injection
- Git operations use Tailscale DNS with credential helper

**CLI Tools**
- `curl` + `git` (no additional dependencies)
- Credential proxy pattern for both API and git authentication
- No `tea` CLI (avoids credential exposure in config files)

---

## CLI Tool Analysis: curl vs tea (Forgejo CLI)

### Option A: curl + git (Recommended)

**Approach:**
- Use `curl` for REST API operations
- Use `git` CLI for repository operations
- Both authenticate via credential proxy

**Pros:**
- ✅ No additional dependencies (curl and git already in container)
- ✅ Works seamlessly with proxy architecture
- ✅ Agents already familiar with curl
- ✅ No configuration file management needed
- ✅ Token never enters container filesystem

**Cons:**
- ❌ Requires JSON construction for API calls
- ❌ Manual parsing of responses (via jq)
- ❌ Lower-level than specialized CLI

### Option B: tea (Forgejo/Gitea CLI)

**Approach:**
- Use `tea` for API operations (PRs, issues, repos)
- Use `git` for repository operations

**Pros:**
- ✅ Higher-level commands (`tea pr create` vs curl + JSON)
- ✅ Built-in formatting and pagination
- ✅ More user-friendly output

**Cons:**
- ❌ Requires installation in container (adds ~10MB)
- ❌ Expects credentials in `~/.config/tea/config.yml`
- ❌ Exposing token in config file violates security model
- ❌ Workaround: Configure tea to use proxy URL, but fragile (version checks, metadata endpoints)
- ❌ Still need git CLI for repository operations anyway

**Verdict:** **Use curl + git**. The proxy pattern works perfectly with curl. Adding `tea` introduces configuration complexity and potential credential exposure without eliminating the need for git CLI.

---

## Implementation Design

### 1. Credential Proxy Extension

**File:** `src/credential-proxy.ts`

**Current behavior:**
- Routes all traffic to `api.anthropic.com`
- Injects `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from host `.env`

**New behavior:**
- Route requests by URL path prefix:
  - `/forgejo/*` → Forgejo server (strip prefix, inject auth)
  - Everything else → Anthropic API (current behavior)

**Request flow:**

```
Container: GET http://host.docker.internal:3001/forgejo/api/v1/repos/...
    ↓
Proxy: Parse URL path
    ↓
Proxy: /forgejo/* detected → strip /forgejo prefix
    ↓
Proxy: Inject Authorization: token <FORGEJO_TOKEN> from host .env
    ↓
Proxy: Forward to FORGEJO_URL/api/v1/repos/...
    ↓
Return response to container
```

**Required .env variables:**
- `FORGEJO_URL` — Base URL of Forgejo server (e.g., `http://localhost:3000`)
- `FORGEJO_TOKEN` — Personal access token with repo read/write permissions

**Implementation details:**

1. Parse request path in proxy handler:
   ```typescript
   if (req.url?.startsWith('/forgejo/')) {
     // Forgejo route
     const forgejoPath = req.url.slice('/forgejo'.length);
     // Forward to FORGEJO_URL + forgejoPath
   } else {
     // Existing Anthropic route
   }
   ```

2. Read Forgejo credentials:
   ```typescript
   const forgejoSecrets = readEnvFile(['FORGEJO_URL', 'FORGEJO_TOKEN']);
   ```

3. Inject Authorization header:
   ```typescript
   headers['authorization'] = `token ${forgejoSecrets.FORGEJO_TOKEN}`;
   ```

4. Support both HTTP and HTTPS upstream Forgejo servers

**Edge cases:**
- If `FORGEJO_URL` or `FORGEJO_TOKEN` missing: return 502 with clear error message
- Preserve request method (GET/POST/PUT/DELETE/PATCH)
- Forward response headers and status codes unchanged
- Strip hop-by-hop headers (connection, keep-alive, transfer-encoding)

**Security model:**
- Container never sees real token
- Token lives only in host `.env` (never mounted, never in process.env inside containers)
- Proxy reads via `readEnvFile()` (same pattern as Anthropic credentials)

---

### 2. Git Credential Setup

**Challenge:** `git push` from inside containers needs credentials, but containers can't access `FORGEJO_TOKEN`.

**Approach: Git Credential Helper via Proxy**

Use git's native credential helper protocol to fetch credentials on-demand from the proxy.

#### 2.1 Proxy endpoint: `/git-credentials`

Add new endpoint to `credential-proxy.ts`:

```
POST http://host.docker.internal:3001/git-credentials
Request body: { "host": "forgejo.example.com" }
Response: { "username": "x-token-auth", "password": "<FORGEJO_TOKEN>" }
```

**Implementation:**
- Parse POST body to get requested host
- Validate host matches Forgejo instance (prevent credential leakage to arbitrary hosts)
- Return username `x-token-auth` (Forgejo/Gitea convention for token auth)
- Return password = `FORGEJO_TOKEN` from host `.env`

**Security:**
- Only responds to requests from container network
- Only returns credentials for configured Forgejo host
- No credentials cached in container

#### 2.2 Git credential helper script

**File:** `container/git-credential-helper.sh`

```bash
#!/bin/bash
# Git credential helper that fetches credentials from the credential proxy
# Git credential helper protocol: https://git-scm.com/docs/gitcredentials

if [ "$1" = "get" ]; then
  # Read input from git (provides protocol, host, path)
  while IFS= read -r line; do
    case "$line" in
      host=*) HOST="${line#host=}" ;;
      "") break ;;
    esac
  done

  # Fetch credentials from proxy
  RESPONSE=$(curl -s -X POST http://host.docker.internal:3001/git-credentials \
    -H "Content-Type: application/json" \
    -d "{\"host\":\"$HOST\"}")

  USERNAME=$(echo "$RESPONSE" | jq -r '.username // empty')
  PASSWORD=$(echo "$RESPONSE" | jq -r '.password // empty')

  if [ -n "$USERNAME" ] && [ -n "$PASSWORD" ]; then
    echo "username=$USERNAME"
    echo "password=$PASSWORD"
  fi
fi
```

**Install in Dockerfile:**
```dockerfile
COPY git-credential-helper.sh /usr/local/bin/git-credential-helper.sh
RUN chmod +x /usr/local/bin/git-credential-helper.sh && \
    git config --system credential.helper /usr/local/bin/git-credential-helper.sh
```

**Why this approach:**
- ✅ Cleaner: agents use normal git URLs (`https://forgejo.example.com/user/repo.git`)
- ✅ More flexible: works with any git operation (clone, push, pull, fetch)
- ✅ Native: git credential helper protocol is standard
- ✅ Secure: credentials fetched on-demand, never stored in container
- ✅ No URL manipulation needed in agent instructions

#### 2.3 Forgejo hostname resolution

**User's setup:** Forgejo runs in Docker on the same machine, accessible via Tailscale DNS.

**Solution: Dual URL configuration**

Because containers cannot reach other Docker containers via `host.docker.internal`, we need two URLs:

1. **`FORGEJO_URL`** — For the proxy running on the host
   - Example: `http://localhost:3000`
   - The proxy forwards API requests from containers to this URL

2. **`FORGEJO_GIT_URL`** — For containers to reach Forgejo for git operations
   - Example: `https://forgejo.yourdomain.ts.net`
   - Containers use this URL when cloning/pushing via git
   - Tailscale DNS resolves this to the Forgejo container

**Request flow:**

API requests (with credential injection):
```
Container: curl http://host.docker.internal:3001/forgejo/api/v1/repos/...
    ↓
Proxy (on host): Forward to FORGEJO_URL (http://localhost:3000)
    ↓
Forgejo container: Receives request with injected token
```

Git operations (credential helper):
```
Container: git clone https://forgejo.yourdomain.ts.net/user/repo.git
    ↓
Git: Request credentials from helper
    ↓
Helper: POST to http://host.docker.internal:3001/git-credentials
    ↓
Proxy: Return token for forgejo.yourdomain.ts.net
    ↓
Container: Clone directly from Forgejo via Tailscale DNS
```

---

### 3. CLAUDE.md Template Updates

**Files to update:**
- `groups/main/CLAUDE.md` (main group template)
- Any other group templates that should have Forgejo access

**New section to add:**

```markdown
## Forgejo Integration

You have access to a local Forgejo instance for managing code repositories and pull requests.

### REST API Access

Use the credential proxy to make Forgejo API calls. Credentials are automatically injected.

**Base URL:** `http://host.docker.internal:3001/forgejo`

**Examples:**

List your repositories:
```bash
curl -s http://host.docker.internal:3001/forgejo/api/v1/user/repos | jq -r '.[].name'
```

Get repository details:
```bash
curl -s http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO
```

Create a pull request:
```bash
curl -X POST http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix bug in parser",
    "head": "feature-branch",
    "base": "main",
    "body": "Description of changes"
  }' | jq
```

List pull requests:
```bash
curl -s http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls | jq
```

Get PR details:
```bash
curl -s http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/1 | jq
```

**⚠️ Important:** Do NOT use the merge endpoint. Pull requests require human review and approval. After creating a PR, report the URL to the user for review.

**API Documentation:** The API is Gitea-compatible. See https://try.gitea.io/api/swagger for full reference.

### Git Operations

Git credentials are automatically provided via credential helper. Use normal git commands.

**Git remote URL:** `https://forgejo.yourdomain.ts.net` (Tailscale DNS address)

Replace `forgejo.yourdomain.ts.net` with your actual Forgejo Tailscale hostname.

**Clone a repository:**
```bash
git clone https://forgejo.yourdomain.ts.net/OWNER/REPO.git
cd REPO
```

**Create feature branch and push:**
```bash
git checkout -b feature-branch
# make changes
git add .
git commit -m "Implement feature"
git push origin feature-branch
```

**Pull latest changes:**
```bash
git pull origin main
```

### Workflow: Code Changes + PR

When asked to implement a feature with a PR:

1. **Clone the repository** (if not already present in workspace)
   ```bash
   git clone https://forgejo.yourdomain.ts.net/OWNER/REPO.git
   cd REPO
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b feature/description
   ```

3. **Make the code changes**
   - Edit files as needed
   - Test if applicable

4. **Commit and push**
   ```bash
   git add .
   git commit -m "Clear description of changes"
   git push origin feature/description
   ```

5. **Create a pull request via API**
   ```bash
   PR_URL=$(curl -s -X POST http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls \
     -H "Content-Type: application/json" \
     -d '{
       "title": "Feature: Description",
       "head": "feature/description",
       "base": "main",
       "body": "## Changes\n\n- Item 1\n- Item 2\n\n## Testing\n\nDescribe testing done"
     }' | jq -r '.html_url')
   echo "Pull request created: $PR_URL"
   ```

6. **Report back to the user**
   - Include PR URL
   - Summarize changes made
```

### Workflow: Responding to PR Review Comments

When you see a PR review comment notification in Zulip:

1. **Read the PR and review comments**
   ```bash
   # Get PR details
   curl -s http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER | jq
   
   # Get all review comments
   curl -s http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews | jq
   ```

2. **Fetch the PR branch and make changes**
   ```bash
   git fetch origin pull/PR_NUMBER/head:pr-PR_NUMBER
   git checkout pr-PR_NUMBER
   # Make the requested changes
   git add .
   git commit -m "Address review feedback"
   git push origin pr-PR_NUMBER
   ```

3. **Reply to the review comment (optional)**
   ```bash
   curl -X POST http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews/REVIEW_ID/comments \
     -H "Content-Type: application/json" \
     -d '{"body": "Fixed in latest commit"}'
   ```

4. **Report back in Zulip**
   Summarize the changes you made and confirm the issue is addressed.

### PR Review API Endpoints

```bash
# List all reviews for a PR
curl http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews

# Get a specific review
curl http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews/REVIEW_ID

# List review comments
curl http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews/REVIEW_ID/comments

# Reply to a review comment
curl -X POST http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews/REVIEW_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"body": "Your reply here"}'

# Create a new review (approve/request changes/comment)
curl -X POST http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews \
  -H "Content-Type: application/json" \
  -d '{
    "event": "COMMENT",
    "body": "Overall feedback"
  }'
```

**Template variables:**
- `{{GIT_REMOTE_URL_INSTRUCTIONS}}` — Replaced with appropriate instructions based on Forgejo server location
- `{{EXAMPLE_GIT_URL}}` — Example git URL (e.g., `http://host.docker.internal:3000` or `https://forgejo.example.com`)

**Implementation approach:**

Create a template rendering system (or extend existing group creation logic):
1. Read `FORGEJO_URL` from `.env`
2. Determine git URL format:
   - If `FORGEJO_URL` contains `localhost` or `127.0.0.1` → convert to `host.docker.internal` for containers
   - Otherwise use as-is
3. Render template with actual values
4. Write to `groups/main/CLAUDE.md` (and any other group templates)

---

### 4. Container Updates

**File:** `container/Dockerfile`

**Add dependencies:**
- `jq` — JSON parsing for API responses and git credential helper
- Git credential helper script

**Changes:**

```dockerfile
# Install system dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    jq \
    && rm -rf /var/lib/apt/lists/*

# ... existing Dockerfile content ...

# Configure git credential helper
COPY git-credential-helper.sh /usr/local/bin/git-credential-helper.sh
RUN chmod +x /usr/local/bin/git-credential-helper.sh && \
    git config --system credential.helper /usr/local/bin/git-credential-helper.sh
```

**Rebuild required:** Yes (`./container/build.sh` after changes)

**Image size impact:** `jq` adds ~5-10MB

---

### 5. .env.example Updates

**File:** `.env.example`

Add new section after Zulip integration:

```bash
# ════════════════════════════════════════════════════════════════════════════
# Forgejo Integration
# ════════════════════════════════════════════════════════════════════════════

# Base URL for the credential proxy to reach Forgejo (no trailing slash)
# This is used by the host proxy to forward API requests to Forgejo.
#
# Since Forgejo runs in Docker on the same machine, use localhost:
# FORGEJO_URL=http://localhost:3000

# Git remote URL for containers to reach Forgejo (no trailing slash)
# Containers cannot reach other Docker containers via host.docker.internal,
# so they use the Tailscale DNS address instead.
#
# Example: https://forgejo.yourdomain.ts.net
# FORGEJO_GIT_URL=

# Personal access token for Forgejo API and git access
# Generate a token at: <FORGEJO_URL>/user/settings/applications
#
# Required permissions:
#   - read:repository (read repo data, clone repos)
#   - write:repository (push changes)
#   - read:issue (read PRs and issues)
#   - write:issue (create and update PRs)
#
```

---

### 6. Additional Group Configuration (Optional)

For groups that need access to specific repositories, use `containerConfig.additionalMounts`.

**Example: Mount a project repo for a dedicated coding group**

```json
{
  "jid": "120363336345536173@g.us",
  "name": "MyProject Dev",
  "folder": "whatsapp_myproject-dev",
  "trigger": "@Andy",
  "added_at": "2026-03-20T12:00:00.000Z",
  "containerConfig": {
    "additionalMounts": [
      {
        "hostPath": "~/projects/myproject",
        "containerPath": "myproject",
        "readonly": false
      }
    ]
  }
}
```

**Security requirement:**
- Additional mounts must be pre-approved in `~/.config/nanoclaw/mount-allowlist.json`
- Path is outside project root, cannot be modified by agents
- Prevents agents from mounting arbitrary paths via IPC

**Allowlist format:**

```json
{
  "allowed": [
    "/home/user/projects/myproject",
    "/home/user/projects/another-repo"
  ]
}
```

**Container path:** Mounted at `/workspace/extra/myproject` inside container

---

## Implementation Phases

### Phase 1: Proxy Extension (Core API Access)

**Files:**
- `src/credential-proxy.ts`
- `.env.example`

**Tasks:**
1. Extend proxy request handler to detect `/forgejo/` prefix
2. Add Forgejo route handler:
   - Strip `/forgejo` prefix
   - Read `FORGEJO_URL` and `FORGEJO_TOKEN` from `.env`
   - Inject `Authorization: token <FORGEJO_TOKEN>` header
   - Forward to Forgejo server
3. Handle errors (missing env vars, upstream failures)
4. Add `FORGEJO_URL` and `FORGEJO_TOKEN` to `.env.example`

**Testing:**
```bash
# From host, with FORGEJO_URL and FORGEJO_TOKEN set in .env
curl http://localhost:3001/forgejo/api/v1/user/repos | jq
```

**Acceptance:** Proxy successfully routes Forgejo API requests with injected auth.

---

### Phase 2: Git Credentials (Repository Operations)

**Files:**
- `src/credential-proxy.ts` (add `/git-credentials` endpoint)
- `container/git-credential-helper.sh` (new)
- `container/Dockerfile`

**Tasks:**
1. Add POST `/git-credentials` endpoint to proxy:
   - Accept `{ "host": "..." }` in request body
   - Validate host matches Forgejo instance
   - Return `{ "username": "x-token-auth", "password": "<FORGEJO_TOKEN>" }`
2. Create `container/git-credential-helper.sh` script
3. Update Dockerfile:
   - Add `jq` to apt install list
   - Copy git-credential-helper.sh
   - Configure git to use the credential helper
4. Rebuild container: `./container/build.sh`

**Testing:**
```bash
# Inside a running container
git clone http://host.docker.internal:3000/OWNER/REPO.git
cd REPO
echo "test" > test.txt
git add test.txt
git commit -m "Test commit"
git push origin main
```

**Acceptance:** Git operations authenticate automatically without manual credential entry.

---

### Phase 3: Agent Instructions (Discoverability)

**Files:**
- `groups/main/CLAUDE.md`
- `src/group-creation.ts` (or new template renderer, if needed)

**Tasks:**
1. Add Forgejo integration section to `groups/main/CLAUDE.md`
2. Replace template variables:
   - Read `FORGEJO_URL` from `.env`
   - Convert localhost → host.docker.internal for container context
   - Render examples with actual URLs
3. Document API usage patterns (list repos, create PR, merge PR)
4. Document git workflow (clone, branch, commit, push, create PR)
5. Add troubleshooting section (common errors, credential issues)

**Testing:**
- Ask main agent: "List my Forgejo repositories"
- Ask main agent: "Clone the 'myproject' repo and create a feature branch"
- Ask main agent: "Implement feature X and create a PR"

**Acceptance:** Agent can follow instructions to complete full workflow without additional guidance.

---

### Phase 4: Documentation & Polish

**Files:**
- `CLAUDE.md` (root)
- `README.md` (optional)
- `docs/FORGEJO_INTEGRATION.md` (user guide)

**Tasks:**
1. Document Forgejo integration in root `CLAUDE.md` for future contributors
2. Add user guide in `docs/` with setup instructions:
   - How to generate Forgejo token
   - How to configure `.env`
   - Example workflows
   - Troubleshooting
3. Update README with Forgejo integration feature (optional)
4. Add integration to skill system (optional `/add-forgejo` skill for future modularity)

**Acceptance:** Documentation is complete and clear for new users.


### Phase 5: Zulip + Forgejo Webhook Integration

**Goal:** Enable agents to respond to PR review comments and other Forgejo events via Zulip's native integration.

**Architecture:**
- Forgejo sends webhooks to Zulip (native integration)
- Zulip posts events as messages in topics
- Agents see messages, respond via Forgejo API
- No custom webhook receiver needed in NanoClaw

**Setup:**

1. **Configure Forgejo → Zulip webhook**
   - In Forgejo: Settings → Webhooks → Add Webhook → Gitea/Forgejo
   - Or use Zulip's incoming webhook integration
   - Target: Zulip stream + topic pattern (e.g., `#code > PR {{pr_number}}`)

2. **Configure which events to send**
   - Pull request opened/closed/merged
   - Pull request review comments
   - Push events (optional, can be noisy)
   - Issue events (optional)

3. **Message format in Zulip**
   Forgejo posts will appear like:
   ```
   Stream: #code
   Topic: PR #145 review comments
   
   @username commented on src/parser.ts:42:
   "This should handle empty strings"
   
   PR: https://forgejo.yourdomain.ts.net/user/repo/pull/145
   ```

**Agent workflow for responding to review comments:**

When agent sees review comment in Zulip:

```bash
# 1. Read the full PR details
curl -s http://host.docker.internal:3001/forgejo/api/v1/repos/user/repo/pulls/145 | jq

# 2. Read all review comments
curl -s http://host.docker.internal:3001/forgejo/api/v1/repos/user/repo/pulls/145/reviews | jq

# 3. Fetch the PR branch
git fetch origin pull/145/head:pr-145
git checkout pr-145

# 4. Make the requested changes
# ... edit files ...
git add .
git commit -m "Address review feedback: handle empty strings"

# 5. Push updated branch
git push origin pr-145

# 6. Optionally reply to review comment via API
curl -X POST http://host.docker.internal:3001/forgejo/api/v1/repos/user/repo/pulls/145/reviews/123/comments \
  -H "Content-Type: application/json" \
  -d '{"body": "Fixed in latest commit - parser now returns null for empty strings"}'

# 7. Report back in Zulip
# Agent's normal response mechanism posts to the same topic
```

**Agent instructions for CLAUDE.md:**

Add to the Forgejo Integration section:

```markdown
### Responding to PR Review Comments

When you see a PR review comment notification in Zulip:

1. **Read the PR and review comments**
   ```bash
   # Get PR details
   curl -s http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER | jq
   
   # Get all review comments
   curl -s http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews | jq
   ```

2. **Fetch the PR branch and make changes**
   ```bash
   git fetch origin pull/PR_NUMBER/head:pr-PR_NUMBER
   git checkout pr-PR_NUMBER
   # Make the requested changes
   git add .
   git commit -m "Address review feedback"
   git push origin pr-PR_NUMBER
   ```

3. **Reply to the review comment (optional)**
   ```bash
   curl -X POST http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews/REVIEW_ID/comments \
     -H "Content-Type: application/json" \
     -d '{"body": "Fixed in latest commit"}'
   ```

4. **Report back in Zulip**
   Summarize the changes you made and confirm the issue is addressed.
```

**API endpoints for PR reviews:**

```bash
# List all reviews for a PR
curl http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews

# Get a specific review
curl http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews/REVIEW_ID

# List review comments
curl http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews/REVIEW_ID/comments

# Reply to a review comment
curl -X POST http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews/REVIEW_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"body": "Your reply here"}'

# Create a new review (approve/request changes/comment)
curl -X POST http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/pulls/PR_NUMBER/reviews \
  -H "Content-Type: application/json" \
  -d '{
    "event": "COMMENT",
    "body": "Overall feedback"
  }'
```

**Zulip Integration Documentation:**

- **Zulip Integrations:** https://zulip.com/integrations/
- **Gitea/Forgejo integration:** https://zulip.com/integrations/doc/gitea
- **Incoming webhooks:** https://zulip.com/integrations/doc/incoming-webhooks

**Testing:**
1. Create a test PR in Forgejo
2. Leave a review comment
3. Verify comment appears in Zulip topic
4. Ask agent in Zulip to address the comment
5. Verify agent reads PR, makes changes, pushes, replies

**Acceptance:**
- ✅ Forgejo events post to Zulip topics
- ✅ Agents can read PR review comments via API
- ✅ Agents can respond to comments (code changes + optional API reply)
- ✅ Full PR review cycle works end-to-end in Zulip

---
---

## Security Considerations

### Credential Isolation
- ✅ `FORGEJO_TOKEN` never enters containers
- ✅ Token lives only in host `.env` (never mounted, never in process.env)
- ✅ Proxy injects credentials per-request
- ✅ Containers see placeholder/proxy URLs only

### Network Isolation
- ✅ Containers can only reach Forgejo via proxy (for API) or direct (for git)
- ✅ No direct credential access possible
- ✅ Proxy validates requests before forwarding

### Mount Security
- ✅ Additional repo mounts require pre-approval in allowlist
- ✅ Allowlist stored outside project root (cannot be modified by agents)
- ✅ Read-only project mount prevents agents from modifying NanoClaw's own code

### Git Credential Scope
- ✅ Credential helper validates host before returning credentials
- ✅ Only returns credentials for configured Forgejo host
- ✅ Won't leak credentials to arbitrary git servers

### IPC Authorization
- ✅ Non-main groups cannot spawn agents with arbitrary mounts
- ✅ IPC task processing validates source group identity
- ✅ Mount allowlist enforced at runtime

---

## Testing Plan

### Unit Tests

**Proxy routing:**
```typescript
describe('credential-proxy', () => {
  it('routes /forgejo/* to Forgejo server', () => {
    const req = { url: '/forgejo/api/v1/user/repos' };
    const route = determineRoute(req);
    expect(route.type).toBe('forgejo');
    expect(route.path).toBe('/api/v1/user/repos');
  });

  it('routes other paths to Anthropic', () => {
    const req = { url: '/v1/messages' };
    const route = determineRoute(req);
    expect(route.type).toBe('anthropic');
  });
});
```

**Credential injection:**
```typescript
describe('git-credentials endpoint', () => {
  it('returns credentials for Forgejo host', () => {
    const body = { host: 'forgejo.example.com' };
    const response = handleGitCredentials(body, { FORGEJO_URL: 'https://forgejo.example.com', FORGEJO_TOKEN: 'test-token' });
    expect(response.username).toBe('x-token-auth');
    expect(response.password).toBe('test-token');
  });

  it('returns empty for non-Forgejo host', () => {
    const body = { host: 'github.com' };
    const response = handleGitCredentials(body, { FORGEJO_URL: 'https://forgejo.example.com', FORGEJO_TOKEN: 'test-token' });
    expect(response.username).toBe(undefined);
  });
});
```

### Integration Tests

**1. API access from container:**
```bash
# Start NanoClaw with Forgejo configured
docker run -it --rm nanoclaw-agent:latest bash

# Inside container:
curl http://host.docker.internal:3001/forgejo/api/v1/user/repos
# Expected: JSON list of repositories
```

**2. Git clone from container:**
```bash
# Inside container:
git clone http://host.docker.internal:3000/testuser/testrepo.git
# Expected: Repo cloned successfully, credential helper invoked
```

**3. Git push from container:**
```bash
# Inside container, in a cloned repo:
echo "test" > test.txt
git add test.txt
git commit -m "Test commit"
git push origin main
# Expected: Push succeeds, credential helper invoked
```

**4. PR creation via API:**
```bash
# Inside container:
curl -X POST http://host.docker.internal:3001/forgejo/api/v1/repos/testuser/testrepo/pulls \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test PR",
    "head": "feature-branch",
    "base": "main"
  }'
# Expected: PR created, JSON response with PR details
```

**5. Full agent workflow:**
```
User: "Clone the 'nanoclaw-test' repo, add a README, and create a PR"

Expected behavior:
1. Agent clones repo
2. Agent creates README.md
3. Agent commits and pushes
4. Agent creates PR via API
5. Agent reports PR URL
```

### Edge Cases

**Missing credentials:**
```bash
# Remove FORGEJO_TOKEN from .env, restart proxy
curl http://localhost:3001/forgejo/api/v1/user/repos
# Expected: 502 Bad Gateway with error message "FORGEJO_TOKEN not configured"
```

**Invalid token:**
```bash
# Set FORGEJO_TOKEN to invalid value, restart proxy
curl http://localhost:3001/forgejo/api/v1/user/repos
# Expected: 401 Unauthorized (forwarded from Forgejo)
```

**Forgejo server unreachable:**
```bash
# Set FORGEJO_URL to non-existent server, restart proxy
curl http://localhost:3001/forgejo/api/v1/user/repos
# Expected: 502 Bad Gateway with error about upstream connection failure
```

**Git credential helper called for non-Forgejo host:**
```bash
# Inside container:
git clone https://github.com/user/repo.git
# Expected: Git prompts for credentials (helper returns nothing for github.com)
```

**URL parsing edge cases:**
- `/forgejo` (no trailing slash) → should handle gracefully
- `/forgejo/` (root path) → forward to Forgejo root
- `/forgejotest` (prefix match but not path segment) → route to Anthropic
- `/api/forgejo/` (forgejo in middle of path) → route to Anthropic

---

## Configuration Decisions

Based on user requirements:

### 1. Forgejo Server Location

**Setup:** Forgejo runs in Docker on the same machine as NanoClaw, accessible via Tailscale DNS.

**Implementation:**
- `FORGEJO_URL` — Host proxy uses `http://localhost:PORT` to reach Forgejo
- `FORGEJO_GIT_URL` — Containers use Tailscale DNS address for git operations (e.g., `https://forgejo.example.ts.net`)
- API calls still route through proxy for credential injection

**Why two URLs:**
- Proxy runs on host → can use `localhost`
- Containers cannot reach other Docker containers via `host.docker.internal` → use Tailscale DNS instead

---

### 2. Repository Access Scope

**Decision:** All agents can access all repositories (single global `FORGEJO_TOKEN`).

**Implementation:**
- One token with full repo access
- All agents use same credentials via proxy
- Simpler to set up and maintain

---

### 3. Workflow Triggers

**Decision:** Both manual (user requests) and webhook-triggered automation.

- Phase 1-4: Manual workflows (user asks agent to create PR, etc.)
- Phase 5: Webhook automation via Zulip's native Forgejo integration
- Forgejo sends webhooks → Zulip posts to topics → agents respond
- No custom webhook receiver needed in NanoClaw

---

### 4. PR Merge Policy

**Decision:** Agents can create PRs but cannot merge (human approval required).

**Implementation:**
- Document PR creation API in CLAUDE.md
- Explicitly discourage merge endpoint in instructions
- Agents report PR URL for human review

**Security benefit:** Prevents unreviewed code from auto-merging.

---

### 5. Error Handling

**Decision:** Agents report errors directly in chat (best UX).

**Implementation:**
- Failed API calls: agent parses error, explains in plain language
- Git failures: agent reports stderr output, suggests fixes
- No silent failures, no "check the logs" messages
---

## Files to Create/Modify

### Create

- `container/git-credential-helper.sh` — Git credential helper script
- `docs/FORGEJO_INTEGRATION.md` — User setup guide (this document)

### Modify

- `src/credential-proxy.ts` — Add Forgejo routing and `/git-credentials` endpoint
- `container/Dockerfile` — Install jq, configure git credential helper
- `groups/main/CLAUDE.md` — Add Forgejo integration instructions
- `.env.example` — Add `FORGEJO_URL` and `FORGEJO_TOKEN`
- `CLAUDE.md` (root) — Document Forgejo integration for contributors

### Optional

- `src/ipc.ts` — Add `spawn_coding_agent` task type (only if webhook integration needed)
- `src/config.ts` — Add Forgejo config constants (or keep in credential-proxy for cohesion)
- `docs/SECURITY.md` — Update with Forgejo credential handling

---

## Timeline Estimate

**Phase 1 (Proxy Extension):** 2-3 hours
- Core routing logic: 1 hour
- Error handling: 30 minutes
- Testing: 1 hour
- Documentation: 30 minutes

**Phase 2 (Git Credentials):** 2-3 hours
- Proxy endpoint: 30 minutes
- Credential helper script: 1 hour
- Dockerfile changes + rebuild: 30 minutes
- Testing: 1 hour

**Phase 3 (Agent Instructions):** 1-2 hours
- CLAUDE.md updates: 30 minutes
- Template variable rendering (if needed): 30 minutes
- Testing with real agent: 1 hour

**Phase 4 (Documentation):** 1-2 hours
- User guide: 1 hour
- Root CLAUDE.md updates: 30 minutes
- README updates: 30 minutes

**Phase 5 (Zulip + Forgejo Integration):** 1-2 hours
- Configure Forgejo webhook in Zulip: 30 minutes
- Add PR review API examples to CLAUDE.md: 30 minutes
- Test PR review workflow (create PR, comment, agent responds): 30 minutes
- Documentation: 30 minutes

**Total: 8-13 hours** for full implementation and testing.

---

## Success Criteria

1. ✅ Agent can list Forgejo repositories via API
2. ✅ Agent can clone a repository via git
3. ✅ Agent can create a feature branch and push changes
4. ✅ Agent can create a pull request via API
5. ✅ Agent can complete full workflow (clone → change → push → PR) without manual intervention
6. ✅ Credentials never appear in container filesystem or process list
7. ✅ Git operations work seamlessly (no credential prompts)
8. ✅ Documentation is clear enough for new users to set up without assistance
9. ✅ Error messages are actionable (missing env vars, network issues, auth failures)
10. ✅ Integration works with both localhost and remote Forgejo instances
11. ✅ Forgejo events post to Zulip topics (webhooks configured)
12. ✅ Agent can read and respond to PR review comments
13. ✅ Full PR review cycle works end-to-end (create PR → review → agent responds → push changes)

---

## Future Enhancements

**After initial implementation is stable:**

1. **Per-Group Token Management**
   - Support multiple Forgejo tokens
   - Map groups to specific tokens
   - Enables team-based access control

2. **Repository Whitelisting**
   - Restrict agent access to approved repos only
   - Prevent accidental access to sensitive codebases
   - Implemented via allowlist check in proxy

3. **Forgejo Skills**
   - `/add-forgejo` — Install Forgejo integration as a skill
   - Modular installation for users who want it

4. **Branch Protection Integration**
   - Query Forgejo branch protection rules
   - Warn agent before pushing to protected branches
   - Respect repository policies

5. **Issue Tracking Integration**
   - Create/update Forgejo issues
   - Link commits to issues
   - Auto-close issues on PR merge

6. **Code Review Assistance**
   - Agent autonomously reviews PR diffs
   - Suggests improvements
   - Posts review comments via API

---

## References

- **Forgejo API Docs:** https://forgejo.org/docs/latest/api/
- **Gitea API Docs (compatible):** https://try.gitea.io/api/swagger
- **Git Credential Helpers:** https://git-scm.com/docs/gitcredentials
- **NanoClaw Architecture:** `docs/REQUIREMENTS.md`
- **Container Security:** `docs/SECURITY.md`
- **Credential Proxy Pattern:** `src/credential-proxy.ts`
- **Zulip Integrations:** https://zulip.com/integrations/
- **Zulip Gitea/Forgejo Integration:** https://zulip.com/integrations/doc/gitea
- **Zulip Incoming Webhooks:** https://zulip.com/integrations/doc/incoming-webhooks
