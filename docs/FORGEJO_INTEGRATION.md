# Forgejo Integration

Enable NanoClaw agents to interact with your local Forgejo instance via REST API and git operations.

## Overview

NanoClaw's Forgejo integration uses a credential proxy pattern to maintain security isolation:

- **API calls** route through the credential proxy at `host.docker.internal:3001/forgejo/*`
- **Git operations** use a credential helper that fetches tokens from the proxy on-demand
- **Credentials** never enter container filesystems or process environments
- **Agents** can clone repos, create branches, push changes, and create pull requests

## Prerequisites

1. **Forgejo instance** running and accessible from your host machine
2. **NanoClaw** installed and configured
3. **Network access** from containers to Forgejo:
   - Containers automatically use `host.docker.internal` for localhost Forgejo
   - Remote Forgejo should be accessible from containers

## Setup

### 1. Generate Forgejo Access Token

1. Log in to your Forgejo instance
2. Navigate to **Settings** → **Applications** → **Access Tokens**
3. Click **Generate New Token**
4. Give it a descriptive name (e.g., "NanoClaw Agent Access")
5. Select the following permissions:
   - `read:repository` — Read repo data, clone repos
   - `write:repository` — Push changes
   - `read:issue` — Read PRs and issues
   - `write:issue` — Create and update PRs
6. Click **Generate Token**
7. **Copy the token immediately** — you won't be able to see it again

### 2. Configure Environment Variables

Add these variables to your `.env` file in the NanoClaw project root:

```bash
# Forgejo Integration

# Forgejo server URL (no trailing slash)
# Examples:
#   http://localhost:3000        - Forgejo in Docker on same machine
#   https://forgejo.example.com  - Remote Forgejo server
#   https://git.ts.net           - Forgejo via Tailscale
FORGEJO_URL=http://localhost:3000

# Personal access token (paste the token you generated above)
FORGEJO_TOKEN=your_token_here
```

**Configuration notes:**

- **`FORGEJO_URL`**: URL where Forgejo is accessible. The credential proxy uses this to forward API requests. For git operations, containers automatically transform `localhost` → `host.docker.internal`.
- **`FORGEJO_TOKEN`**: The personal access token you generated in step 1.

### 3. Rebuild Container (if needed)

If you haven't rebuilt the container since the Forgejo integration was added:

```bash
./container/build.sh
```

This installs `jq` and the git credential helper in the container image.

### 4. Restart NanoClaw

Restart NanoClaw to load the new environment variables:

```bash
bun run start
```

The credential proxy will start with Forgejo routing enabled.

## Testing

### Test API Access

From your terminal, test that the proxy can reach Forgejo:

```bash
curl http://localhost:3001/forgejo/api/v1/user/repos
```

You should see a JSON list of your repositories.

### Test Agent Access

Ask your main agent:

```
List my Forgejo repositories
```

The agent should use the credential proxy to fetch and display your repos.

### Test Git Operations

Ask your agent to clone a repository:

```
Clone the 'test-repo' repository from Forgejo
```

The agent should successfully clone using the git credential helper.

## Usage Examples

### Create a Pull Request

```
Clone nanoclaw-plugins, create a new feature branch, add a README, and create a PR
```

The agent will:
1. Clone the repo
2. Create a feature branch
3. Add/edit files
4. Commit and push
5. Create a PR via the Forgejo API
6. Report the PR URL for review

### Respond to PR Review Comments

When Forgejo webhooks are configured to post to Zulip (see below), agents can respond to review comments:

```
Address the review comment on PR #42 about handling empty strings
```

The agent will:
1. Fetch the PR and read review comments via API
2. Check out the PR branch
3. Make the requested changes
4. Commit and push
5. Optionally reply to the review comment via API

## Zulip + Forgejo Webhook Integration (Optional)

To enable agents to respond to PR events automatically:

### 1. Configure Forgejo Webhook

You can configure webhooks either manually in the Forgejo UI or programmatically via API.

**Option A: Manual Configuration**

In your Forgejo repository:

1. Go to **Settings** → **Webhooks**
2. Click **Add Webhook** → **Gitea**
3. Set **Payload URL** to your Zulip incoming webhook URL
   - Format: `https://your-zulip.domain/api/v1/external/gitea?api_key=...&stream=STREAM_ID&topic=REPO_NAME`
   - Replace `STREAM_ID` with your Zulip stream ID (numeric, e.g., `6` for the git stream)
   - Replace `REPO_NAME` with your repository name (e.g., `hello-world`) to avoid topic fragmentation
