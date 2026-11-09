"""Transactional account, challenge, invitation and workload storage."""

import hashlib
import hmac
import secrets
import sqlite3
import time
from dataclasses import dataclass
from typing import Literal, TypedDict

from backend import config, db

SESSION_IDLE = 72 * 3600
OTP_TTL = 600

SCHEMA = """
CREATE TABLE IF NOT EXISTS auth_users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, is_admin INTEGER NOT NULL,
 invite_limit INTEGER NOT NULL DEFAULT 3, disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_invites (
 id TEXT PRIMARY KEY, verifier TEXT NOT NULL UNIQUE, owner_id TEXT,
 recipient_id TEXT, created_at INTEGER NOT NULL, activated_at INTEGER,
 revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_challenges (
 id TEXT PRIMARY KEY, email TEXT NOT NULL, invite_hash TEXT NOT NULL,
 verifier TEXT NOT NULL, expires_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_sessions (
 verifier TEXT PRIMARY KEY, user_id TEXT NOT NULL, last_activity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sends (
 email_hash TEXT NOT NULL, ip TEXT NOT NULL, created_at INTEGER NOT NULL,
 delivery TEXT NOT NULL DEFAULT 'ineligible', challenge_id TEXT
);
CREATE INDEX IF NOT EXISTS auth_sends_time ON auth_sends(created_at);
CREATE TABLE IF NOT EXISTS auth_work (
 user_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_work_time ON auth_work(created_at);
CREATE TABLE IF NOT EXISTS auth_settings (
 name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_legacy_bindings (
 legacy_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bound_at INTEGER NOT NULL
);
"""


@dataclass(frozen=True)
class Principal:
    id: str
    email: str
    is_admin: bool


class UserDTO(TypedDict):
    id: str
    email: str
    is_admin: bool
    invite_limit: int
    disabled: bool


class InviteDTO(TypedDict):
    id: str
    code: str | None
    status: Literal["pending", "activated", "revoked"]
    recipient_email: str | None
    activated_at: int | None
    created_at: int


class ProfileDTO(TypedDict):
    id: str
    email: str
    is_admin: bool
    invite_limit: int
    invites: list[InviteDTO]


def initialize() -> None:
    with db._session() as conn:
        conn.executescript(SCHEMA)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _mac(secret: str, value: str) -> str:
    if len(secret.encode()) < 32:
        raise RuntimeError("Authentication secrets must be at least 32 bytes")
    return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def invite_code(invite_id: str) -> str:
    return _mac(config.AUTH_INVITE_SECRET, "invite-code:" + invite_id)


def _user(row: sqlite3.Row) -> UserDTO:
    return {
        "id": row["id"],
        "email": row["email"],
        "is_admin": bool(row["is_admin"]),
        "invite_limit": row["invite_limit"],
        "disabled": bool(row["disabled"]),
    }


def create_invite(owner_id: str | None) -> tuple[str, str]:
    invite_id = secrets.token_hex(16)
    code = invite_code(invite_id)
    with db._session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if owner_id is not None:
            user = conn.execute(
                "SELECT * FROM auth_users WHERE id=? AND disabled=0", (owner_id,)
            ).fetchone()
            if user is None:
                raise ValueError("Account unavailable")
            used = conn.execute(
                "SELECT count(*) FROM auth_invites WHERE owner_id=? AND revoked=0",
                (owner_id,),
            ).fetchone()[0]
            if used >= user["invite_limit"]:
                raise ValueError("Invitation allowance reached")
        conn.execute(
            "INSERT INTO auth_invites (id,verifier,owner_id,created_at) "
            "VALUES (?,?,?,?)",
            (invite_id, _hash(code), owner_id, int(time.time())),
        )
    return invite_id, code


def revoke_invite(invite_id: str, owner_id: str | None = None) -> bool:
    with db._session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        sql = (
            "UPDATE auth_invites SET revoked=1 WHERE id=? AND revoked=0 "
            "AND recipient_id IS NULL"
        )
        args = [invite_id]
        if owner_id is not None:
            sql += " AND owner_id=?"
            args.append(owner_id)
        return conn.execute(sql, args).rowcount == 1


def profile(user_id: str) -> ProfileDTO | None:
    with db._session() as conn:
        row = conn.execute(
            "SELECT * FROM auth_users WHERE id=? AND disabled=0", (user_id,)
        ).fetchone()
        if row is None:
            return None
        invites = conn.execute(
            "SELECT i.*, u.email recipient_email FROM auth_invites i "
            "LEFT JOIN auth_users u ON u.id=i.recipient_id WHERE i.owner_id=? "
            "ORDER BY i.created_at, i.id",
            (user_id,),
        ).fetchall()
        return ProfileDTO(
            id=row["id"],
            email=row["email"],
            is_admin=bool(row["is_admin"]),
            invite_limit=row["invite_limit"],
            invites=[
                InviteDTO(
                    id=i["id"],
                    code=invite_code(i["id"])
                    if not i["revoked"] and i["recipient_id"] is None
                    else None,
                    status="revoked"
                    if i["revoked"]
                    else "activated"
                    if i["recipient_id"]
                    else "pending",
                    recipient_email=i["recipient_email"],
                    activated_at=i["activated_at"],
                    created_at=i["created_at"],
                )
                for i in invites
            ],
        )


