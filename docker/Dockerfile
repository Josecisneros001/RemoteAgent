FROM node:20-slim

# Build arguments for user creation (match host user for volume permissions)
ARG HOST_UID=1000
ARG HOST_GID=1000

# Modify existing node user to match host UID/GID (node image already has UID/GID 1000)
# If running as root (UID=0), skip user modification and just rename
# If different UID/GID needed, modify the existing user
RUN if [ "$HOST_UID" = "0" ]; then \
        # Running as root - just rename the node user/group without changing IDs
        usermod -l agent -d /home/agent -m node && \
        groupmod -n agent node; \
    else \
        if [ "$HOST_UID" != "1000" ] || [ "$HOST_GID" != "1000" ]; then \
            groupmod -g $HOST_GID node && \
            usermod -u $HOST_UID -g $HOST_GID node; \
        fi && \
        usermod -l agent -d /home/agent -m node && \
        groupmod -n agent node; \
    fi

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    dnsmasq \
    inotify-tools \
    iproute2 \
    dnsutils \
    jq \
    iptables \
    ca-certificates \
    curl \
    git \
    sudo \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI and GitHub Copilot CLI globally
RUN npm install -g @anthropic-ai/claude-code @github/copilot

# Install Microsoft Dev Tunnels CLI
RUN curl -sL https://aka.ms/DevTunnelCliInstall | bash

# Create app directory
WORKDIR /app

# Copy package files for both server and client
COPY package*.json ./
COPY src/client/package*.json ./src/client/

# Install all dependencies (including dev dependencies needed for build)
RUN npm ci

# Install client dependencies
RUN cd src/client && npm ci

# Copy application source
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies after build to reduce image size
RUN npm prune --production && cd src/client && npm prune --production

# Copy DNS configuration and entrypoint
COPY docker/dns/generate-dnsmasq.sh /app/dns/generate-dnsmasq.sh
COPY docker/dns/show-blocked.sh /app/dns/show-blocked.sh
COPY docker/allowlist.json /app/allowlist.json
COPY docker/entrypoint.sh /app/entrypoint.sh

# Convert Windows line endings (CRLF) to Unix (LF) for shell scripts
# This ensures scripts work regardless of host OS
RUN sed -i 's/\r$//' /app/entrypoint.sh /app/dns/generate-dnsmasq.sh /app/dns/show-blocked.sh

# Make scripts executable
RUN chmod +x /app/entrypoint.sh /app/dns/generate-dnsmasq.sh /app/dns/show-blocked.sh

# Create workspace and log directories with correct ownership
RUN mkdir -p /workspace /var/log/dns /etc/dnsmasq.d && \
    chown -R agent:agent /workspace /var/log/dns /app

# Expose RemoteAgent port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV DOCKER_MODE=true
ENV WORKSPACE_PATH=/workspace
ENV HOME=/home/agent

# Use entrypoint script
ENTRYPOINT ["/app/entrypoint.sh"]