4. Select events to trigger:
   - Pull request opened/closed/edited
   - Pull request review comments
   - Push events (optional)
   - Issue events (optional)
5. Click **Add Webhook**

**Option B: Programmatic Setup (via API)**

Agents can create webhooks programmatically using environment variables:

**Required environment variables:**
- `ZULIP_BASE_URL` — Your Zulip server URL
- `ZULIP_INCOMING_WEBHOOK_API_KEY` — API key for the incoming webhook integration (for Forgejo to post to Zulip)
- `ZULIP_GIT_STREAM_ID` — Numeric stream ID for git events

**Example:**
```bash
curl -X POST "http://host.docker.internal:3001/forgejo/api/v1/repos/OWNER/REPO/hooks" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"gitea\",
    \"active\": true,
    \"config\": {
      "url": "${ZULIP_BASE_URL}/api/v1/external/gitea?api_key=${ZULIP_INCOMING_WEBHOOK_API_KEY}&stream=${ZULIP_GIT_STREAM_ID}&topic=REPO_NAME",
      \"content_type\": \"json\"
    },
    \"events\": [\"push\", \"pull_request\", \"pull_request_review\", \"pull_request_review_comment\", \"issue_comment\"]
  }"
```

### 2. Topic Configuration

By setting `&topic=REPO_NAME` in the webhook URL, all events for that repository will appear in a single topic.

**Example:**
- Webhook URL includes: `&stream=6&topic=hello-world` (where `6` is the git stream ID)
- All events appear in: `#git > hello-world`
- Events include: pushes, PR opened/closed, PR comments, etc.
### 3. Agent Workflow

When a PR review comment is posted:

1. Forgejo sends webhook to Zulip
2. Zulip posts event to topic (e.g., `#git > hello-world`)
3. Agent sees the message in Zulip
4. Agent reads PR details and review comments via Forgejo API
5. Agent makes requested changes, pushes, and replies in Zulip

