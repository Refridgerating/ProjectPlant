from __future__ import annotations

from fastapi import Depends, Header, HTTPException, Request, status

from auth.jwt import AuthTokenError, verify_access_token
from models import AuthenticatedPrincipal
from services.iam_store import iam_store


def request_remote_addr(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded.strip():
        return forwarded.split(",", 1)[0].strip() or None
    if request.client is None:
        return None
    return request.client.host


def request_user_agent(request: Request) -> str | None:
    user_agent = request.headers.get("user-agent", "").strip()
    return user_agent or None


def require_localhost(request: Request) -> None:
    host = request_remote_addr(request)
    request_host = (request.url.hostname or "").strip().lower()
    if host not in {"127.0.0.1", "::1", "localhost", "testclient"} and request_host not in {
        "127.0.0.1",
        "::1",
        "localhost",
        "testserver",
    }:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This endpoint is only available from localhost")


def get_current_principal(
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> AuthenticatedPrincipal:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authorization header")
    scheme, _, raw_token = authorization.partition(" ")
    if scheme.strip().lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authorization scheme")
    token = raw_token.strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    try:
        claims = verify_access_token(token)
        return iam_store.principal_from_claims(claims)
    except (AuthTokenError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc


def require_master(
    principal: AuthenticatedPrincipal = Depends(get_current_principal),
) -> AuthenticatedPrincipal:
    if principal.systemRole != "master":
        iam_store.audit_event(
            actor_account_id=principal.accountId,
            actor_role=principal.systemRole,
            event_type="authz.master_required",
            outcome="denied",
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Master access required")
    if principal.mfaRequired and not principal.mfaSatisfied:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="MFA verification required")
    return principal


def require_primary_master(
    principal: AuthenticatedPrincipal = Depends(require_master),
) -> AuthenticatedPrincipal:
    if not principal.isPrimaryMaster:
        iam_store.audit_event(
            actor_account_id=principal.accountId,
            actor_role=principal.systemRole,
            event_type="authz.primary_master_required",
            outcome="denied",
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Primary master access required")
    return principal
