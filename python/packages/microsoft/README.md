# drivefs-microsoft

OneDrive Personal and SharePoint document library backends for `drivefs`.
The caller owns initial delegated OAuth consent and credential persistence.

```python
from drivefs_microsoft import (
    GraphAuth,
    GraphToken,
    MemoryCredentialStore,
    OneDriveStorage,
    SharePointStorage,
)

auth = GraphAuth(
    tenant_id="consumers",
    client_id="oauth-client-id",
    store=MemoryCredentialStore(GraphToken("issued-access-token")),
)
with OneDriveStorage(
    drive_id="personal-drive-id",
    root_id="selected-root-item-id",
    auth=auth,
) as storage:
    entry = storage.stat("/report.csv")
```

For SharePoint use a tenant-specific `GraphAuth` and
`SharePointStorage(site_id=..., drive_id=..., root_id=..., auth=...)`.
Provide a persistent `GraphCredentialStore` with `load()` and `save()` for
long-lived use; refresh-token rotation is saved before the token is used.
Memory storage loses credentials when the process exits. `conditional_replace`
is false until real-account behavior is verified. Real-account integration
remains a v1.0.0 release gate. See the [usage guide](../../../docs/usage.md)
for scopes and streaming examples.
