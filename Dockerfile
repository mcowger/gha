FROM --platform=$BUILDPLATFORM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

FROM --platform=$TARGETPLATFORM oven/bun:1
WORKDIR /app
COPY --from=build /app /app

# output/ (reports served over HTTP) and state/ (reviewed-video tracking)
# persist across container restarts via these volumes. Named volumes are
# seeded from the image's baked-in output/ directory on first creation.
VOLUME /app/output
VOLUME /app/state

ENV STATE_FILE=/app/state/reviewed.json
ENV OUTPUT_DIR=/app/output
ENV PORT=8080

EXPOSE 8080

ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD []
