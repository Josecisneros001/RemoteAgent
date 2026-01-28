FROM node:20-slim

# Build arguments for user creation (match host user for volume permissions)
ARG HOST_UID=1000
ARG HOST_GID=1000

# Modify existing node user to match host UID/GID (node image already has UID/GID 1000)
# If different UID/GID needed, modify the existing user
RUN if [ "$HOST_UID" != "1000" ] || [ "$HOST_GID" != "1000" ]; then \
        groupmod -g $HOST_GID node && \
        usermod -u $HOST_UID -g $HOST_GID node; \
    fi && \
    usermod -l agent -d /home/agent -m node && \
    groupmod -n agent node

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

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application source
COPY . .

# Build the application
RUN npm run build

# Copy DNS configuration and entrypoint
COPY docker/dns/generate-dnsmasq.sh /app/dns/generate-dnsmasq.sh
COPY docker/dns/show-blocked.sh /app/dns/show-blocked.sh
COPY docker/allowlist.json /app/allowlist.json
COPY docker/entrypoint.sh /app/entrypoint.sh

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
