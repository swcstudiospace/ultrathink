# Self-host the ultrathink hosted service

This guide runs the hosted ultrathink service (`services/ultrathink/server.ts`: the `/mcp` endpoint, OAuth, the owner login, `/healthz` and `/readyz`) on a machine you control, with variables you supply. For the chat-client side, see [Use /ultrathink in Claude, Claude Code and Grok Chat](use-ultrathink-in-chat.md). For the operator's day-two work on the reference deployment (releases, backups, rotation, incident triage), see the [runbook](../ops/runbook-ultrathink.md). For where each variable goes, see [Bring your own variables](bring-your-own-variables.md).

**Status: run end to end by the author on one Linux host, not by a stranger.** Every command in steps 4, 5, 6, 9 and 11 was run with throwaway secrets on loopback and behaved as written: the config check, the smoke script, the container build and run, and the compose path. A production install with mTLS, a reverse proxy and systemd was not repeated for this guide, and every step that depends on one is marked *not verified*. See [What is not verified](#what-is-not-verified).

## What you are running

The hosted service is **single-tenant by design**: one owner password, one Claude plan login, and the Jev decision gate off. Anyone who knows the owner password can connect a client, and every connected client shares that one owner's planning budget. There are no accounts, no per-user keys and no billing. A multi-user hosted service with per-user keys is not provided. If several people want ultrathink, each of them runs their own instance of this service, their own [stdio connector](use-ultrathink-in-chat.md#local-stdio) or the plugin, with their own variables.

Planning on the server is **off by default**. With it off, the service lists no `ultrathink_uplift` tool, makes no model call and the chat client's own model does the thinking (client-driven mode). Step 7 says what turns it on.

## 1. Get the code and Bun

1. Install Bun 1.2 or later (`engines.bun` in `package.json` is `>=1.2`; CI runs the tests on Bun 1.2.x and on the latest release). See [bun.sh](https://bun.sh).
2. Clone the repository and stay in its root for every command below:

   ```bash
   git clone https://github.com/swcstudiospace/claude-ultrathink.git
   cd claude-ultrathink
   bun --version
   ```

The service has no npm dependencies, so there is no install step.

## 2. Set the three required variables

The service refuses to start, and names the variable, when any of these is missing or invalid. Generate each value yourself; nothing in this repository is a usable default.

| Variable | What it is | How to make it |
|---|---|---|
| `ULTRATHINK_PUBLIC_ORIGIN` | The origin clients reach, with scheme and optional port and nothing else: no path, query, fragment or credentials. It must be `https://`; `http://` is accepted only for `localhost` and `127.0.0.1`. | You choose it, for example `https://<your-host>`. |
| `ULTRATHINK_OWNER_PASSWORD_HASH` | An argon2id (or bcrypt) hash of the owner password, as `Bun.password.hash` writes it. The consent page checks the password you type against it. | The command below. |
| `ULTRATHINK_SESSION_SECRET` | Secret that signs web login sessions. At least 32 characters. | `openssl rand -hex 32` |

Make the hash with a prompt, so the password never lands in shell history or in `ps`:

```bash
read -rs -p 'Owner password: ' UT_PW; echo
UT_PW="$UT_PW" bun -e 'console.log(await Bun.password.hash(process.env.UT_PW, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 }))'
unset UT_PW
```

The output starts with `$argon2id$`. **Do not let a shell expand it.** Its `$` segments look like variable names: in an unquoted shell assignment, a double-quoted string, or a compose `environment:` entry they are silently dropped, and the service then stops with "must be an argon2 or bcrypt hash ... check that no '$' segment was shell-expanded". Put it in the env file below, not on a command line.

Write the variables to a file that only you can read:

```bash
umask 077
cat > ultrathink.env <<'EOF'
ULTRATHINK_PUBLIC_ORIGIN=<your-origin>
ULTRATHINK_OWNER_PASSWORD_HASH=<paste-the-argon2id-hash>
ULTRATHINK_SESSION_SECRET=<paste-the-64-character-secret>
EOF
ls -l ultrathink.env
```

`ls -l` must show `-rw-------`. The file holds secrets: keep it out of git, out of backups you do not control and out of any container build context. Never echo or print the hash or the secret. To rotate any of them later, follow [runbook section 6](../ops/runbook-ultrathink.md#6-secret-rotation).

Lines are literal `NAME=value`, which is what systemd's `EnvironmentFile` reads. For a foreground run from a shell, load the file without letting the shell touch the `$` characters:

```bash
while IFS= read -r line; do case $line in ''|'#'*) ;; *) export "$line" ;; esac; done < ultrathink.env
```

## 3. Choose how it listens: TLS or the loopback opt-in

The service never listens in plaintext by accident. It needs exactly one of these:

- **TLS, all or none.** Set all three of `ULTRATHINK_TLS_CERT`, `ULTRATHINK_TLS_KEY` and `ULTRATHINK_TLS_CLIENT_CA`, each an absolute path to a readable file, or none of them. One or two of the three is a start-up error even with the opt-in below. With them set, the listener on `127.0.0.1` is **mutual TLS**: a client that does not present a certificate chaining to `ULTRATHINK_TLS_CLIENT_CA` is refused at the handshake, so browsers and chat clients cannot reach it directly. The intended shape is a reverse proxy in front that terminates public TLS and presents a client certificate to the service. The reference deployment's proxy is `deploy/nginx-ultrathink.swcstudio.space.conf`, and its certificates are made by `deploy/ultrathink-pki.sh` (see [runbook section 17](../ops/runbook-ultrathink.md#17-internal-tls-and-identity)). *Not verified:* a fresh install of this shape by someone other than the maintainers.
- **Loopback opt-in.** `ULTRATHINK_PLAINTEXT_LOOPBACK=1` runs a plaintext listener on `127.0.0.1` only. It is for development and local smoke tests, not for production. Flags take exactly `1` or `0`; any other value is a start-up error.

For a first run on your own machine, add the opt-in and a loopback origin to the env file:

```bash
printf '%s\n' 'ULTRATHINK_PLAINTEXT_LOOPBACK=1' >> ultrathink.env
```

and set `ULTRATHINK_PUBLIC_ORIGIN=http://127.0.0.1:8795` in it. The port is `ULTRATHINK_PORT` (default `8795`, 1024 to 65535). The listener always binds `127.0.0.1`: to serve other machines, put a reverse proxy on this host in front of it.

State goes to `ULTRATHINK_STATE_DIR`, default `/var/lib/ultrathink`. Unless you run as a user that can create that path, set `ULTRATHINK_STATE_DIR` to a directory you own, for example `<path-to-state-directory>`. The service keeps its database, OAuth grants and plan journals there, and they contain your prompts.

## 4. Check the configuration without starting the service

```bash
bun services/ultrathink/server.ts --check-config
```

The flag parses and validates every variable, prints `config ok` and exits 0, or prints one block that starts `ultrathink: N configuration problems` with one line per problem and exits 1. It binds no port and opens no store, and no line contains a secret value. It exists since v1.20; on an older checkout the same command starts the service instead of checking, so use step 5 there. Observed: with an origin that is not a URL, a short session secret, port 80 and no owner hash it printed `ultrathink: 5 configuration problems` (the secret's value was not in the output) and exited 1; with a valid environment it printed `config ok`, exited 0 and bound nothing.

## 5. Start it

```bash
bun services/ultrathink/server.ts
```

A good start logs one JSON line with `"event":"listening"` and the port. `SIGTERM` or `SIGINT` drains: `/readyz` starts failing at once, the service waits `ULTRATHINK_DRAIN_MS` (default 5000), stops accepting requests, aborts running plans, closes the store and exits 0.

## 6. Check `/healthz` and `/readyz`

| Route | Meaning | Healthy answer |
|---|---|---|
| `/healthz` | The process is up. Use it for liveness. It keeps answering while the service drains. | `200` |
| `/readyz` | The service can do its work. Use it for load-balancer readiness. | `200` with `{"status":"ready","checks":{...}}`; otherwise `503` with `failed` naming the checks that did not pass |

`/readyz` reports six checks, all of which must be true: `store` (the database answers), `stateDir` (the state directory is writable), `oauth` (the OAuth file is readable, or absent on a fresh install), `planner` (true when planning is off, or when it is on and the `claude` login is usable), `integrity` (the database's integrity check has not failed) and `draining` (false once shutdown has begun).

On the loopback opt-in:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8795/healthz
curl -s http://127.0.0.1:8795/readyz
```

With TLS configured the listener wants a client certificate, so add `--cacert`, `--cert` and `--key` for a certificate your CA issued, as in [runbook section 7](../ops/runbook-ultrathink.md#7-incident-triage).

## 7. Turn planning on (optional)

Leave planning off if you want the chat client's own model to do the thinking: that costs nothing on the server. To make the server plan:

1. Set `ULTRATHINK_SERVER_PLANNING=1`. Unset or `0` means off.
2. Install the `claude` CLI for the user that runs the service and log it in with that user's **own Claude plan**. The planner runs each model call as a `claude -p` child process, so a plan draws that plan's usage limits; there is no per-token bill and no OpenRouter path. See [runbook section 12a](../ops/runbook-ultrathink.md#12a-plan-backend-coding-plan-inference) for the login and its token.
3. Optionally set `ULTRATHINK_PLANNING_MODEL` (a Claude model id; an id containing `/` stops the service at start) and `ULTRATHINK_PLANNING_FALLBACK=grok` for a Grok Build fallback with its own login.

Restart, then check that `/readyz` still reports `planner: true`. *Not verified:* a server-side plan on a host that is not the maintainers' own.

This is also where the single-tenant rule bites: one plan login serves every client that gets past the owner password. Do not share the password with people you would not share that plan with.

## 8. Put it behind TLS and a service manager

The repository carries the reference deployment as files you can read and adapt. This guide names them and does not copy them, because their contents are specific to one host:

- `deploy/ultrathink-web.service`: the systemd unit (unprivileged `ultrathink` user, sandbox settings, `EnvironmentFile=/etc/ultrathink/ultrathink.env`, a 30 second stop timeout for the drain).
- `deploy/nginx-ultrathink.swcstudio.space.conf`: the nginx virtual host. It is written for that domain and for Cloudflare in front of it (peer allow-list, client-address header); change the domain, the certificate paths and the Cloudflare parts to match yours.

The first-install order is in [runbook section 2](../ops/runbook-ultrathink.md#2-first-install). *Not verified:* installing these files on a host that is not the reference VPS.

## 9. Prove it works with the smoke script

The repository ships a self-check that does not use your variables. It starts the real service on a free loopback port with throwaway secrets in a temporary directory, asserts the endpoint checklist (a missing or wrong key is 401, `GET /mcp` is 405 with `Allow: POST`, `/readyz` is 200, MCP `initialize`, `tools/list` and one tool call succeed, and `SIGTERM` drains to exit 0), and deletes everything afterwards:

```bash
bun scripts/standalone-smoke.ts --service
```

Without `--service` the same script runs the other transport: it starts the stdio connector `bin/ultrathink-connector` in a clean environment and checks its replies.

```bash
bun scripts/standalone-smoke.ts
```

Neither mode needs a network, a model key or the `claude` binary. A pass proves this checkout can serve both transports; it says nothing about your TLS files, your proxy or your own variables, which step 4 and step 6 check.

## 10. Connect a client

Add `https://<your-origin>/mcp` as a custom connector in Claude chat or Grok Chat, or run `claude mcp add --transport http ultrathink https://<your-origin>/mcp` in Claude Code. Each client sends you to the consent page, where the owner password approves it. The exact steps and what each client does are in [Use /ultrathink in Claude, Claude Code and Grok Chat](use-ultrathink-in-chat.md#connect-a-client). A client whose redirect address is not on the built-in list needs its origin in `ULTRATHINK_OAUTH_REDIRECT_ORIGINS`.

## 11. Run it in a container (Linux)

The repository carries a container recipe: `deploy/docker/Dockerfile`, `deploy/docker/compose.example.yml` and `deploy/docker/Dockerfile.dockerignore`. It was built and run by hand on Linux with Docker 29.6.2, where `oven/bun:1` resolved to Bun 1.4.4. Nothing below is claimed beyond that run.

**Build** from the repository root:

```bash
docker build -f deploy/docker/Dockerfile -t ultrathink-web .
```

The image runs as the unprivileged user `bun` (uid 1000, gid 1000). `/var/lib/ultrathink` is mode 0700 and owned by `bun`. A named volume inherits that ownership; a bind-mounted state directory must be owned by uid 1000 or the service cannot write its state.

**Variables.** The container reads the same env file as the rest of this guide (step 2). The one difference is how the argon2id hash is written, and it depends on who reads the file:

- `docker run --env-file` does no quote handling: write the hash **without** quotes.
- Compose interpolates `$` in env-file values: keep the hash in **single quotes**, for example `ULTRATHINK_OWNER_PASSWORD_HASH='<paste-the-argon2id-hash>'`.

Either way the `$` segments must reach the service intact; see the warning in [step 2](#2-set-the-three-required-variables). For the checks below, the env file is the one from step 2, with `ULTRATHINK_PLAINTEXT_LOOPBACK=1` and `ULTRATHINK_PUBLIC_ORIGIN=http://127.0.0.1:8795`, which is the dev and local choice. For a real deployment use a TLS-terminating reverse proxy in front of the container, or the three `ULTRATHINK_TLS_*` paths mounted read-only. The Dockerfile `HEALTHCHECK` probes plain HTTP, so override or disable it when the mTLS listener is used: the service refuses a client without a certificate.

**Check the configuration inside the image.** This needs no network:

```bash
docker run --rm --env-file ultrathink.env ultrathink-web bun services/ultrathink/server.ts --check-config
```

A valid env printed `config ok` and exited 0. A broken one printed `ultrathink: 4 configuration problems`, one line per problem, and exited 1.

**Run it:**

```bash
docker run -d --name ultrathink-web --network host --env-file ultrathink.env -v ultrathink-state:/var/lib/ultrathink ultrathink-web
```

The service listens on `127.0.0.1` only, so `--network host` is required, and it works on Linux only: a published port (`-p`) cannot reach a loopback-only listener. With it, `/healthz` returned 200 `{"ok":true}`, `/readyz` returned 200 with every check true, `POST /mcp` without the connector key returned 401, `tools/list` with the `x-connector-key` header returned 9 tools, Docker's `HEALTHCHECK` reported `healthy`, `docker stop` (`SIGTERM`) exited with code 0, and a sweep of the container logs found none of the secrets.

**Compose:**

```bash
cd deploy/docker
cp compose.example.yml compose.yml
umask 077
# create ultrathink.env here, beside compose.yml (hash in single quotes)
docker compose up -d --build
```

`docker compose config -q` validated, the service reached `healthy`, and `docker compose down -v` removed it (`-v` also deletes the state volume).

**Hardening.** The compose example sets `read_only: true`, `cap_drop: [ALL]`, `security_opt: ["no-new-privileges:true"]` and `tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"]`; the same four settings were run with `docker run` (`--read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,size=64m`) plus the state volume, and `/healthz` returned 200, `tools/list` returned 9 tools and the service exited cleanly. Host networking lets any local user on the host reach the loopback listener, so use the connector key and keep the host single-user, or put TLS in front.

**Custom images.** The image copies only `package.json`, `services/`, `src/`, `commands/`, `skills/` and `hosts/grok-bot/skills/`. The service refuses to start with `CATALOG_DRIFT` when a command-catalog source directory is missing, so an image of your own must keep all three catalog directories (`commands/`, `skills/` and `hosts/grok-bot/skills/`). The first real run failed for exactly this reason, before `hosts/grok-bot/skills/` was copied.

## What is not verified

- A production-shaped install (mTLS listener, reverse proxy, systemd) by someone outside the maintainers.
- The `--check-config` output strings (step 4) on a bare host without the container; they were observed only inside the image (step 11).
- The container (step 11) was built and run once by hand at this release, on one Linux host. CI does not build the image. Docker Desktop on macOS and Windows was not tried; host networking differs there, so the `--network host` recipe may not apply. No published image or registry exists: you build it yourself. The mTLS listener and a mounted-certificate setup in the container were not exercised.
- A server-side plan on a host other than the reference deployment (step 7).
- Any chat client's behaviour against your instance; see the status note in the [chat guide](use-ultrathink-in-chat.md).
