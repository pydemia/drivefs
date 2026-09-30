# drivefs 사용 가이드

상태: 0.1.0 구현 후보 · 2026-09-30. 실제 계정 검증 후에야 v1.0.0으로
배포한다. 정확한 연산·오류 규칙은 [API 명세](../spec/storage-api.md)를
따른다.

## 설치와 의존성

```text
Python: pip install drivefs-gdrive
        pip install drivefs-microsoft
        pip install drivefs-fsspec
Node:   npm install @pydemia/drivefs-gdrive
        npm install @pydemia/drivefs-microsoft
```

이 명령은 registry에 게시된 뒤 사용한다. 현재 검증은 저장소에서 빌드한
wheel·tarball로 했다. core 단독 설치에는 provider 관련 runtime
의존성이 없다. `drivefs-fsspec`은 provider를 설치하지 않는다.

## 공개 API

Python은 동기식, Node.js는 비동기식이다. 두 언어에서 같은
`stat`, `exists`, `list`, `read`, `open_reader`, `read_range`, `write`,
`mkdir`, `move`, `delete` 연산을 제공한다. `StorageEntry.ref`는 생성한
storage 인스턴스 안에서만 사용한다. 경로는 선택한 root 기준이다.
`list`는 직계 자식 iterator이며 `delete`는 provider 휴지통으로 보낸다.
`read`는 전체 파일을 메모리에 적재하므로 큰 파일에는 `open_reader`
또는 `read_range`를 쓴다.

## 인증과 root 선택

초기 OAuth 동의·토큰 발급은 호출 애플리케이션이 수행한다. provider
package는 이미 발급된 delegated token을 받아 만료 시 갱신하거나,
앱이 제공한 token provider에서 현재 토큰을 가져온다. 지속 실행 앱의
로그인, 영속 cache, 갱신, 재인증 흐름은 [앱 인증 설계](app-auth.md)에
정리했다. 아래 예시는 API 형태를 보여주기 위한 자리표시자다.
`MemoryCredentialStore`는 예제·단기 실행용이며, 장기 실행에는
`load`와 `save`를 구현한 영속 저장소가 필요하다. refresh token이
회전하면 `save` 결과가 보존되어야 한다. 토큰·client secret은 로그,
이미지, 저장소에 넣지 않는다.

Google에서는 접근 가능한 My Drive folder ID를 `root_id`/`rootId`로
지정한다. [Google의 scope 안내](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)는
`drive.file`을 앱이 만들거나 사용자가 앱에 제공한 파일에 대한 제한된
접근으로 설명한다. 기존 임의의 파일·폴더 접근이 필요하면 더 넓은
scope와 Google의 검증 요건을 별도로 확인해야 한다.

OneDrive Personal은 `tenant_id="consumers"`를 사용하고 해당 drive와
root item ID를 지정한다. SharePoint는 tenant ID, site ID, 해당 site의
document library drive ID, root item ID를 명시한다. Graph의
[site drive 목록](https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0)과
[upload session](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)은
delegated `Files.ReadWrite`를 허용하지만, 실제 tenant의 동의·정책과
대상 library 접근 권한은 별도로 검증해야 한다. 장기 사용을 위한
refresh token 발급도 애플리케이션의 초기 OAuth 설정에서 처리한다.

### Python

```python
from drivefs_gdrive import (
    GoogleAuth, GoogleDriveStorage, GoogleToken,
    MemoryCredentialStore as GoogleStore,
)
from drivefs_microsoft import (
    GraphAuth, GraphToken, MemoryCredentialStore as GraphStore,
    OneDriveStorage, SharePointStorage,
)

google = GoogleDriveStorage(
    root_id="selected-my-drive-folder-id",
    auth=GoogleAuth(
        store=GoogleStore(GoogleToken(access_token="issued-access-token")),
        client_id="oauth-client-id", client_secret="oauth-client-secret",
    ),
)
personal = OneDriveStorage(
    drive_id="personal-drive-id", root_id="selected-root-item-id",
    auth=GraphAuth(
        tenant_id="consumers", client_id="oauth-client-id",
        store=GraphStore(GraphToken(access_token="issued-access-token")),
    ),
)
sharepoint = SharePointStorage(
    site_id="site-id", drive_id="document-library-drive-id",
    root_id="selected-root-item-id",
    auth=GraphAuth(
        tenant_id="tenant-id", client_id="oauth-client-id",
        store=GraphStore(GraphToken(access_token="issued-access-token")),
    ),
)
```

실제 토큰은 앱의 OAuth 로그인과 영속 credential store에서 받는다. 직접 만든
`httpx.Client`를 주입하지 않았다면 storage의 `close()` 또는 context
manager로 연결을 정리한다.

### Node.js

