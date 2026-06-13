FROM docker/sandbox-templates:shell-docker

# Switch to root for system-wide installs
USER root

# Install system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    jq \
    gh \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install uv (Python package manager) to /usr/local/bin
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Install Node.js 24 via n (simple Node version manager)
RUN npm install -g n && n 24 && hash -r

# Install pnpm 11
RUN npm install -g pnpm@11

# Install rtk binary
RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh

# Install pi globally
RUN npm install -g @earendil-works/pi-coding-agent

# Switch to agent user (uid 1000)
USER 1000
WORKDIR /home/agent
