# Deployment Guide

How to run a released build of this server on a host, on Linux or Windows. The
[Setup Guide](SETUP-GUIDE.md) covers pointing MCP clients at the server; this guide covers the server
side: installing a release, keeping the token out of the wrong places, running it as a service, and
updating it.

## Choose a mode first

| Mode | When to use it | What runs |
|---|---|---|
| **stdio** | One person, one machine. Claude Desktop, Claude Code, VS Code or Cursor start the server themselves. | Nothing persistent. Each client launches `node index.js` on demand. No port, no API key, no service. |
| **HTTP** | Several people or machines share one server, or the server must run where the clients are not. | A long-running process listening on `MCP_PORT`, protected by `MCP_API_KEY`. This is what the Docker image and the Windows service run. |

If stdio fits, install the package (below) and follow the client sections of the Setup Guide; the
rest of this document is for HTTP hosts.

## Rules that apply to every host

- **Use a dedicated N-central API user** with the narrowest role that covers what the tools need, with
  MFA off for that user only, and generate the JWT for it. The API user's password rotates every 90
  days, which invalidates the JWT; put a reminder in place before the first rotation.
- **Start with `NC_WRITE_MODE=read-only` and `NC_TOOLSETS=core`.** Widen only when a specific task
  needs it, and widen the toolset before the write mode.
- **The JWT and the MCP API key live in one `.env` file** readable only by the account the server
  runs as. They never go in a client config, a compose file, a service definition or a shell history.
- **HTTP mode is plain HTTP.** The server does not terminate TLS. Keep `MCP_BIND_ADDRESS=127.0.0.1`
  and reach it over localhost, a VPN or an SSH tunnel, or put a TLS reverse proxy in front of it and
  set `MCP_TRUST_PROXY=1` so rate limiting sees the real client address. Binding to `0.0.0.0` without
  TLS sends the bearer key across the network in clear text.
- **Pin the version you deploy.** Use the exact image tag or digest, or the exact tarball, and record
  which one is running. `latest` is for trying things out.
- **Keep one replica.** Sessions, tokens and rate limits are held in process memory; see
  [Runtime Architecture](ARCHITECTURE.md). Scale by giving the one process more resources, not by
  adding copies behind a load balancer.

## What a release contains

