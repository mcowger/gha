FROM --platform=$BUILDPLATFORM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

FROM --platform=$TARGETPLATFORM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD []
