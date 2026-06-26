# Security

Codex Fleet is a local, single-operator research tool. It is not a sandbox and should not be treated as a security boundary for untrusted code.

## Supported Use

The intended deployment is one operator running a user-level daemon on their own workstation. The daemon listens on a local Unix socket and stores state under `~/.codex-fleet`.

Remote daemon access, shared multi-user hosts, TCP listeners, and untrusted worker workloads are outside the current supported model.

## Worker Privileges

Workers run through Codex with broad local access:

- `sandbox: danger-full-access`
- `approval-policy: never`

A worker may be able to read or use the operator's local credentials, SSH keys, GitHub auth, Docker socket, repository checkouts, and deploy tooling. Do not run Codex Fleet on a machine where that is unacceptable.

## Current Protections

- State directories are created with `0700` permissions.
- Client tokens are stored as `0600` files.
- The daemon stores token hashes, not plaintext tokens.
- RPC requests require a known client id and valid token.
- Role-derived scopes limit which methods each client can call.
- Unix socket peers are checked against the daemon user's UID on supported local platforms.
- The daemon refuses to run as root.
- Repo-mutating tasks use Fleet-owned worktrees instead of the operator's working checkout.

## Known Limits

- No worker sandboxing for malicious repository code.
- No same-user compromise protection.
- No root compromise protection.
- Peer UID verification depends on local Unix socket credential support and is not a remote auth model.
- No remote or multi-user auth model.
- No command/path/network allowlist.
- No automatic secret redaction from worker output.
- Token rotation exists in the stored schema but is not yet exposed as an operator workflow.

## Reporting

Before this repository is public, report issues privately to the repository owner. After publication, prefer a private security advisory for credible vulnerabilities. Do not include live secrets, private keys, tokens, or production host details in public issues.

## Practical Guidance

- Keep `~/.codex-fleet` private to your user account.
- Do not expose the daemon socket over TCP or a shared filesystem.
- Prefer repo targets over shell targets for code changes.
- Treat shell tasks as broad host-access operations.
- Inspect prompts and worker output before sharing logs.
