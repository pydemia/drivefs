# @pydemia/drivefs-gdrive

Google Drive My Drive folder backend for the `FileStorage` API.

```js
import {
  GoogleAuth,
  GoogleDriveStorage,
  MemoryCredentialStore,
} from "@pydemia/drivefs-gdrive";

const store = new MemoryCredentialStore({
  access_token: "access-token-from-your-OAuth-flow",
});
const auth = new GoogleAuth({ store });
const storage = new GoogleDriveStorage({
  rootId: "selected-folder-id",
  auth,
});

await storage.mkdir("/reports");
const entry = await storage.write(
  "/reports/result.bin",
  new TextEncoder().encode("data"),
);
const payload = await storage.read(entry.ref);
```

For a long-lived application, implement `GoogleCredentialStore.load()` and
`save()` with your own secure storage and pass `client_id` and
`client_secret` to `GoogleAuth`. The provider saves a refreshed token
before using it. A failed save raises `AuthenticationError`. The in-memory
store above does not persist credentials across processes. Construction
does not open a browser or write credentials to a global file.

An app can instead implement `GoogleAccessTokenProvider.access_token()` and
pass it as `auth` to use its own OAuth SDK and token cache. See the
[app authentication guide](../../../docs/app-auth.md).

Each HTTP request, including reading its response body, has a five-minute
deadline by default. Set `timeoutMs` on `GoogleDriveStorage` when a large
transfer needs a longer deadline. A stalled request raises a storage error.

The root must be a folder in My Drive accessible to the authorized app.
`conditional_replace` is false until verified with a real account. HTTP
fixtures currently cover the implementation; real-account validation
remains a v1.0.0 release gate.