See [Zulip's Gitea integration docs](https://zulip.com/integrations/doc/gitea) for more details.

## Troubleshooting

### "FORGEJO_URL and FORGEJO_TOKEN must be configured"

**Cause:** Environment variables not loaded.

**Solution:**
1. Verify `.env` contains `FORGEJO_URL` and `FORGEJO_TOKEN`
2. Restart NanoClaw: `bun run start`
3. Check logs for credential proxy startup

### "502 Bad Gateway - Forgejo upstream error"

**Cause:** Proxy can't reach Forgejo at `FORGEJO_URL`.

**Solution:**
1. Verify Forgejo is running: `curl http://localhost:3000` (adjust port)
2. Check `FORGEJO_URL` in `.env` matches Forgejo's actual address
3. If Forgejo uses HTTPS, ensure `FORGEJO_URL` starts with `https://`

### "401 Unauthorized" from Forgejo API

**Cause:** Invalid or expired token.

**Solution:**
1. Verify `FORGEJO_TOKEN` in `.env` is correct
2. Test the token directly:
   ```bash
   curl -H "Authorization: token YOUR_TOKEN" http://localhost:3000/api/v1/user/repos
   ```
3. If invalid, generate a new token in Forgejo settings

### Git clone fails with "Authentication failed"

**Cause:** Git credential helper not working.

**Solution:**
1. Verify container was rebuilt after adding git credential helper:
   ```bash
   ./container/build.sh
   ```
2. Verify `FORGEJO_URL` is configured correctly in `.env`
3. Test credential endpoint:
   ```bash
   # For localhost Forgejo, test with host.docker.internal
   curl -X POST http://localhost:3001/git-credentials \
     -H "Content-Type: application/json" \
     -d '{"host": "host.docker.internal"}'
   
   # For remote Forgejo, test with actual hostname
   curl -X POST http://localhost:3001/git-credentials \
     -H "Content-Type: application/json" \
     -d '{"host": "forgejo.example.com"}'
   ```
   Should return `{"username": "x-token-auth", "password": "..."}`

### Agent can't reach Forgejo via git operations

**Cause:** Git URL not accessible from container network.

**Solution:**
- If Forgejo runs locally (`http://localhost:PORT`), containers should use `http://host.docker.internal:PORT` for git operations
- If Forgejo is remote, containers use the same URL directly
- Test container network access:
  ```bash
  # For localhost Forgejo (port 3000)
  docker run --rm curlimages/curl:latest curl -I http://host.docker.internal:3000
  
  # For remote Forgejo
  docker run --rm curlimages/curl:latest curl -I https://forgejo.example.com
  ```

### Zulip Topic Fragmentation (Multiple Topics per Repository)

**Cause:** Zulip's Gitea integration auto-generates topics from branch/ref names when no `topic` parameter is set in the webhook URL.

**Problem:** Events for the same repository appear in multiple topics:
- `hello-world/main`
- `hello-world/refs/heads/main`
- `hello-world/develop`

**Solution:** Add `&topic=REPO_NAME` to your Forgejo webhook URL to pin all events to a single topic.

**Example:**

Before (fragmented):
```
https://your-zulip.domain/api/v1/external/gitea?api_key=KEY&stream=6
```

After (unified):
```
https://your-zulip.domain/api/v1/external/gitea?api_key=KEY&stream=6&topic=hello-world
```

All push events, PR events, and review comments for the `hello-world` repository will now appear in `#git > hello-world`.

**Per-repository setup:**
- Set the webhook at the repository level (not organization level)
- Use the repository name as the topic
- Example: For repo `myproject`, use `&topic=myproject`

## Security Model

### Credential Isolation

- `FORGEJO_TOKEN` lives only in host `.env` (never mounted, never in container `process.env`)
- Proxy reads token via `readEnvFile()` (same pattern as Anthropic credentials)
- Containers make API calls via proxy URL: `http://host.docker.internal:3001/forgejo/*`
- Proxy injects `Authorization: token <FORGEJO_TOKEN>` header before forwarding to Forgejo
- Git credential helper fetches credentials from proxy on-demand, never stores them

### Network Isolation

- Containers can only reach Forgejo via:
  1. **API**: Through credential proxy (credentials injected)
  2. **Git**: Direct to Forgejo URL (credentials from helper)
- No direct credential access possible from containers

### Repository Access Control

- All agents share the same `FORGEJO_TOKEN` (single global token)
- Token has access to all repositories the token owner can access
- **Future enhancement**: Per-group tokens for team-based access control

## API Reference

### Forgejo API Endpoints

All API calls are prefixed with `http://host.docker.internal:3001/forgejo`.

**List user repositories:**
```bash
GET /api/v1/user/repos
```

**Get repository details:**
```bash
GET /api/v1/repos/{owner}/{repo}
```

**List pull requests:**
```bash
GET /api/v1/repos/{owner}/{repo}/pulls
```

**Get PR details:**
```bash
GET /api/v1/repos/{owner}/{repo}/pulls/{index}
```

**Create pull request:**
```bash
POST /api/v1/repos/{owner}/{repo}/pulls
{
  "title": "Feature: Description",
  "head": "feature-branch",
  "base": "main",
  "body": "PR description"
}
```

**List PR reviews:**
```bash
GET /api/v1/repos/{owner}/{repo}/pulls/{index}/reviews
```

**Reply to review comment:**
```bash
POST /api/v1/repos/{owner}/{repo}/pulls/{index}/reviews/{review_id}/comments
{
  "body": "Reply text"
}
```

Full API documentation: https://try.gitea.io/api/swagger (Forgejo is Gitea-compatible)

## Files Modified

This integration touches the following NanoClaw files:

- `src/credential-proxy.ts` — Forgejo routing and git credentials endpoint
- `container/Dockerfile` — Install jq, configure git credential helper
- `container/git-credential-helper.sh` — Git credential helper script
- `groups/main/CLAUDE.md` — Agent instructions for Forgejo integration
- `.env.example` — Forgejo configuration variables

## Future Enhancements

See the [Forgejo Integration Plan](FORGEJO_INTEGRATION_PLAN.md) for planned improvements:

- Per-group token management
- Repository whitelisting
- Branch protection integration
- Issue tracking integration
- Autonomous code review assistance

## References

- [Forgejo API Documentation](https://forgejo.org/docs/latest/api/)
- [Gitea API Documentation](https://try.gitea.io/api/swagger) (compatible)
- [Git Credential Helpers](https://git-scm.com/docs/gitcredentials)
- [Zulip Gitea Integration](https://zulip.com/integrations/doc/gitea)
