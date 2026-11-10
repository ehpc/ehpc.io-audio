"""Invite-only email authentication and small administrator API."""

import asyncio
import ipaddress
import logging
import re

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend import auth_store, config, mailer

log = logging.getLogger(__name__)
router = APIRouter(tags=["auth"])


def cookie_name() -> str:
    return "__Host-auth_session" if config.auth_cookie_secure() else "auth_session"


GENERIC = {"message": "If eligible, a verification code will be sent."}


class StartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(max_length=254)
    invite_code: str | None = Field(default=None, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize(cls, value: str) -> str:
        value = value.strip().lower()
        if not re.fullmatch(
            r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?",
            value,
            re.ASCII,
        ):
            raise ValueError("Invalid email address")
        return value


class VerifyRequest(StartRequest):
    code: str = Field(pattern=r"^\d{6}$")


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invite_limit: int | None = Field(default=None, ge=0, strict=True)
    disabled: bool | None = Field(default=None, strict=True)


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    try:
        address = ipaddress.ip_address(peer)
        trusted = [
            ipaddress.ip_network(v.strip())
            for v in config.AUTH_TRUSTED_PROXY_CIDRS.split(",")
            if v.strip()
        ]
        if not any(address in network for network in trusted):
            return peer
        real_ips = request.headers.getlist("x-real-ip")
        if len(real_ips) != 1:
            return peer
        return str(ipaddress.ip_address(real_ips[0].strip()))
    except ValueError:
        return peer


def principal(request: Request) -> auth_store.Principal:
    user = getattr(request.state, "principal", None)
    if user is None:
        raise HTTPException(401, "Authentication required")
    return user


def admin(request: Request) -> auth_store.Principal:
    user = principal(request)
    if not user.is_admin:
        raise HTTPException(403, "Administrator required")
    return user


def deliver(challenge_id: str, email: str, code: str) -> None:
    try:
        mailer.send_code(email, code)
    except Exception as exc:
        auth_store.delivery_failed(challenge_id)
        log.error(
            "Authentication mail submission uncertain: challenge=%s error=%s",
            challenge_id,
            type(exc).__name__,
        )


@router.post("/auth/start", status_code=202)
async def start(
    body: StartRequest, request: Request, background: BackgroundTasks
) -> dict:
    try:
        challenge = await asyncio.to_thread(
            auth_store.start, body.email, body.invite_code, client_ip(request)
        )
    except RuntimeError:
        raise HTTPException(503, "Authentication unavailable") from None
    if challenge:
        background.add_task(deliver, challenge[0], body.email, challenge[1])
    return GENERIC


@router.post("/auth/verify")
async def verify(body: VerifyRequest, response: Response) -> dict:
    try:
        result = await asyncio.to_thread(
            auth_store.verify, body.email, body.code, body.invite_code
        )
    except RuntimeError:
        raise HTTPException(503, "Authentication unavailable") from None
    if result is None:
        raise HTTPException(400, "Invalid or expired code")
    token, user = result
    response.set_cookie(
        cookie_name(),
        token,
        max_age=auth_store.SESSION_IDLE,
        httponly=True,
        secure=config.auth_cookie_secure(),
        samesite="lax",
        path="/",
    )
    return {"email": user.email}


@router.get("/auth/me")
async def me(request: Request) -> auth_store.ProfileDTO:
    result = await asyncio.to_thread(auth_store.profile, principal(request).id)
    if result is None:
        raise HTTPException(401, "Authentication required")
    return result


@router.post("/auth/activity", status_code=204)
async def activity(request: Request) -> Response:
    principal(request)
    return Response(status_code=204)


@router.post("/auth/logout", status_code=204)
async def logout(request: Request, response: Response) -> Response:
    principal(request)
    await asyncio.to_thread(auth_store.revoke_session, request.cookies[cookie_name()])
    response.delete_cookie(
        cookie_name(), secure=config.auth_cookie_secure(), httponly=True, samesite="lax"
    )
    response.status_code = 204
    return response


@router.post("/auth/invites")
async def issue(request: Request) -> dict:
    try:
        invite_id, code = await asyncio.to_thread(
            auth_store.create_invite, principal(request).id
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    return {"id": invite_id, "code": code}


@router.delete("/auth/invites/{invite_id}", status_code=204)
async def revoke(invite_id: str, request: Request) -> Response:
    admin(request)
    if not await asyncio.to_thread(auth_store.revoke_invite, invite_id):
        raise HTTPException(404, "Invitation not found or already activated")
    return Response(status_code=204)


@router.get("/admin/users")
async def list_users(request: Request) -> list[auth_store.UserDTO]:
    admin(request)
    return await asyncio.to_thread(auth_store.users)


@router.patch("/admin/users/{user_id}")
async def patch_user(
    user_id: str, body: UserUpdate, request: Request
) -> auth_store.UserDTO:
    admin(request)
    try:
        user = await asyncio.to_thread(
            auth_store.update_user, user_id, body.invite_limit, body.disabled
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    if user is None:
        raise HTTPException(404, "Account not found")
    return user


@router.post("/admin/users/{user_id}/revoke-sessions", status_code=204)
async def revoke_sessions(user_id: str, request: Request) -> Response:
    admin(request)
    if not await asyncio.to_thread(auth_store.revoke_user_sessions, user_id):
        raise HTTPException(404, "Account not found")
    return Response(status_code=204)


@router.post("/admin/users/{user_id}/invite-slot")
async def grant_slot(user_id: str, request: Request) -> auth_store.UserDTO:
    admin(request)
    try:
        user = await asyncio.to_thread(auth_store.grant_invite_slot, user_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    if user is None:
        raise HTTPException(404, "Account not found")
    return user


@router.get("/admin/users/{user_id}/activity")
async def activity_for_user(user_id: str, request: Request) -> auth_store.UserActivity:
    admin(request)
    result = await asyncio.to_thread(auth_store.user_activity, user_id)
    if result is None:
        raise HTTPException(404, "Account not found")
    return result
