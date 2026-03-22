# Forgejo CLI Setup

The `forgejo` command is now integrated into NanoClaw agent containers.

## Installation

The `forgejo` script is automatically installed when you build the agent container:

```bash
./container/build.sh
```

Once built, the `forgejo` command will be available in all agent containers at `/usr/local/bin/forgejo`.

## Verification

After rebuilding and starting an agent, verify the `forgejo` command is available:

```
forgejo --help
```

You should see the full command reference.

## Updating Agent Instructions

The agent instructions in `groups/main/CLAUDE.md` have been updated to use the `forgejo` command exclusively.

Agents will now:
- Use `forgejo` for all repository operations
- Use `forgejo` for all git operations (no raw `git` commands)
- Use `forgejo` for all API calls (no raw `curl` commands)
- Have automatic credential handling (no manual token management)

## Testing

To test the integration with a live agent:

1. Rebuild the container: `./container/build.sh`
2. Start NanoClaw: `bun run start`
3. Ask your agent: "List my Forgejo repositories"
4. The agent should use `forgejo repo list` and show your repos

## Troubleshooting

If the `forgejo` command is not found:
- Ensure you rebuilt the container after adding the script
- Verify `/usr/local/bin/forgejo` exists in the container
- Check the container build logs for errors

If API calls fail:
- Verify `FORGEJO_URL` is set in `.env`
- Verify `FORGEJO_TOKEN` is set in `.env`
- Ensure the credential proxy is running (starts with NanoClaw)
- Check proxy logs: container output will show credential proxy status
