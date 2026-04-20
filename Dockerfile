FROM --platform=linux/amd64 oven/bun:1

WORKDIR /app

# Install git for push
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy dependency files first for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Default: run once and exit. Override with "daemon" for cron mode.
# In daemon mode, set CRON_SCHEDULE env var (e.g. "0 */6 * * *")
ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD []
