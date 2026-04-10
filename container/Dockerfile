# NanoClaw Agent Container
# Runs Claude Code CLI in isolated Linux VM with browser automation
#
# Browser: Playwright chromium-headless-shell (~36% smaller than full Chromium;
#   no GUI components, PDF viewer, or fonts we don't need for headless automation).
#   System libs are installed automatically by --with-deps, replacing the prior
#   manual apt block of ~15 packages.

FROM node:24-slim

# Install system dependencies for git, utilities, and language toolchains (Erlang, Ruby, Rust, Go)
RUN apt-get update && apt-get install -y \
    curl \
    git \
    jq \
    build-essential \
    autoconf \
    pkg-config \
    libncurses-dev \
    libssl-dev \
    libssh-dev \
    libyaml-dev \
    libreadline-dev \
    libffi-dev \
    libgdbm-dev \
    && rm -rf /var/lib/apt/lists/*

# Install mise for package management
RUN curl https://mise.run | sh && \
    chmod a+x /root /root/.local /root/.local/bin && \
    chmod a+rX /root/.local/bin/mise && \
    ln -s /root/.local/bin/mise /usr/local/bin/mise

# Create mise directories for node user
RUN mkdir -p /home/node/.local/share/mise /home/node/.local/state/mise /home/node/.local/config/mise && \
    chown -R node:node /home/node/.local
# Configure mise to store config inside ~/.local (for persistence)
ENV MISE_CONFIG_DIR=/home/node/.local/config/mise

# Configure git credential helper and forgejo CLI for Forgejo integration
COPY scripts/git-credential-helper.sh /usr/local/bin/git-credential-helper.sh
COPY scripts/forgejo /usr/local/bin/forgejo
RUN chmod +x /usr/local/bin/git-credential-helper.sh /usr/local/bin/forgejo && \
    git config --system credential.helper /usr/local/bin/git-credential-helper.sh

# Install agent-browser and claude-code globally.
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 prevents playwright from auto-downloading a full
# Chromium during npm install — we install only the headless shell in the next step.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Install Playwright's chromium-headless-shell into a shared directory.
# --with-deps auto-installs required system libraries (replaces the manual lib list).
# chromium-headless-shell omits the full GUI browser binary (~36% size reduction).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0
RUN npx playwright install chromium-headless-shell --with-deps && \
    SHELL_BIN=$(find /ms-playwright -name 'headless_shell' -type f | head -1) && \
    echo "chromium-headless-shell: $SHELL_BIN" && \
    ln -sf "$SHELL_BIN" /usr/local/bin/chromium-headless-shell

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium-headless-shell
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/local/bin/chromium-headless-shell

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\nexport PATH=/workspace/scripts:$PATH\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nexec node /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
