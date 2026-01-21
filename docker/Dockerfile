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
    iptables \
    ca-certificates \
    curl \
    git \
    sudo \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install mitmproxy
RUN python3 -m venv /opt/mitmproxy-venv && \
    /opt/mitmproxy-venv/bin/pip install mitmproxy

# Add mitmproxy to PATH
ENV PATH="/opt/mitmproxy-venv/bin:$PATH"

# Install Claude CLI and GitHub Copilot CLI globally
RUN npm install -g @anthropic-ai/claude-code @github/copilot

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

# Copy proxy configuration
COPY docker/proxy/filter.py /app/proxy/filter.py
COPY docker/whitelist.json /app/whitelist.json
COPY docker/entrypoint.sh /app/entrypoint.sh

# Make entrypoint executable
RUN chmod +x /app/entrypoint.sh

# Create workspace and log directories with correct ownership
RUN mkdir -p /workspace /var/log/proxy && \
    chown -R agent:agent /workspace /var/log/proxy /app

# Expose RemoteAgent port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV DOCKER_MODE=true
ENV WORKSPACE_PATH=/workspace
ENV HOME=/home/agent

# Use entrypoint script
ENTRYPOINT ["/app/entrypoint.sh"]
