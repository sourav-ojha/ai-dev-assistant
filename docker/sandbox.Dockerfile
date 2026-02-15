FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash sandbox
USER sandbox
WORKDIR /workspace

# No secrets. No host access. Read-only except /workspace.
