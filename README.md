# drivefs

라이선스: [Apache-2.0](LICENSE). 배포 의존성의 라이선스 검토는
[라이선스 검토](docs/license-review.md)에 기록했습니다.

Google Drive, OneDrive Personal, SharePoint document library를 애플리케이션의
파일 저장소로 사용하는 Python·Node.js 라이브러리입니다. 한 root 아래의
바이너리 파일과 디렉터리를 같은 `FileStorage` 연산으로 다룹니다.

현재 코드는 **0.1.0 구현 후보**입니다. Linux 컨테이너와 Linux·Windows·
macOS CI 행렬에서 fixture·배포물 설치 검증을 통과했습니다. 실제
provider 계정 검증과 게시 권한·라이선스 확정이 남아 있어 v1.0.0
배포 기준은 아직 충족하지 않았습니다.

## 패키지와 의존성

| 역할 | Python | Node.js |
| --- | --- | --- |
| 공통 API·오류·경로 규칙 | `drivefs` | `@pydemia/drivefs` |
| Google My Drive | `drivefs-gdrive` | `@pydemia/drivefs-gdrive` |
| OneDrive Personal·SharePoint | `drivefs-microsoft` | `@pydemia/drivefs-microsoft` |
| 읽기 전용 fsspec 연결 | `drivefs-fsspec` | 해당 없음 |

core에는 provider SDK, HTTP client, OAuth 라이브러리, fsspec 의존성이
없습니다. Python provider는 `drivefs`와 `httpx`, Node provider는
`@pydemia/drivefs`와 내장 `fetch`만 사용합니다. fsspec adapter는
`drivefs`와 `fsspec`에만 의존합니다.

```python
from drivefs_gdrive import GoogleDriveStorage

storage = GoogleDriveStorage(root_id="folder-id", auth=google_auth)
entry = storage.write("/report.bin", b"result")
payload = storage.read(entry.ref)
```

```js
import { GoogleDriveStorage } from "@pydemia/drivefs-gdrive";

const storage = new GoogleDriveStorage({ rootId: "folder-id", auth: googleAuth });
const entry = await storage.write("/report.bin", new Uint8Array([1, 2, 3]));
const payload = await storage.read(entry.ref);
```

`google_auth`와 `googleAuth`는 각 provider package의 인증 class로
생성하며, 초기 OAuth 동의와 credential 저장은 호출자가 담당합니다.
[설치·인증·사용 가이드](docs/usage.md)에 생성자 형태와 대용량 파일
예제가 있습니다.

## 문서

- [v1 기획서](docs/v1-plan.md) · [기획 review](docs/v1-review.md)
- [FileStorage API 명세](spec/storage-api.md)
- [구현계획](docs/implementation-plan.md) · [구현계획 review](docs/implementation-review.md)
- [사용 가이드](docs/usage.md) · [검증 기록](docs/validation.md) · [실제 계정 검증](docs/live-validation.md) · [release notes](docs/release-notes.md)
