#!/bin/bash
# Git credential helper that fetches credentials from the credential proxy
# Git credential helper protocol: https://git-scm.com/docs/gitcredentials
#
# This script is called by git when authentication is needed. It communicates
# with the credential proxy running on the host to get Forgejo credentials.

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
