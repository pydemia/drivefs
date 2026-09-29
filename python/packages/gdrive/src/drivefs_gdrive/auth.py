"""Caller-owned Google OAuth credentials and serialized refresh."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Protocol

import httpx
from drivefs import AuthenticationError

TOKEN_URL = "https://oauth2.googleapis.com/token"


@dataclass(frozen=True, slots=True, repr=False)
class GoogleToken:
    access_token: str
    refresh_token: str | None = None
    expires_at: datetime | None = None


class GoogleCredentialStore(Protocol):
    """The caller decides how credentials are persisted and protected."""

    def load(self) -> GoogleToken | None: ...

    def save(self, token: GoogleToken) -> None: ...


class MemoryCredentialStore:
    """Explicit in-process store for tests and short-lived applications."""

    def __init__(self, token: GoogleToken | None = None) -> None:
        self._token = token

    def load(self) -> GoogleToken | None:
        return self._token

    def save(self, token: GoogleToken) -> None:
        self._token = token


class GoogleAuth:
    """Get tokens and refresh them before use through the caller's store."""

    def __init__(
        self,
        *,
        store: GoogleCredentialStore,
        client_id: str | None = None,
        client_secret: str | None = None,
    ) -> None:
        self._store = store
        self._client_id = client_id
        self._client_secret = client_secret
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
                raise AuthenticationError("no Google access token is available")
            if force_refresh and failed_token and token.access_token != failed_token:
                return token.access_token
            if not force_refresh and not self._expires_soon(token):
                return token.access_token
            if not (token.refresh_token and self._client_id and self._client_secret):
                raise AuthenticationError("Google token refresh is unavailable")
            try:
                response = client.post(
                    TOKEN_URL,
                    data={
                        "client_id": self._client_id,
                        "client_secret": self._client_secret,
                        "refresh_token": token.refresh_token,
                        "grant_type": "refresh_token",
                    },
                )
                if response.status_code != 200:
                    raise AuthenticationError("Google token refresh was rejected")
                payload = response.json()
                new_access_token = payload["access_token"]
                expires_in = payload.get("expires_in")
                if not isinstance(new_access_token, str) or not new_access_token:
                    raise AuthenticationError("Google token refresh was invalid")
                expires_at = (
                    datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))
                    if expires_in is not None
                    else None
                )
                updated = GoogleToken(
                    access_token=new_access_token,
                    refresh_token=payload.get("refresh_token") or token.refresh_token,
                    expires_at=expires_at,
                )
                self._store.save(updated)
                return updated.access_token
            except AuthenticationError:
                raise
            except (httpx.RequestError, ValueError, KeyError, TypeError):
                raise AuthenticationError("Google token refresh failed") from None
            except Exception:
                raise AuthenticationError("credential save failed") from None

    @staticmethod
    def _expires_soon(token: GoogleToken) -> bool:
        if token.expires_at is None:
            return False
        if token.expires_at.tzinfo is None:
            raise AuthenticationError("token expiry must include a timezone")
        return token.expires_at <= datetime.now(timezone.utc) + timedelta(seconds=60)
