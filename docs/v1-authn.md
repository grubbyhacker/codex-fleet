# Codex Fleet v1 Authentication

Status: current v1 local model

Codex Fleet v1 is designed for one operator on one local machine. The daemon is powerful because it can start workers that use the operator's normal local credentials and tools. Authentication therefore protects the daemon's local RPC socket from accidental or unauthorized clients; it does not make workers safe to run untrusted code.

## Trust Boundary

The boundary is the operator's OS user account.

- The daemon runs as the operator's user, never as root.
- Fleet state lives under `~/.codex-fleet`.
- The daemon listens on a Unix domain socket at `~/.codex-fleet/daemon.sock` by default.
- Client token files live under `~/.codex-fleet/clients/<clientId>/token`.

The expected filesystem modes are:

```text
~/.codex-fleet/                 0700
~/.codex-fleet/clients/         0700
~/.codex-fleet/clients/<id>/    0700
~/.codex-fleet/clients/<id>/token       0600
~/.codex-fleet/clients/<id>/client.json 0600
```

Code already running as the same OS user may be able to read the token, open the socket, or access the same credentials a worker can access. That is out of scope for v1.

## Client Records

A client has:

- `clientId`: non-secret label;
- `role`: one of `orchestrator`, `dashboard`, or `cli`;
- `scopes`: method permissions derived from the role;
- `tokenHash`: SHA-256 hash of the token;
- `createdAt`;
- optional `revokedAt`.

The plaintext token is written only to the client's local `token` file. The daemon metadata stores only the hash.

## Roles And Scopes

The current role mapping is:

| Role           | Scopes                                                            |
| -------------- | ----------------------------------------------------------------- |
| `orchestrator` | `delegate`, `wait`, `get`, `list`, `end_task`                     |
| `dashboard`    | `get`, `list`                                                     |
| `cli`          | `delegate`, `wait`, `get`, `list`, `end_task`, `cleanup`, `admin` |

Scopes are enforced per daemon method. For example, a dashboard client can inspect tasks but cannot delegate work or release resources.

## Request Flow

Every RPC request includes:

- `requestId`;
- `clientId`;
- `token`;
- `method`;
- optional `params`.

The daemon:

1. parses the request envelope;
2. loads the client record;
3. rejects revoked clients;
4. hashes the presented token and compares it to `tokenHash`;
5. maps the method to its required scope;
6. rejects the request if the client's scopes do not include that scope;
7. appends an audit record for accepted or rejected requests.

Before the RPC envelope is parsed, the daemon also verifies the Unix socket peer UID where the local runtime exposes peer credentials. On macOS this uses `getpeereid`; on Linux it uses `SO_PEERCRED`. A peer UID that does not match the daemon's UID is rejected before token auth.

## What This Does Not Protect

- Same-user compromise.
- Root compromise.
- Malicious code a worker executes.
- Secrets printed by a worker or subprocess.
- A deliberately exposed socket.
- Remote or shared multi-user deployments.

## Planned Hardening

- Add token rotation and revocation commands.
- Add finer-grained worker access profiles.
- Add human gates for high-risk operations such as deploys, production SSH, and merge/push authority.
- Add optional sandboxing for untrusted repository code.
