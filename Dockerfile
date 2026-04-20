FROM --platform=$BUILDPLATFORM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

FROM --platform=$TARGETPLATFORM oven/bun:1
WORKDIR /app
COPY --from=build /app /app
ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD []
