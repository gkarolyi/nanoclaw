# NanoClaw Agent Container
# Runs Claude Code CLI in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium and git credential helper
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

# Install mise for package management
RUN curl https://mise.run | sh && \
    chmod a+x /root /root/.local /root/.local/bin && \
    chmod a+rX /root/.local/bin/mise && \
    ln -s /root/.local/bin/mise /usr/local/bin/mise && \
    echo 'eval "$(/usr/local/bin/mise activate bash)"' > /etc/mise.sh && \
    echo 'source /etc/mise.sh' >> /etc/bash.bashrc

# Source mise activation for non-interactive shells
ENV BASH_ENV=/etc/mise.sh

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Configure git credential helper and forgejo CLI for Forgejo integration
COPY scripts/git-credential-helper.sh /usr/local/bin/git-credential-helper.sh
COPY scripts/forgejo /usr/local/bin/forgejo
RUN chmod +x /usr/local/bin/git-credential-helper.sh /usr/local/bin/forgejo && \
    git config --system credential.helper /usr/local/bin/git-credential-helper.sh

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

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
