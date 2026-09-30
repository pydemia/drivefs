# @pydemia/drivefs-microsoft

OneDrive Personal and SharePoint document library backends for `drivefs`.
Supply a delegated Graph token through a caller-owned credential store. The
package does not save credentials or install a provider SDK.

```js
import {
  GraphAuth,
  MemoryCredentialStore,
  OneDriveStorage,
} from "@pydemia/drivefs-microsoft";

const auth = new GraphAuth({
  tenant_id: "consumers",
  client_id: process.env.MS_CLIENT_ID,
  store: new MemoryCredentialStore({ access_token: process.env.MS_ACCESS_TOKEN }),
});
const storage = new OneDriveStorage({
  driveId: "personal-drive-id",
  rootId: "selected-root-item-id",
  auth,
});
const entry = await storage.stat("/report.csv");
```

For SharePoint use a tenant-specific `GraphAuth` and `SharePointStorage` with
`siteId`, `driveId`, and `rootId`. In production, provide a persistent store
that implements `load()` and `save()` so refresh-token rotation is retained.
The caller obtains initial consent and tokens. Real-account verification is
required before v1.0.0 release.

MSAL does not expose refresh tokens. Apps using MSAL can implement
`GraphAccessTokenProvider.access_token()` with `acquireTokenSilent()` and
pass it as `auth`. See the [app authentication guide](../../../docs/app-auth.md).

Each HTTP request, including reading its response body, has a five-minute
deadline by default. Set `timeoutMs` on either storage class when a large
transfer needs a longer deadline. A stalled request raises a storage error.
