---
name: add-agent-skill
description: Install a skill for container agents from a known URL or GitHub repo. Skills land in groups/global/skills/ (all agents) or groups/{folder}/skills/ (one agent only) and are picked up on the next message with no rebuild or restart needed. If the user has a description rather than a URL, use find-agent-skill instead.
allowed-tools: Bash, Read, Write, WebFetch, AskUserQuestion
---

# Add Agent Skill

Installs a skill for container agents from a known URL or GitHub repo. Unlike skills in `.claude/skills/` (for the main nanoclaw agent), these go into `groups/global/skills/` or `groups/{folder}/skills/` and are picked up on the next container spawn — no rebuild or restart required.

If the user doesn't have a specific URL and wants to search or browse, use `/find-agent-skill` instead.

## Skill locations

| Path | Scope |
|------|-------|
| `groups/global/skills/{name}/` | All agents (default) |
| `groups/{folder}/skills/{name}/` | One specific group only |

---

## Step 1: Fetch the SKILL.md

Try in order (WebFetch each, stop at first valid result with frontmatter or skill content):

For `https://github.com/{owner}/{repo}` or shorthand `owner/repo`:
1. `https://raw.githubusercontent.com/{owner}/{repo}/main/SKILL.md`
2. `https://raw.githubusercontent.com/{owner}/{repo}/main/skill.md`
3. `https://raw.githubusercontent.com/{owner}/{repo}/main/.claude/skills/{repo}/SKILL.md`
4. `https://raw.githubusercontent.com/{owner}/{repo}/master/SKILL.md`

For a direct raw URL: fetch it directly.

If no SKILL.md found: fetch the README (`/main/README.md`) and synthesize a SKILL.md (see **Synthesizing** below).

---

## Step 2: Determine skill name

1. Use `name:` from frontmatter if present
2. Otherwise: last path segment of the repo URL, lowercased, hyphens for spaces

---

## Step 3: Determine install target

User specified a group → `groups/{folder}/skills/{name}/`  
Otherwise → `groups/global/skills/{name}/`

Check if already installed:
```bash
ls groups/global/skills/{name}/ 2>/dev/null
```
If yes, ask whether to overwrite.

---

## Step 4: Install

```bash
mkdir -p groups/global/skills/{name}
```

Write the SKILL.md to `groups/global/skills/{name}/SKILL.md`.

Confirm:
1. Install path
2. How to invoke the skill (extract from SKILL.md)
3. "Takes effect on the next message to that agent — no restart needed"

---

## Synthesizing a SKILL.md

When no ready-made SKILL.md exists, write one from the README or description:

```
---
name: {name}
description: {one sentence — what it does and when to invoke it}
allowed-tools: {tools actually needed — omit entirely for behavioral/instructional skills}
---

# {Name}

{What this skill does — 1-2 sentences}

## Usage

{How to invoke: slash command, trigger phrase, keywords}

## {Key workflow or reference}

{Concrete steps or examples}
```

Guidelines:
- Omit `allowed-tools` for purely behavioral skills (like caveman — no tools needed)
- Preserve invocation patterns from source (slash commands, natural language triggers)
- If a CLI tool is required, include installation: `npm install -g {tool}` or `mise use -g {lang}@version`

---

## Available group folders

To check existing groups for per-group installs:
```bash
ls groups/
```
