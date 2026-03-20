# Forgejo CLI Reference

Complete command reference for the `forgejo` script — the unified interface for all Forgejo operations.

## Repository Operations

### `forgejo repo create <name> [--description "..."]`
Creates a public repository with README and MIT license.
- Automatically adds `gergely` as admin collaborator
- Automatically sets up Zulip webhook for the repository
- If collaborator/webhook setup fails, warns but does not rollback repo creation

### `forgejo repo info <name>`
Shows repository details:
- Name
- URL
- Description
- Default branch

### `forgejo repo list`
Lists all repositories for the authenticated user.

### `forgejo repo import <source-url> <new-repo-name> [--description "..."]`
Imports an external repository (GitHub, Codeberg, etc.) into Forgejo:
- Clones the source repository
- Creates a new Forgejo repository with the specified name
- Sets up remotes (preserves original as `upstream`, adds Forgejo as `origin`)
- Pushes all branches and tags to Forgejo
- Automatically adds `gergely` as admin collaborator
- Automatically sets up Zulip webhook


### `forgejo repo clone <repo-or-url>`
Clones a repository:
- `vanek/myrepo` — clones from Forgejo
- `https://github.com/user/repo` — clones from external source (GitHub, Codeberg, etc.)

Uses credential helper for Forgejo repos, HTTPS for external repos.
---

## Code Operations

### `forgejo push <branch>`
Pushes the specified branch from current directory to remote.
- Automatically sets up remote tracking
- Must be run from within a git repository

### `forgejo switch <branch>`
Switches to a branch, creating it if necessary:
- If branch exists locally: switches to it
- If branch exists only on remote: creates local tracking branch
- If branch doesn't exist: creates it from current HEAD and pushes to remote

### `forgejo tag create <tag-name> [message]`
Creates an annotated tag from current HEAD and pushes to remote.


---

## Git Workflow

### `forgejo status`
Shows the working tree status (modified, staged, untracked files).

### `forgejo diff [file]`
Shows changes in the working directory.
- Without arguments: shows all changes
- With file argument: shows changes for specific file

### `forgejo add <files...>`
Stages files for commit.
- `forgejo add .` — stages all changes
- `forgejo add file1.py file2.py` — stages specific files

### `forgejo commit <message>`
Creates a commit with the staged changes.

### `forgejo log [--limit N]`
Shows commit history.
- Without arguments: shows recent commits (default limit)
- `--limit N`: shows last N commits
---

## Pull Request Operations

### `forgejo pr create --title "..." [--head <branch>] [--base <branch>] [--body "..."]`
Creates a pull request in the current repository.

Defaults:
- `--head`: current branch
- `--base`: repository's default branch

### `forgejo pr list [--state open|closed|all]`
Lists pull requests in the current repository.

### `forgejo pr show <number>`
Shows full PR details:
- Title, body, state, author
- Head and base branches
- Commits
- Changed files
- Comments

### `forgejo pr comment <number> <message>`
Adds a comment to the specified pull request.

### `forgejo pr merge <number>`
Merges the pull request using squash merge.

### `forgejo pr close <number>`
Closes the pull request without merging.

### `forgejo pr checkout <number>`
Checks out the pull request's head branch locally for testing.

---

## Issue Operations

### `forgejo issue create --title "..." [--body "..."] [--labels label1,label2]`
Creates a new issue in the current repository.

### `forgejo issue update <number> [--title "..."] [--body "..."] [--labels label1,label2]`
Updates an existing issue. All fields are optional — only provided fields are updated.

### `forgejo issue list [--state open|closed|all]`
Lists issues in the current repository.

### `forgejo issue show <number>`
Shows full issue details.

### `forgejo issue comment <number> <message>`
Adds a comment to the specified issue.

### `forgejo issue close <number>`
Closes the issue.

---

## General

### `forgejo --help`
Shows all available commands.

### `forgejo <command> --help`
Shows help for a specific command.
