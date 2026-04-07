---
name: find-agent-skill
description: Search for a skill to install for container agents. Searches skills.sh and GitHub by description or domain, presents options, and installs the chosen skill via add-agent-skill. Use when the user describes what they want rather than providing a specific URL.
allowed-tools: Bash, WebFetch, WebSearch, AskUserQuestion
---

# Find Agent Skill

Searches for a skill that matches what the user wants, then installs it into `groups/global/skills/` (or a specific group) via `/add-agent-skill`.

---

## Step 1: Understand the need

Extract the domain and task from the user's description. Examples:
- "something for SQL" → domain: databases, task: SQL query writing
- "compress my responses" → domain: output, task: token reduction
- "web scraping" → domain: web, task: data extraction

---

## Step 2: Search skills.sh

Fetch `https://skills.sh/?q={encoded_query}` using WebFetch.

Also browse the homepage for categories: `https://skills.sh/`

Extract skill results: name, description, install count, source URL.

---

## Step 3: Fallback search

If skills.sh yields fewer than 2 relevant results, use WebSearch:

```
WebSearch: "claude code agent skill {description} site:github.com SKILL.md"
```

Supplement with: `"npx skills find {description}" claude code`

---

## Step 4: Present options

Show 2–4 results. For each:
- Name and one-line description
- Install count if available (prefer 1K+ installs)
- Source (trusted sources: vercel-labs, anthropics, microsoft)
- GitHub URL

Use `AskUserQuestion` (single-select) with:
- One option per skill
- "None of these — describe differently" 
- "Create from scratch based on my description"

---

## Step 5: Install or iterate

**If a skill is selected:** invoke `/add-agent-skill {url}` with the skill's GitHub URL (plus any target group the user specified).

**If "describe differently":** ask for a refined description, go back to Step 2.

**If "create from scratch":** describe what you'll synthesize, confirm with the user, then invoke `/add-agent-skill {description}` — add-agent-skill handles synthesis.
