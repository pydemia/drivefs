"""Caller-owned delegated Microsoft Graph OAuth credentials."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Protocol
from urllib.parse import quote

import httpx
from drivefs import AuthenticationError, InvalidArgumentError


@dataclass(frozen=True, slots=True, repr=False)
class GraphToken:
    access_token: str
    refresh_token: str | None = None
    expires_at: datetime | None = None


class GraphCredentialStore(Protocol):
    def load(self) -> GraphToken | None: ...

    def save(self, token: GraphToken) -> None: ...


class GraphAccessTokenProvider(Protocol):
    """Supply a token; raise AuthenticationError when login is required."""

    tenant_id: str

    def access_token(
        self,
        client: httpx.Client,
        *,
        force_refresh: bool = False,
        failed_token: str | None = None,
    ) -> str: ...


class MemoryCredentialStore:
    def __init__(self, token: GraphToken | None = None) -> None:
        self._token = token

    def load(self) -> GraphToken | None:
        return self._token

    def save(self, token: GraphToken) -> None:
        self._token = token


class GraphAuth:
    """Refresh delegated tokens and persist rotation through caller storage."""

    def __init__(
        self,
        *,
        tenant_id: str,
        client_id: str,
        store: GraphCredentialStore,
        client_secret: str | None = None,
        scopes: str | None = None,
    ) -> None:
        if not tenant_id or not client_id:
            raise InvalidArgumentError("tenant_id and client_id are required")
        self.tenant_id = tenant_id
        self._client_id = client_id
        self._client_secret = client_secret
        self._scopes = scopes
        self._store = store
        self._lock = Lock()

    def access_token(
        self,
        client: httpx.Client,
        *,
        force_refresh: bool = False,
        failed_token: str | None = None,
    ) -> str:
        with self._lock:
            try:
                token = self._store.load()
            except Exception:
                raise AuthenticationError("credential load failed") from None
            if token is None or not token.access_token:
                raise AuthenticationError("no Graph access token is available")
            if force_refresh and failed_token and token.access_token != failed_token:
                return token.access_token
            if not force_refresh and not self._expires_soon(token):
                return token.access_token
            if not token.refresh_token:
                raise AuthenticationError("Graph token refresh is unavailable")
            data = {
                "client_id": self._client_id,
                "refresh_token": token.refresh_token,
                "grant_type": "refresh_token",
            }
            if self._client_secret is not None:
                data["client_secret"] = self._client_secret
            if self._scopes is not None:
                data["scope"] = self._scopes
            url = (
                "https://login.microsoftonline.com/"
                f"{quote(self.tenant_id, safe='')}/oauth2/v2.0/token"
            )
            try:
                response = client.post(url, data=data)
                if response.status_code != 200:
                    raise AuthenticationError("Graph token refresh was rejected")
                payload = response.json()
                access_token = payload["access_token"]
                if not isinstance(access_token, str) or not access_token:
                    raise AuthenticationError("Graph token refresh was invalid")
                expires_in = payload.get("expires_in")
                updated = GraphToken(
                    access_token=access_token,
                    refresh_token=payload.get("refresh_token") or token.refresh_token,
                    expires_at=(
                        datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))
                        if expires_in is not None
                        else None
                    ),
                )
                self._store.save(updated)
                return updated.access_token
            except AuthenticationError:
                raise
            except (httpx.RequestError, ValueError, KeyError, TypeError):
                raise AuthenticationError("Graph token refresh failed") from None
            except Exception:
                raise AuthenticationError("credential save failed") from None

    @staticmethod
    def _expires_soon(token: GraphToken) -> bool:
        if token.expires_at is None:
            return False
        if token.expires_at.tzinfo is None:
            raise AuthenticationError("token expiry must include a timezone")
        return token.expires_at <= datetime.now(timezone.utc) + timedelta(seconds=60)