Each [GitHub Release](https://github.com/ecmsi/n-central-rest-api-mcp/releases) of the fork provides:

| Asset | Use |
|---|---|
| `ghcr.io/ecmsi/n-central-rest-api-mcp:<version>` | Linux AMD64 and ARM64 container image. The release notes record its immutable digest. |
| `n-central-rest-api-mcp-<version>.tgz` | The npm package: runtime code only, plus a shrinkwrap so `npm install` reproduces the dependency tree the release was tested with. |
| `n-central-rest-api-mcp-<version>.tgz.sha256` | Checksum for the tarball. |

Versions look like `3.0.0-ecmsi.3`: upstream's version plus the fork's release number. See the
[README](../README.md#releases) for why.

---

## Linux: Docker Compose

This is the lowest-maintenance option and the one the container smoke test exercises.

### Prerequisites

- Docker Engine 24 or newer with the Compose plugin (`docker compose version` works).
- Outbound HTTPS from the host to your N-central server and to `ghcr.io`.

### Install

Work from a directory that holds only the compose file and `.env`:

```bash
sudo mkdir -p /opt/ncentral-mcp && cd /opt/ncentral-mcp
curl -fsSLo .env.example https://raw.githubusercontent.com/ecmsi/n-central-rest-api-mcp/main/.env.example
cp .env.example .env
chmod 600 .env
```

Edit `.env`: set `NC_SERVER_URL`, `NC_JWT_TOKEN`, and `MCP_API_KEY` (generate one with
`openssl rand -hex 32`). Leave `MCP_PORT` commented out; compose sets it.

Create `compose.yml` that pulls the released image rather than building from source:

```yaml
services:
  ncentral-mcp:
    image: ghcr.io/ecmsi/n-central-rest-api-mcp:3.0.0-ecmsi.3
    container_name: ncentral-mcp
    env_file: .env
    environment:
      MCP_BIND_ADDRESS: 0.0.0.0   # inside the container only; `ports` controls host exposure
      MCP_PORT: 3100
    ports:
      - "127.0.0.1:3100:3100"
    restart: unless-stopped
    read_only: true
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp
```

To pin by digest instead of tag, replace the tag with `@sha256:<digest from the release notes>`.

```bash
docker compose pull
docker compose up -d
docker compose ps          # State should be "healthy" within about 30 seconds
curl -s http://127.0.0.1:3100/healthz
```

The last command returns `{"status":"ok","sessions":0}`.

### Reach it from other machines

Put a TLS reverse proxy on the same host and leave the container published on localhost. With
Caddy, a complete configuration is:

```
mcp.example.internal {
    reverse_proxy 127.0.0.1:3100
}
```

Caddy obtains and renews the certificate itself when the name is publicly resolvable; for an
internal name, point it at your internal CA or supply a certificate with the `tls` directive. Then set
`MCP_TRUST_PROXY=1` in `.env` and restart the container so the rate limiter uses the forwarded client
address. Clients connect to `https://mcp.example.internal/mcp` with the bearer key.

### Operate

```bash
docker compose logs -f --tail 100        # structured logs and the audit stream
docker compose up -d                     # after editing .env (a plain `restart` keeps the old environment)
docker compose pull && docker compose up -d   # after changing the image tag in compose.yml
```

To roll back, set the previous tag or digest in `compose.yml` and run the last command again.

---

## Linux: package without Docker

For a host where Docker is not wanted, install the tarball and run it under systemd.

```bash
sudo useradd --system --home /opt/ncentral-mcp --shell /usr/sbin/nologin ncentral-mcp
sudo mkdir -p /opt/ncentral-mcp/app && cd /opt/ncentral-mcp
# Download the .tgz and .sha256 assets from the release page, then:
sha256sum -c n-central-rest-api-mcp-3.0.0-ecmsi.3.tgz.sha256
sudo tar -xzf n-central-rest-api-mcp-3.0.0-ecmsi.3.tgz -C app --strip-components=1
cd app && sudo npm install --omit=dev
sudo cp /opt/ncentral-mcp/app/.env.example /opt/ncentral-mcp/.env 2>/dev/null || sudo touch /opt/ncentral-mcp/.env
sudo chown -R ncentral-mcp:ncentral-mcp /opt/ncentral-mcp
sudo chmod 600 /opt/ncentral-mcp/.env
```

Fill in `/opt/ncentral-mcp/.env` as for Docker, and this time set `MCP_PORT=3100` in it.
Node.js 22.9 or newer must be installed; the LTS line is recommended.

`/etc/systemd/system/ncentral-mcp.service`:

```ini
[Unit]
Description=N-central REST API MCP server
After=network-online.target
Wants=network-online.target

[Service]
User=ncentral-mcp
WorkingDirectory=/opt/ncentral-mcp/app
ExecStart=/usr/bin/node --env-file=/opt/ncentral-mcp/.env /opt/ncentral-mcp/app/index.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ncentral-mcp
systemctl status ncentral-mcp
curl -s http://127.0.0.1:3100/healthz
```

To update, stop the service, extract the new tarball over `app/`, run `npm install --omit=dev`
again, and start the service.

---

## Windows

Windows hosts run the same code. There is no Windows container image; the supported path is the
package tarball running under the Node.js LTS line, as a Windows service for HTTP mode.

### Prerequisites

- Node.js LTS. Either download the MSI from nodejs.org or run, in an elevated PowerShell:

  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```

  Open a new PowerShell afterwards so `node` and `npm` are on the path, and confirm with
  `node --version` (22.9 or newer).
- Outbound HTTPS to your N-central server.

### Install the package

Download the `.tgz` and `.sha256` assets from the release page into a scratch folder, then verify
and extract to a fixed location that does not depend on any user's profile:

```powershell
$version = '3.0.0-ecmsi.3'
$tarball = "n-central-rest-api-mcp-$version.tgz"
$expected = (Get-Content "$tarball.sha256").Split(' ')[0]
$actual = (Get-FileHash $tarball -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "Checksum mismatch for $tarball" }

New-Item -ItemType Directory -Force C:\ProgramData\ncentral-mcp\app | Out-Null
tar -xzf $tarball -C C:\ProgramData\ncentral-mcp\app --strip-components=1
Set-Location C:\ProgramData\ncentral-mcp\app
npm install --omit=dev
```

`tar` ships with Windows 10 and later. `npm install` reads the shrinkwrap inside the tarball and
installs exactly the dependency versions the release was tested with.

### Configure

```powershell
Copy-Item C:\ProgramData\ncentral-mcp\app\.env.example C:\ProgramData\ncentral-mcp\.env
notepad C:\ProgramData\ncentral-mcp\.env
```

Set `NC_SERVER_URL`, `NC_JWT_TOKEN`, `MCP_API_KEY` and, for HTTP mode, `MCP_PORT=3100`. Generate the
API key with:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Then restrict the file to administrators and the service account (replace `ncentral-mcp` with the
account you create below):

```powershell
icacls C:\ProgramData\ncentral-mcp\.env /inheritance:r /grant:r "Administrators:F" "ncentral-mcp:R"
```

### Try it in the foreground

```powershell
Set-Location C:\ProgramData\ncentral-mcp\app
node --env-file=C:\ProgramData\ncentral-mcp\.env index.js
```

In a second PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:3100/healthz
```

returns `status : ok`. Stop the server with Ctrl+C.

### Run as a Windows service

Node.js cannot register itself as a service, so a service wrapper runs it. [WinSW](https://github.com/winsw/winsw)
is a single executable with an XML configuration and is the wrapper used below;
[NSSM](https://nssm.cc/) works the same way with a command-line configuration. Review either tool's
release page before downloading it, and keep the executable with the configuration.

1. Create a local service account with no interactive logon rights, for example `ncentral-mcp`,
   and grant it read access to `C:\ProgramData\ncentral-mcp` (the `icacls` command above covers the
   `.env` file; the `app` folder needs read as well).
2. Download `WinSW-x64.exe` from the WinSW releases page, save it as
   `C:\ProgramData\ncentral-mcp\ncentral-mcp.exe`, and create `C:\ProgramData\ncentral-mcp\ncentral-mcp.xml`:

   ```xml
   <service>
     <id>ncentral-mcp</id>
     <name>N-central REST API MCP server</name>
     <description>MCP server for the N-central REST API (ECMSI fork)</description>
     <executable>C:\Program Files\nodejs\node.exe</executable>
     <arguments>--env-file=C:\ProgramData\ncentral-mcp\.env C:\ProgramData\ncentral-mcp\app\index.js</arguments>
     <workingdirectory>C:\ProgramData\ncentral-mcp\app</workingdirectory>
     <serviceaccount>
       <username>.\ncentral-mcp</username>
       <prompt>dialog</prompt>
     </serviceaccount>
     <onfailure action="restart" delay="10 sec"/>
     <resetfailure>1 hour</resetfailure>
     <log mode="roll-by-size">
       <sizeThreshold>10240</sizeThreshold>
       <keepFiles>5</keepFiles>
     </log>
   </service>
   ```

   The `prompt` element asks for the account's password at install time instead of storing it in
   the file. Logs go to `ncentral-mcp.out.log` and `ncentral-mcp.err.log` beside the executable;
   the audit stream is part of the standard error output.
3. Install and start the service from an elevated PowerShell:

   ```powershell
   Set-Location C:\ProgramData\ncentral-mcp
   .\ncentral-mcp.exe install
   .\ncentral-mcp.exe start
   Get-Service ncentral-mcp
   Invoke-RestMethod http://127.0.0.1:3100/healthz
   ```

### Reach it from other machines

As on Linux, the server itself speaks plain HTTP. Either keep it on `127.0.0.1` and reach it through
a VPN or an SSH tunnel, or terminate TLS in front of it. On Windows the usual choices are IIS with the
Application Request Routing module, or Caddy installed as a second service with the same two-line
configuration shown in the Linux section. Set `MCP_TRUST_PROXY=1` in `.env` when a proxy is in front.
Open the firewall only for the proxy's port, never for 3100 directly:

```powershell
New-NetFirewallRule -DisplayName "N-central MCP (TLS proxy)" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
```

### Operate

```powershell
Get-Content C:\ProgramData\ncentral-mcp\ncentral-mcp.err.log -Tail 50 -Wait   # follow logs
Restart-Service ncentral-mcp                                                   # after editing .env
```

To update to a new release:

```powershell
Stop-Service ncentral-mcp
# verify the new tarball's checksum as in "Install the package", then:
tar -xzf n-central-rest-api-mcp-<new version>.tgz -C C:\ProgramData\ncentral-mcp\app --strip-components=1
Set-Location C:\ProgramData\ncentral-mcp\app
npm install --omit=dev
Start-Service ncentral-mcp
Invoke-RestMethod http://127.0.0.1:3100/healthz
```

Keep the previous tarball; rolling back is the same procedure with the old file.

### stdio clients on the same machine

For Claude Desktop or Claude Code on a Windows workstation, no service is needed. Point the client
at the installed package with the absolute `node.exe` path and the `.env` file, as shown in the
[Windows notes](SETUP-GUIDE.md#windows-notes) of the Setup Guide, using
`C:\ProgramData\ncentral-mcp\app\index.js` as the script path. Each user's `.env` then needs only
`NC_SERVER_URL` and `NC_JWT_TOKEN`.

---

## Verify any deployment

| Check | Linux | Windows |
|---|---|---|
| Server is up | `curl -s http://127.0.0.1:3100/healthz` | `Invoke-RestMethod http://127.0.0.1:3100/healthz` |
| Key is enforced | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/mcp` prints `401` | `(Invoke-WebRequest http://127.0.0.1:3100/mcp -SkipHttpErrorCheck).StatusCode` prints `401` |
| Metrics | `curl -s http://127.0.0.1:3100/metrics \| head` | `(Invoke-WebRequest http://127.0.0.1:3100/metrics).Content.Split("`n")[0..9]` |
| N-central reachable | First tool call from a client succeeds; a bad JWT fails there, not at startup | Same |

Then connect one client as described in the Setup Guide and run `get_server_status`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Service starts then stops at once | `.env` unreadable by the service account, or `MCP_API_KEY` empty while `MCP_PORT` is set | Check the `.err.log` (Windows) or `journalctl -u ncentral-mcp` (Linux); fix permissions or the key |
| `healthz` works locally, remote clients cannot connect | Bound to localhost, which is the intended default | Add the TLS proxy, or use a tunnel; do not bind to `0.0.0.0` without TLS |
| `401` from the first tool call | JWT invalid, the API user's 90-day password rotation has passed, or the API user has never completed an interactive login | Fix the user in N-central (reset the password, or log in once as that user), regenerate the JWT and update `.env`. Then on Docker run `docker compose up -d`: `docker compose restart` keeps the old environment and the old token. On Windows, `Restart-Service` is enough |
| Works on Linux, test suite fails on an old Windows checkout | CRLF files in a checkout made before `.gitattributes` existed | `git rm -rq --cached . && git reset --hard` |
| claude.ai connector calls succeed but Claude reports field names with no values, while Claude Code sees full results | The server is running a build older than `3.0.0-ecmsi.4`, or `MCP_RESULT_TEXT=summary` is set; claude.ai shows the model only the text part of a result | Upgrade, or remove `MCP_RESULT_TEXT` from `.env`, then recreate the container with `docker compose up -d` |