```js
import {
  GoogleAuth, GoogleDriveStorage,
  MemoryCredentialStore as GoogleStore,
} from "@pydemia/drivefs-gdrive";
import {
  GraphAuth, MemoryCredentialStore as GraphStore,
  OneDriveStorage, SharePointStorage,
} from "@pydemia/drivefs-microsoft";

const google = new GoogleDriveStorage({
  rootId: "selected-my-drive-folder-id",
  auth: new GoogleAuth({
    store: new GoogleStore({ access_token: process.env.GOOGLE_ACCESS_TOKEN }),
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
  }),
});
const personal = new OneDriveStorage({
  driveId: "personal-drive-id", rootId: "selected-root-item-id",
  auth: new GraphAuth({
    tenant_id: "consumers", client_id: process.env.MS_CLIENT_ID,
    store: new GraphStore({ access_token: process.env.MS_ACCESS_TOKEN }),
  }),
});
const sharepoint = new SharePointStorage({
  siteId: "site-id", driveId: "document-library-drive-id",
  rootId: "selected-root-item-id",
  auth: new GraphAuth({
    tenant_id: "tenant-id", client_id: process.env.MS_CLIENT_ID,
    store: new GraphStore({ access_token: process.env.MS_ACCESS_TOKEN }),
  }),
});
```

운영 앱에서는 이 환경 변수 예시 대신 사용자별 OAuth 연결과 영속
store 또는 SDK token cache를 사용한다. 메모리 저장소는 프로세스를
다시 시작하면 token을 잃는다.
Node provider의 각 HTTP 요청은 응답 본문 읽기를 포함해 기본 5분
deadline이 있다. 느린 대용량 전송에는 storage 생성자의 `timeoutMs`를
양의 정수 밀리초로 늘린다.

## 파일 작업과 대용량 전송

```python
from pathlib import Path

source = Path("large.bin")
storage.mkdir("/uploads")
with source.open("rb") as reader:
    entry = storage.write("/uploads/large.bin", reader, size=source.stat().st_size)
with storage.open_reader(entry.ref) as reader:
    first_megabyte = reader.read(1024 * 1024)
```

```js
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const size = (await stat("large.bin")).size;
await storage.mkdir("/uploads");
const entry = await storage.write(
  "/uploads/large.bin", createReadStream("large.bin"), { size },
);
let downloadedBytes = 0;
for await (const chunk of storage.open_reader(entry.ref)) {
  downloadedBytes += chunk.length;
}
```

스트리밍 업로드에는 전체 크기를 명시해야 한다. 크기 불일치 시
`InvalidUploadSourceError`, 완료 상태가 확인되지 않으면
`IndeterminateOperationError`를 받는다. Graph upload URL은 임시 서명
URL이며 bearer token을 실어 보내지 않는다.

## 교체와 동시 수정

현재 세 provider 구현의 `conditional_replace`는 모두 `false`다.
따라서 원격 파일의 변경을 원자적으로 보호해야 한다면 지금은 교체
요청을 거부해야 한다. 나중에 해당 capability가 실제 계정에서 검증되어
`true`가 되면, `stat`에서 얻은 불투명 `version`을 `expected_version`에
전달한다.

```python
current = storage.stat("/report.bin")
if not storage.capabilities.conditional_replace or current.version is None:
    raise RuntimeError("atomic replacement is unavailable")
storage.write(
    "/report.bin", b"new data", overwrite=True,
    expected_version=current.version,
)
```

`overwrite=True`만 전달한 교체는 현재 지원하지만 다른 사용자의 변경을
덮을 수 있다. 버전 값을 먼저 비교하는 애플리케이션 검사만으로는
비교와 전송 사이의 경쟁을 막을 수 없다.

## fsspec

```python
from drivefs_fsspec import DriveFSFileSystem

fs = DriveFSFileSystem(storage=google)
print(fs.ls("/uploads", detail=True))
with fs.open("/uploads/large.bin", "rb") as reader:
    reader.seek(4096)
    block = reader.read(512)
```

adapter의 seek는 `read_range`를 사용한다. 버전이 제공되어 읽기 사이에
변경을 감지하면 `ConflictError`를 낸다. 원격 응답의 원자적 snapshot은
보장하지 않는다. 읽기 전용이므로 `wb`, `xb`, append, 삭제·이동은
거부한다. provider에 쓰려면 `FileStorage.write`를 직접 사용한다.

## provider 제한

| 영역 | 0.1.0 제한 |
| --- | --- |
| Google | My Drive의 지정 폴더만 지원. Google 문서·shortcut은 `other`로 목록에 보이지만 바이너리 읽기·변경 불가 |
| OneDrive | Personal drive만 지원. business drive와 app-only auth 제외 |
| SharePoint | 지정 tenant·site·document library만 지원. site 자동 검색과 일반 list 제외 |
| 공통 | 조건부 교체 미검증, 영구 삭제·복구·공유 링크·cross-provider 이동·mount 제외 |

현재 HTTP fixture와 컨테이너 검증의 범위 및 v1.0.0 남은 조건은
[검증 기록](validation.md)에 있다.
