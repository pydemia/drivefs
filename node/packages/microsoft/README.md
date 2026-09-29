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
const storage = new OneDriveStorage({ driveId, rootId, auth });
const entry = await storage.stat("/report.csv");
```

For SharePoint use a tenant-specific `GraphAuth` and `SharePointStorage` with
`siteId`, `driveId`, and `rootId`. In production, provide a persistent store
that implements `load()` and `save()` so refresh-token rotation is retained.
The caller obtains initial consent and tokens. Real-account verification is
required before v1.0.0 release.
