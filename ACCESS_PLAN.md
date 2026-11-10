# Invite-only access: implementation and deployment

Invite-only access is deployed at `audio.ehpc.io` from application commit
`c527bb43509759c217e62e07311e5a393f9ce9cf`, image digest
`sha256:c72d57a6b3762490cb8027ca51eff2e765223c84642175e8aa84cb20f27fbcef`,
and VPS configuration commit `f3e36c2ef36ff4ca3a6367ede3623127a2ccbf34`.
Drawing a symbol and passkeys are not part of this design.

## Account and invitation behavior

**Source changes awaiting deployment:** administrators have unlimited invitation
slots (`invite_limit: null`); regular accounts retain their configurable finite
allowance, defaulting to three. Only administrators may revoke unused invitations
or disable accounts and revoke sessions. Revoking an invitation never disables
an activated account; activated invitations cannot be revoked. Administrators can
grant a regular user one additional slot atomically. The admin-only People view
reports invitation usage and recent jobs and song searches, including available
titles and queries, plus registration, last sign-in and deliberate-activity times.
Unknown historical values remain unknown; existing session activity is migrated
from its recorded timestamp, not from migration time. These new policy and
activity changes are **not yet deployed**; the deployment record above describes
the earlier implementation.

Registration requires a valid single-use invitation and email verification;
login requires a registered email and OTP. OTPs expire after ten minutes and
are stored as keyed verifiers, not plaintext. Pending invitation codes are
HMAC-derived from random IDs using a separate stable invitation secret; their
verification hashes are stored. The configured administrator is
`ehpc@ehpc.io`; bootstrap uses an operator-created seed invitation followed by
the same email OTP flow, never first-visitor-wins.

Regular accounts default to three invitation slots. Pending and activated invites
both occupy a slot; only an administrator may withdraw a pending invite, freeing
its slot. Lowering a limit does not delete existing accounts or invites.
Disabling an issuer prevents its
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
Use a cryptographically secure pseudorandom number generator (CSPRNG) to create
two distinct, stable secrets of at least 32 bytes each (at least 64 hexadecimal
characters per key); retain them across restarts and backups. Never put them in
chat, logs, source control as plaintext, or the
world-readable Nix store. If either key is missing, an authorized root operator
must add it privately with the existing encrypted-file workflow, for example:

```sh
sudo env SOPS_AGE_KEY_FILE=/etc/age/keys.txt sops /home/ehpc/ehpc.io-configs/secrets.yaml
```

The prepared configuration resides in the VPS
`~/ehpc.io-configs` checkout. Its canonical Deployment and ingress policy are
`nixos/audio-deployment.yaml` and `nixos/audio-network-policy.yaml`; the apply
service captures them in the Nix closure and derives the mail group at runtime.
The remaining common manifests stay in `k8s/120-audio`. Installing source
files alone does not activate the configuration.

Before the approved cutover, preserve a consistent database backup, review all
current user changes, and verify that the local build source, common manifests,
and approved image pin match. Build the NixOS closure on a workstation or CI,
not on the VPS; copy the verified closure and have an authorized root operator
activate it. Explicitly start the new `apply-k8s-manifests.service` after SOPS
templates are ready: an inactive oneshot may not rerun on switch. Verify the
unit result, Secrets, network policy, pod image and health. Never use an old
database restore to discard work accepted after cutover.

Save the original live Deployment specification and immutable image pin as
well as the consistent database backup. A pre-auth Nix generation's old apply
unit does not restore the Deployment after its legacy manifest was moved, and
`kubectl apply` without prune retains existing Secrets and NetworkPolicies.
Recovery therefore needs a separately reviewed Kubernetes rollback or forward
fix; do not assume a Nix generation switch reverses the application. If an old
anonymous image is ever restored, keep public access closed rather than
silently removing authentication. Later Nix generations contain the Deployment
in their closures; explicitly rerun the apply unit after an approved rollback.

Retain existing keys without rotation. Do not activate or apply while either
is missing; configuration preflight refuses unreadable, short, or equal keys.
The application also receives
`AUTH_ORIGIN=https://audio.ehpc.io`, `AUTH_ADMIN_EMAIL=ehpc@ehpc.io`, and
`AUTH_SMTP_SOCKET=/run/audio-mail/submit.sock`. The socket directory, not the
socket inode, is mounted read-only; a runtime-derived supplemental group grants
socket access without changing the existing PVC fsGroup or hard-coding a host
GID. The prepared `AUTH_TRUSTED_PROXY_CIDRS=10.42.0.0/24` is the gateway
node's observed pod subnet, not an unconditional trust grant: it is safe only
with the gateway-only ingress NetworkPolicy enforced, no broader policy, and
restricted permission to create gateway-labelled pods. The gateway overwrites
`X-Real-IP`, while the app ignores incoming `X-Forwarded-For`; Uvicorn must
preserve the raw peer. The deployed audio ingress policy was applied, and the
cutover helper reached its public check only after the private gateway-to-pod,
nonmatching-pod denial, socket-connect and preservation checks. After guarded
recovery, public health returned 200 and an unauthenticated jobs request 401.
Recheck the current subnet, gateway labels, pod-creation and relabel permissions,
effective policy, traffic and node health probes for future rollouts.

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

The active Nix system uses the reviewed configuration; the audio auth Secret has
both expected key names and the host kubeconfig is mode `0640` (`root:kube`).
Public desktop and mobile sign-in/register UI checks passed without submitting
a form. A seed invitation was created privately, but the first administrator's
email-OTP login and private production karaoke have not yet been exercised. The
release CI's 66 browser passes are not a substitute for those production checks.

For future cutovers, verify the ready EndpointSlice target **and** the actual
NGINX audio upstream before public checks: endpoint readiness alone does not
prove the gateway has reconciled. Do not mask a failed public check with retries.
Preserve the image pin, secrets, PVC,
historical rows, files and caches. Never expose an anonymous rollback or restore
an old database over newly accepted work.
