# Invite-only access: implementation and deployment

The invite-only email-OTP implementation and configuration are implemented and
tested locally. **They are not deployed or activated.** Existing production
remains on its previous release. The already-active send-only mail service is separate
from the application deployment. Drawing a symbol and passkeys are not part of
this design.

## Account and invitation behavior

Registration requires a valid single-use invitation and email verification;
login requires a registered email and OTP. OTPs expire after ten minutes and
are stored as keyed verifiers, not plaintext. Pending invitation codes are
HMAC-derived from random IDs using a separate stable invitation secret; their
verification hashes are stored. The configured administrator is
`ehpc@ehpc.io`; bootstrap uses an operator-created seed invitation followed by
the same email OTP flow, never first-visitor-wins.

Each member defaults to three invitation slots. Pending and activated invites
both occupy a slot; revoking a pending invite frees its slot. Lowering a limit
does not delete existing accounts or invites. Disabling an issuer prevents its
pending invites from starting **or completing** signup; already activated
members are unaffected. A disabled account cannot use its sessions. Enabling
an account does not revive revoked sessions; the user must log in again.
Sessions expire after 72 hours of deliberate inactivity; background polling,
media requests and downloads do not refresh that timer.
HTTPS sessions use a `Secure`, `HttpOnly`, host-only `__Host-auth_session`
cookie; loopback HTTP development uses `auth_session`. Unsafe requests require
the configured exact Origin.

Per-user and global work budgets cover cache hits as requests, as well as new
work. Operator-adjustable defaults are `user_daily_work=50`,
`global_daily_work=500` in a rolling day, and `user_queue=5`,
`global_queue=50` for queued jobs plus pending searches. Mail and authentication
requests are separately bounded. A submission failure can leave an uncertain
challenge valid for ten minutes; delivery is not automatically retried.

## Configuration and mail

Two independent stable secrets of at least 32 bytes each are required:
`audio-auth-otp-secret` and `audio-auth-invite-secret` in the encrypted top
level of `~/ehpc.io-configs/secrets.yaml`. The prepared SOPS templates create
`default/audio-auth` with keys `AUTH_OTP_SECRET` and `AUTH_INVITE_SECRET`.
Use distinct cryptographically random values, retain them across restarts and
backups, and never put them in chat, logs, source control as plaintext, or the
world-readable Nix store. The existing root-only SOPS age identity is not
accessible to the normal account; the authorized root operator must add both
keys with the existing encrypted-file workflow, for example:

```sh
sudo env SOPS_AGE_KEY_FILE=/etc/age/keys.txt sops /home/ehpc/ehpc.io-configs/secrets.yaml
```

The complete not-yet-installed configuration is
[`vps-auth-config.patch`](vps-auth-config.patch), based on the existing
`ehpc.io-configs` checkout and preserving its image pin and unrelated edits.
After the root operator has added **both** encrypted values, make a protected
backup of the configuration checkout and existing data, copy the patch to the
host, and review its context against any intervening changes. For example, with
the patch copied to `/tmp/vps-auth-config.patch` on the host:

```sh
patch --dry-run -p1 -d /home/ehpc/ehpc.io-configs -i /tmp/vps-auth-config.patch
patch -p1 -d /home/ehpc/ehpc.io-configs -i /tmp/vps-auth-config.patch
```

Do not apply the patch blindly if context differs. Applying source files alone
does not activate them. Before a separately approved NixOS activation, verify
the policy and gateway boundary described below; then deploy the reviewed app
image only after matching release checks. Never use an old database restore to
discard work accepted after cutover.

In the protected editor, add the two values without exposing them. Do not run a
rebuild or apply while either is missing; configuration preflight refuses
unreadable, short, or equal keys. The application also receives
`AUTH_ORIGIN=https://audio.ehpc.io`, `AUTH_ADMIN_EMAIL=ehpc@ehpc.io`, and
`AUTH_SMTP_SOCKET=/run/audio-mail/submit.sock`. The socket directory, not the
socket inode, is mounted read-only; a runtime-derived supplemental group grants
socket access without changing the existing PVC fsGroup or hard-coding a host
GID. The prepared `AUTH_TRUSTED_PROXY_CIDRS=10.42.0.0/24` is the gateway
node's observed pod subnet, not an unconditional trust grant: it is safe only
with the gateway-only ingress NetworkPolicy enforced, no broader policy, and
restricted permission to create gateway-labelled pods. The gateway overwrites
`X-Real-IP`, while the app ignores incoming `X-Forwarded-For`; Uvicorn must
preserve the raw peer. Recheck the current subnet and test Canal enforcement,
gateway traffic and node health probes before rollout. Until then **per-client
IP protection is unverified and production rollout is blocked**.

The active IPv4-only mail system submits through the restricted Unix socket as
`no-reply@auth.ehpc.io` with envelope sender `bounce@auth.ehpc.io`. It is not a
public Internet submission service. On 2026-11-09, one user-approved message to
the operator was accepted by Google and confirmed in the inbox; the reported
headers showed SPF, DKIM and DMARC pass. That is evidence for that single test,
not a guarantee of future delivery. Do not send further real mail without the
appropriate authorization, or inspect/export the private DKIM key. Keep the
existing root-domain Google mail records unchanged.

## Operator commands

Run the CLI in the authorized application environment with access to the current
SQLite data and the same stable secrets; obtain detailed usage with
`python -m backend.auth_admin --help`. Commands are:

```text
seed-invite
users
invite-limit USER_ID LIMIT
revoke-invite INVITE_ID
disable USER_ID
enable USER_ID
revoke-sessions USER_ID
bind-legacy LEGACY_ID USER_ID
budget {user_daily_work,global_daily_work,user_queue,global_queue} VALUE
```

Treat the seed invitation and any displayed invitation codes as private. Bind a
legacy ID only after out-of-band proof of ownership: the old anonymous cookie
signing default was insecure, so an old cookie is **not** evidence of identity
and no automatic claim is performed. `bind-legacy` atomically changes only the
ownership columns of that legacy ID's jobs and song searches, and records the
old ID in the audit trail; existing result files and cached work stay intact.
Back up the live database consistently and retain original data before any
migration. After new authenticated work is accepted, do not restore an old
anonymous database over it: reconcile new work and use a reviewed forward fix.

## Release boundary

The live release must not be changed until the final source, secret provisioning,
trusted gateway/client-IP policy, tests, deployment plan and rollback/forward-fix
procedure are reviewed. Local tests and the controlled mail delivery above are
not evidence that invite-only authentication is deployed. Image pin, existing
secrets, PVC, historical rows, files and caches must be preserved at cutover.
