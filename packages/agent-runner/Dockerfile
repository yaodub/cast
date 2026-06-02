# Cast Agent Container
# Runs Claude Agent SDK in isolated Linux VM

FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    iptables \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install claude-code globally
RUN npm install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code — must be explicit, NOT `COPY . ./`.
# pnpm's symlinked node_modules collides with the npm install layer's real
# directories, causing "cannot replace to directory with file" in buildkit.
COPY src ./src
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Create mount-point directories
RUN mkdir -p /home/agent /identity /memory /staging/in /staging/out

# Create entrypoint script
# Starts as root to apply iptables firewall rules, then drops to node user.
# CAST_NETWORK controls the policy: "sdk-only" (default) allows only Anthropic
# API endpoints; "full" skips firewall; "none" blocks all egress.
# Stdin stays open: host sends newline-delimited JSON (init, messages, close, secrets).
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Egress reconciler — host drives it via `container exec` to refresh the
# CAST_EGRESS chain + /etc/hosts pins live (see entrypoint.sh / egress-controller.ts).
COPY update-egress.sh /app/update-egress.sh
RUN chmod +x /app/update-egress.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /home/agent /memory /staging

# Set working directory to agent home
WORKDIR /home/agent

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
