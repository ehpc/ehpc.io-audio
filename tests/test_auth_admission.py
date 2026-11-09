"""Admission accounting and disabled issuer policy."""

from backend import auth_store


def test_unknown_addresses_do_not_exhaust_global_mail_budget():
    for i in range(120):
        assert (
            auth_store.start(f"unknown{i}@example.com", None, f"192.0.2.{i // 20 + 1}")
            is None
        )
    _, invite = auth_store.create_invite(None)
    assert auth_store.start("valid@example.com", invite, "198.51.100.1") is not None


def test_disabling_issuer_blocks_pending_invite_even_after_challenge(client):
    owner_id = client.get("/api/auth/me").json()["id"]
    _, code = auth_store.create_invite(owner_id)
    challenge = auth_store.start("recipient@example.com", code, "198.51.100.1")
    assert challenge is not None
    auth_store.update_user(owner_id, disabled=True)
    assert auth_store.verify("recipient@example.com", challenge[1], code) is None
    assert auth_store.start("other@example.com", code, "198.51.100.2") is None