def start(email: str, invite: str | None, ip: str) -> tuple[str, str] | None:
    """Reserve a rate-limited challenge with generic ineligible responses."""
    now = int(time.time())
    email_hash = _mac(config.AUTH_OTP_SECRET, "email:" + email)
    invite_hash = _hash(invite) if invite else ""
    challenge_id = secrets.token_hex(16)
    code = f"{secrets.randbelow(1000000):06d}"
    with db._session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM auth_sends WHERE created_at < ?", (now - 86400,))
        conn.execute("DELETE FROM auth_challenges WHERE expires_at <= ?", (now,))
        recent_email = conn.execute(
            "SELECT count(*) FROM auth_sends WHERE email_hash=? AND created_at>?",
            (email_hash, now - 60),
        ).fetchone()[0]
        hourly_email = conn.execute(
            "SELECT count(*) FROM auth_sends WHERE email_hash=? AND created_at>?",
            (email_hash, now - 3600),
        ).fetchone()[0]
        hourly_ip = conn.execute(
            "SELECT count(*) FROM auth_sends WHERE ip=? AND created_at>?",
            (ip, now - 3600),
        ).fetchone()[0]
        if recent_email or hourly_email >= 5 or hourly_ip >= 20:
            return None
        conn.execute(
            "INSERT INTO auth_sends(email_hash,ip,created_at,challenge_id) "
            "VALUES (?,?,?,?)",
            (email_hash, ip, now, challenge_id),
        )
        user = conn.execute(
            "SELECT * FROM auth_users WHERE email=?", (email,)
        ).fetchone()
        valid_invite = (
            invite
            and conn.execute(
                "SELECT 1 FROM auth_invites i "
                "LEFT JOIN auth_users u ON u.id=i.owner_id "
                "WHERE i.verifier=? AND i.revoked=0 AND i.recipient_id IS NULL "
                "AND (i.owner_id IS NULL OR u.disabled=0)",
                (invite_hash,),
            ).fetchone()
        )
        if (invite and (user is not None or not valid_invite)) or (
            not invite and (user is None or user["disabled"])
        ):
            return None
        global_hour = conn.execute(
            "SELECT count(*) FROM auth_sends "
            "WHERE created_at>? AND delivery != 'ineligible'",
            (now - 3600,),
        ).fetchone()[0]
        if global_hour >= 100:
            return None
        conn.execute(
            "UPDATE auth_sends SET delivery='attempted' WHERE challenge_id=?",
            (challenge_id,),
        )
        conn.execute(
            "DELETE FROM auth_challenges WHERE email=? AND invite_hash=?",
            (email, invite_hash),
        )
        verifier = _mac(
            config.AUTH_OTP_SECRET, f"otp:{challenge_id}:{email}:{invite_hash}:{code}"
        )
        conn.execute(
            "INSERT INTO auth_challenges (id,email,invite_hash,verifier,expires_at) "
            "VALUES (?,?,?,?,?)",
            (challenge_id, email, invite_hash, verifier, now + OTP_TTL),
        )
    return challenge_id, code


def delivery_failed(challenge_id: str) -> None:
    with db._session() as conn:
        conn.execute(
            "UPDATE auth_sends SET delivery='failed' WHERE challenge_id=?",
            (challenge_id,),
        )


def verify(email: str, code: str, invite: str | None) -> tuple[str, Principal] | None:
    now = int(time.time())
    invite_hash = _hash(invite) if invite else ""
    with db._session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        challenge = conn.execute(
            "SELECT * FROM auth_challenges WHERE email=? AND invite_hash=? "
            "ORDER BY rowid DESC LIMIT 1",
            (email, invite_hash),
        ).fetchone()
        if (
            not challenge
            or challenge["expires_at"] <= now
            or challenge["attempts"] >= 5
        ):
            return None
        conn.execute(
            "UPDATE auth_challenges SET attempts=attempts+1 WHERE id=?",
            (challenge["id"],),
        )
        expected = _mac(
            config.AUTH_OTP_SECRET,
            f"otp:{challenge['id']}:{email}:{invite_hash}:{code}",
        )
        if not hmac.compare_digest(expected, challenge["verifier"]):
            return None
        if invite:
            invitation = conn.execute(
                "SELECT i.* FROM auth_invites i "
                "LEFT JOIN auth_users u ON u.id=i.owner_id "
                "WHERE i.verifier=? AND i.revoked=0 AND i.recipient_id IS NULL "
                "AND (i.owner_id IS NULL OR u.disabled=0)",
                (invite_hash,),
            ).fetchone()
            if (
                invitation is None
                or conn.execute(
                    "SELECT 1 FROM auth_users WHERE email=?", (email,)
                ).fetchone()
            ):
                return None
            user_id = "acct:" + secrets.token_hex(16)
            is_admin = email == config.AUTH_ADMIN_EMAIL
            conn.execute(
                "INSERT INTO auth_users(id,email,is_admin) VALUES (?,?,?)",
                (user_id, email, int(is_admin)),
            )
            conn.execute(
                "UPDATE auth_invites SET recipient_id=?, activated_at=? WHERE id=?",
                (user_id, now, invitation["id"]),
            )
            principal = Principal(user_id, email, is_admin)
        else:
            user = conn.execute(
                "SELECT * FROM auth_users WHERE email=? AND disabled=0", (email,)
            ).fetchone()
            if user is None:
                return None
            principal = Principal(user["id"], user["email"], bool(user["is_admin"]))
        conn.execute("DELETE FROM auth_challenges WHERE id=?", (challenge["id"],))
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO auth_sessions VALUES (?,?,?)",
            (_hash(token), principal.id, now),
        )
        return token, principal


