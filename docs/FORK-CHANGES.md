# ECMSI Fork: Changes from Upstream

This repository is ECMSI's maintained fork of
[theonlytruebigmac/n-central-mcp](https://github.com/theonlytruebigmac/n-central-mcp), the
unofficial N-central REST API MCP server that N-able's developer portal distributes as a recipe.
The upstream project and its author retain copyright on the original work; ECMSI holds copyright on
the modifications recorded here. Both are licensed under MIT (see [LICENSE](../LICENSE)).

The fork exists so ECMSI can run a reviewed, hardened build against its own N-central server and
contribute the hardening back upstream one change at a time.

## Fork point

| | |
|---|---|
| Upstream commit | `20639eefad726cde0deca05df81e59dfd2aec468` (upstream `main`, 2026-09-13, two commits past tag `v3.0.0`) |
| Review date | 2026-11-18 |
| Review method | Full read of all runtime code, dependency and lockfile inspection, CI and container configuration, plus an independent second review. The hardening below addresses every finding that was a code change rather than an operating practice. |

## Changes

| Area | Upstream behaviour | Fork behaviour | Why |
|---|---|---|---|
| Outbound redirects | `fetch` followed redirects by default on the authenticate, refresh and API calls. | All three pass `redirect: 'error'`. The contract fixture records the mode and the server adapter test asserts it on every captured request. | The Fetch spec strips `Authorization` on cross-origin redirects, but the refresh token travels in a request body, which survives 307/308. An API client has no reason to follow a redirect. |
| Credential-returning tools | `get_device_activation_key` and `get_registration_token` were `read` scope, so `NC_WRITE_MODE=read-only` still advertised them when their toolsets were enabled. The activation-key tool was not audit-classified as sensitive. | Both are `write` scope and in the explicit sensitive list. | Activation keys and registration tokens let a holder enroll or activate agents against a customer. Read-only mode must not hand them out. |
| Credentialed PSA ticket lookup | `get_psa_ticket` was `read` scope but issued a `POST` carrying model-supplied PSA credentials whenever the optional `credentials` argument was present. | `get_psa_ticket` is GET-only. The credentialed POST lives in a new `write`-scoped tool, `get_psa_ticket_with_credentials`, which the legacy `get_custom_psa_ticket_detail` alias now maps to. The PSA catalog has 12 tools and the de-duplicated full catalog has 105. | Read-only mode must not issue mutating-method requests or ship credentials. |
| CSV output | `csvEscape` quoted commas, quotes and newlines only. | String cells beginning with `=`, `+`, `-`, `@`, tab or carriage return get a leading single quote. Numeric values are unchanged. | A device name or custom property set to a formula by anyone with N-central write access became live when `run_report` CSV output was opened in a spreadsheet. |
| `validate_session` output | Returned the upstream `GET /api/auth/validate` body verbatim as `response`. | Returns `{ valid, message }`, projecting the body to a fixed shape. | The tool promises not to return token material; a fixed projection keeps that true whatever N-central adds to the response later. |
| Auth failure errors | Appended up to 200 bytes of the upstream response body to the thrown error in single-tenant mode. | The error carries only the status code. A new test drives a 401 from the token exchange and asserts the body never appears. | The message lands in MCP client log files and can name the server or user. |
| Windows test support | The stdio and HTTP spawn tests passed a drive-letter path to `--import`, which Node rejects, and asserted a clean exit after SIGTERM, which Windows cannot deliver. | The loader is passed as a file URL and the shutdown assertion is platform-aware. No server code changed. | ECMSI develops on Windows. |
| Dependencies | September 2026 lockfile carried 13 advisories (1 critical in `proxy-addr`, 4 high including `@modelcontextprotocol/sdk` and `body-parser`, 8 moderate). | `npm audit fix` within declared ranges; SDK at 1.32.2. Both audits report zero. | Lockfile-only; no range changes. |
| Fork versioning | Version `3.0.0` shared with upstream; the release workflow accepted only plain `vX.Y.Z` tags. | Version `3.0.0-ecmsi.N`. Release tags must be `vX.Y.Z-ecmsi.N`; the readiness schema accepts that pattern and the readiness generator prints the record's tag instead of a hard-coded one. | A fork release must never claim a number upstream may publish, and version bumps must stay out of the hardening commits sent upstream. |
| npm script portability | Six scripts used `VAR=value node ...` prefixes, which fail in PowerShell and cmd.exe. | `scripts/with-env.js` sets the variables and runs the command without a shell. A test rejects any script that reintroduces a prefix. | ECMSI runs and tests on Windows as well as Linux. |
| Line endings | No `.gitattributes`; Windows checkouts needed `core.autocrlf=false` or the hash-based contract tests failed. | `* text=auto eol=lf` normalizes every checkout to LF. | Removes a manual step and makes the Windows CI job possible. |
| Windows CI | Linux only. | `test-windows` job in CI and `verify-windows` job in the release workflow run `npm run release:check:windows`, the full gate minus the per-file coverage floor, which Windows cannot measure. An image is published only after both platforms pass. | Cross-platform support is enforced, not assumed. |
| Deployment documentation | Client setup only; no guidance for the host running HTTP mode. | `docs/DEPLOYMENT.md` covers Docker Compose and systemd on Linux and a Windows service (WinSW), with checksum verification, file permissions, the TLS-proxy requirement for anything beyond localhost, and update steps, plus PowerShell equivalents for the verification commands. | ECMSI may run the server on a Linux Docker host or a Windows server; both paths need a written, repeatable procedure. |
| Release assets | GitHub Release carried the image reference and digest only. | The release job also attaches the `npm pack` tarball and its SHA-256 checksum. `package.json` declares `files` so the tarball holds only runtime code plus `.env.example`, and the job runs `npm shrinkwrap` first so installs from the tarball reproduce the tested dependency tree. Image labels name the fork. | Hosts without Docker, Windows in particular, can install a released build without cloning. |

Not changed, by design:

- The HTTP-mode `/metrics` endpoint is still unauthenticated unless `MCP_METRICS_REQUIRE_AUTH=1`. Changing the default would alter behaviour for other users of the upstream project, and ECMSI runs stdio mode.
- `docs/LIVE-MCP-UX-EVALUATION.md` still describes the upstream live run at 104 tools. It is a historical record, not a generated document.
- GitHub Actions are pinned to major-version tags, as upstream has them.

## Verification

- Linux CI on this fork (Ubuntu, Node 22 and 24, container smoke) passes `npm run release:check` in full, including the per-file coverage floors.
- Windows CI (`windows-latest`, Node 24) passes `npm run release:check:windows`: the full suite, generated-document gates, version check, lint, type-check and both audits. The per-file coverage floor cannot be measured on Windows because HTTP-mode child processes are killed by signal before V8 writes their coverage; the Linux jobs enforce that gate.
- Line endings are pinned to LF by `.gitattributes`. A checkout made before that file existed should be refreshed with `git rm -rq --cached . && git reset --hard` so the hashed contract files match.

## Release history

| Version | State | Notes |
|---|---|---|
| `3.0.0-ecmsi.1` | Image only; superseded | The tag was created unsigned and pointed at the deployment-guide branch head rather than `main`, and the release job failed before creating the GitHub Release because `npm pack` was given a `dist` directory that did not exist. The container image and `latest` alias were published from that commit; its runtime content is identical to `3.0.0-ecmsi.2`. The tag is left in place because the image tag exists and version tags are never moved. |
| `3.0.0-ecmsi.2` | Current candidate | Intended first complete release: a signed tag on `main` producing the image and a GitHub Release with tarball and checksum. Includes the deployment guide and the `dist` fix. Tag signing is now enabled in the checkout (`tag.gpgsign=true`), so `git tag -a` signs with the same key as commits. |

## Keeping the fork current

1. Fetch upstream and merge `upstream/main` into a branch off `main`.
2. Re-check every row of the table above still holds in the merged code, with particular attention to new `fetch` calls, new environment variables, and any change to `src/toolsets.js` or `src/tool-registry.js`.
3. Open a pull request so CI runs the release gate on Linux before merging.

## Sending changes upstream

Each hardening change above was committed separately so it can be cherry-picked onto its own branch
against `upstream/main` and opened as an individual pull request. The auth-failure change is in two
commits on this fork's history and should be squashed into one when cherry-picked.

The cross-platform release work landed as one commit because the version change touches the same
files. The pieces worth offering upstream are `scripts/with-env.js` with the script rewrites,
`.gitattributes`, and the Windows CI job; the `-ecmsi` versioning, image labels and readiness schema
pattern are fork-specific and should be left out of any upstream pull request.
