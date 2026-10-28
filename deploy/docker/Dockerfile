# Container recipe for the hosted ultrathink service (services/ultrathink/server.ts).
#
# Build from the repository root:
#   docker build -f deploy/docker/Dockerfile -t ultrathink-web .
#
# Base image: the `1` tag tracks the latest Bun 1.x. package.json requires Bun >=1.2 and .github/workflows/ci.yml runs the
# test matrix on Bun 1.2.x and on the latest release, so any 1.x image is inside what CI exercises.
FROM oven/bun:1

# The runtime has no npm dependencies, so there is no install step. Only the paths the service reads are copied:
# package.json (version), services/ and src/ (code), and the three directories the connector's command catalog is
# built from at start (commands/, skills/, hosts/grok-bot/skills/; see services/ultrathink/mcp/commands.ts). The
# service refuses to start with CATALOG_DRIFT when any of them is missing, so a new catalog source directory in that
# loader needs a COPY line here.
WORKDIR /app
COPY package.json ./
COPY services/ ./services/
COPY src/ ./src/
COPY commands/ ./commands/
COPY skills/ ./skills/
COPY hosts/grok-bot/skills/ ./hosts/grok-bot/skills/

# State (database, OAuth grants, plan journals) lives in one directory owned by the unprivileged user, mode 0700.
# Map a volume onto it; do not bake state or secrets into the image.
ENV ULTRATHINK_STATE_DIR=/var/lib/ultrathink
RUN mkdir -p /var/lib/ultrathink && chown bun:bun /var/lib/ultrathink && chmod 0700 /var/lib/ultrathink
VOLUME /var/lib/ultrathink

USER bun
EXPOSE 8795

# The service listens on 127.0.0.1 only (services/ultrathink/server.ts), so a published port (-p) cannot reach it:
# run the container with the host network (`docker run --network host`, or `network_mode: host` in compose). The check
# below runs inside the container and probes plain HTTP, so it works with ULTRATHINK_PLAINTEXT_LOOPBACK=1. With the
# mTLS listener the service refuses a client without a certificate: override or disable this check in that case.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD ["bun", "-e", "const port = process.env.ULTRATHINK_PORT ?? '8795'; fetch(`http://127.0.0.1:${port}/healthz`).then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1));"]

CMD ["bun", "services/ultrathink/server.ts"]