def authenticate(token: str, *, activity: bool = False) -> Principal | None:
    now = int(time.time())
    with db._session() as conn:
        if activity:
            conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT u.*,s.last_activity FROM auth_sessions s "
            "JOIN auth_users u ON u.id=s.user_id WHERE s.verifier=?",
            (_hash(token),),
        ).fetchone()
        if row is None or row["disabled"] or row["last_activity"] <= now - SESSION_IDLE:
            return None
        if activity:
            conn.execute(
                "UPDATE auth_sessions SET last_activity=? WHERE verifier=?",
                (now, _hash(token)),
            )
        return Principal(row["id"], row["email"], bool(row["is_admin"]))


def revoke_session(token: str) -> None:
    with db._session() as conn:
        conn.execute("DELETE FROM auth_sessions WHERE verifier=?", (_hash(token),))


def users() -> list[UserDTO]:
    with db._session() as conn:
        return [
            _user(r) for r in conn.execute("SELECT * FROM auth_users ORDER BY email")
        ]


def update_user(
    user_id: str, invite_limit: int | None = None, disabled: bool | None = None
) -> UserDTO | None:
    with db._session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if invite_limit is not None:
            if invite_limit < 0:
                raise ValueError("Invalid invitation limit")
            conn.execute(
                "UPDATE auth_users SET invite_limit=? WHERE id=?",
                (invite_limit, user_id),
            )
        if disabled is not None:
            conn.execute(
                "UPDATE auth_users SET disabled=? WHERE id=?", (int(disabled), user_id)
            )
            if disabled:
                conn.execute("DELETE FROM auth_sessions WHERE user_id=?", (user_id,))
        row = conn.execute("SELECT * FROM auth_users WHERE id=?", (user_id,)).fetchone()
        return _user(row) if row else None


def revoke_user_sessions(user_id: str) -> bool:
    with db._session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        exists = conn.execute(
            "SELECT 1 FROM auth_users WHERE id=?", (user_id,)
        ).fetchone()
        if exists:
            conn.execute("DELETE FROM auth_sessions WHERE user_id=?", (user_id,))
        return bool(exists)


def bind_legacy(legacy_id: str, user_id: str) -> None:
    if legacy_id.startswith("acct:"):
        raise ValueError("Not a legacy session identifier")
    with db._session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if not conn.execute(
            "SELECT 1 FROM auth_users WHERE id=?", (user_id,)
        ).fetchone():
            raise ValueError("Account not found")
        if not conn.execute(
            "SELECT 1 FROM jobs WHERE session_id=? "
            "UNION SELECT 1 FROM song_searches WHERE session_id=?",
            (legacy_id, legacy_id),
        ).fetchone():
            raise ValueError("Legacy session has no records")
        conn.execute(
            "INSERT INTO auth_legacy_bindings VALUES (?,?,?)",
            (legacy_id, user_id, int(time.time())),
        )
        conn.execute(
            "UPDATE jobs SET session_id=? WHERE session_id=?", (user_id, legacy_id)
        )
        conn.execute(
            "UPDATE song_searches SET session_id=? WHERE session_id=?",
            (user_id, legacy_id),
        )


def setting(conn: sqlite3.Connection, name: str, default: int) -> int:
    row = conn.execute(
        "SELECT value FROM auth_settings WHERE name=?", (name,)
    ).fetchone()
    return row["value"] if row else default


def reserve_work(user_id: str) -> bool:
    now = int(time.time())
    with db._session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM auth_work WHERE created_at<?", (now - 86400,))
        own = conn.execute(
            "SELECT count(*) FROM auth_work WHERE user_id=?", (user_id,)
        ).fetchone()[0]
        total = conn.execute("SELECT count(*) FROM auth_work").fetchone()[0]
        if own >= setting(conn, "user_daily_work", 50) or total >= setting(
            conn, "global_daily_work", 500
        ):
            return False
        conn.execute("INSERT INTO auth_work VALUES (?,?)", (user_id, now))
        return True
