#!/bin/bash
# Reload agent instructions by stopping all running agent containers
# This forces NanoClaw to spawn fresh containers with updated CLAUDE.md

set -euo pipefail

echo "Checking for running agent containers..."
RUNNING=$(docker ps --filter "ancestor=nanoclaw-agent:latest" -q)

if [ -z "$RUNNING" ]; then
    echo "No agent containers are currently running."
    echo "Next agent invocation will use updated instructions."
    exit 0
fi

COUNT=$(echo "$RUNNING" | wc -l)
echo "Found $COUNT running agent container(s):"
docker ps --filter "ancestor=nanoclaw-agent:latest" --format "  {{.ID}} (created {{.CreatedAt}})"

echo ""
read -p "Stop these containers to reload instructions? [y/N] " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Stopping agent containers..."
    echo "$RUNNING" | xargs docker stop
    echo "Done! Next agent invocation will use updated instructions."
else
    echo "Cancelled. Containers still running with old instructions."
    exit 1
fi
