# drivefs-gdrive

Google Drive My Drive folder backend for the `drivefs` high-level API.

```python
from drivefs_gdrive import (
    GoogleAuth,
    GoogleDriveStorage,
    GoogleToken,
    MemoryCredentialStore,
)

store = MemoryCredentialStore(GoogleToken("access-token-from-your-OAuth-flow"))
auth = GoogleAuth(store=store)

with GoogleDriveStorage(root_id="selected-folder-id", auth=auth) as storage:
    storage.mkdir("/reports")
    entry = storage.write("/reports/result.bin", b"data")
    assert storage.read(entry.ref) == b"data"
```

For a long-lived application, implement `GoogleCredentialStore.load()` and
`save()` using your own secure storage, and pass `client_id` and
`client_secret` to `GoogleAuth` to enable refresh. The provider writes a
refreshed token through `save()` before it uses that token. A failed save
raises `AuthenticationError`. The in-memory store above does not persist
credentials across processes. Construction does not open a browser or
write credentials to a global file.

The root must be a folder in My Drive that the authorized application can
access. `conditional_replace` is false until its provider behavior has
been verified with a real account. Current tests use HTTP fixtures;
real-account validation remains a v1.0.0 release gate.
