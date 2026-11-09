"""Resolve the authenticated account's stable ownership identifier."""

from fastapi import HTTPException, Request


def get_session_id(request: Request) -> str:
    user = getattr(request.state, "principal", None)
    if user is None:
        raise HTTPException(401, "Authentication required")
    return user.id
