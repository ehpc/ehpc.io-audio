"""Operator-only account administration: python -m backend.auth_admin --help."""

import argparse

from backend import auth_store, db


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage local authentication database")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("seed-invite")
    commands.add_parser("users")
    revoke = commands.add_parser("revoke-invite")
    revoke.add_argument("invite_id")
    limit = commands.add_parser("invite-limit")
    limit.add_argument("user_id")
    limit.add_argument("limit", type=int)
    disable = commands.add_parser("disable")
    disable.add_argument("user_id")
    enable = commands.add_parser("enable")
    enable.add_argument("user_id")
    sessions = commands.add_parser("revoke-sessions")
    sessions.add_argument("user_id")
    bind = commands.add_parser("bind-legacy")
    bind.add_argument("legacy_id")
    bind.add_argument("user_id")
    budget = commands.add_parser("budget")
    budget.add_argument(
        "name",
        choices=["user_daily_work", "global_daily_work", "user_queue", "global_queue"],
    )
    budget.add_argument("value", type=int)
    args = parser.parse_args()
    db.init_db()
    if args.command == "seed-invite":
        invite_id, code = auth_store.create_invite(None)
        print(f"{invite_id} {code}")
    elif args.command == "users":
        for user in auth_store.users():
            print(user)
    elif args.command == "revoke-invite":
        if not auth_store.revoke_invite(args.invite_id):
            parser.error("Invitation not found, revoked, or activated")
    elif args.command == "invite-limit":
        if not auth_store.update_user(args.user_id, invite_limit=args.limit):
            parser.error("Account not found")
    elif args.command == "disable":
        if not auth_store.update_user(args.user_id, disabled=True):
            parser.error("Account not found")
    elif args.command == "enable":
        if not auth_store.update_user(args.user_id, disabled=False):
            parser.error("Account not found")
    elif args.command == "revoke-sessions":
        if not auth_store.revoke_user_sessions(args.user_id):
            parser.error("Account not found")
    elif args.command == "bind-legacy":
        auth_store.bind_legacy(args.legacy_id, args.user_id)
    elif args.command == "budget":
        if args.value < 0:
            parser.error("Budget must be nonnegative")
        with db._session() as conn:
            conn.execute(
                "INSERT INTO auth_settings VALUES (?,?) "
                "ON CONFLICT(name) DO UPDATE SET value=excluded.value",
                (args.name, args.value),
            )


if __name__ == "__main__":
    main()
