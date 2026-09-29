# drivefs v1.0.0 개발 기획서

상태: 설계 확정 · 2026-09-30

## 목표와 완료 기준

개인 Google Drive, OneDrive Personal, SharePoint document library를
애플리케이션의 파일 저장소로 쓰는 Python 및 Node.js 라이브러리를 만든다.
애플리케이션은 같은 `FileStorage` 동작 규칙으로 파일을 다루며,
provider 선택과 OAuth 설정은 시작 시 한 번 명시한다. 각 서비스의
ID, 디렉터리, 휴지통, 동시 변경 특성을 없다고 가정하지 않는다.

v1.0.0은 세 provider에서 공통 파일 lifecycle을 **두 언어 모두** 실제
계정으로 검증하고, 설치·인증·오류·대용량 전송을 문서화했을 때만
배포한다. 이 문서의 확정은 설계의 확정이며 현재 구현이나 검증 완료를
뜻하지 않는다. 세부 동작은 [FileStorage 명세](../spec/storage-api.md)가
우선한다.

handoff에서 확정된 요구는 세 provider, 두 언어, provider와 분리된
`FileStorage`, 공통 conformance test, 장기적인 mount 지원이다.
아래의 v1 범위와 package 경계는 이번 review에서 내린 설계 결정이다.
실제 계정 credential, npm scope 게시 권한, provider별 조건부 쓰기
지원은 아직 확인되지 않은 배포 전제다.

## v1.0.0 범위

| 영역 | v1.0.0 결정 |
| --- | --- |
| 언어 | Python 3.12~3.14, Node.js 24 LTS |
| provider | Google My Drive의 지정 폴더, OneDrive Personal의 지정 root, SharePoint의 지정 document library |
| 파일 | 일반 바이너리 파일, 실제 디렉터리, ref 기반 식별 |
| 연산 | stat, exists, list, read, open_reader, read_range, write, mkdir, move, delete |
| 인증 | 사용자 delegated OAuth와 caller가 소유한 credential 저장 방식 |
| Python 통합 | 별도 배포물 `drivefs-fsspec`의 읽기 전용 파일 연산 |
| 검증 | 언어별 fake와 동일 conformance case, provider별 실제 계정 E2E |

Google Workspace 문서와 shortcut은 목록에 `kind=other`로 드러나지만
바이너리 콘텐츠처럼 읽거나 덮어쓰지 않는다. `appDataFolder`, Google
shared drive, OneDrive for Business, 일반 SharePoint list, 동기화,
S3 호환 API, object facade, CLI, mount는 v1.0.0 범위 밖이다.
저장소 전체 복사, 영구 삭제, 공유 링크와 permission API도 포함하지
않는다. 특히 mount는 cache·충돌·crash recovery의 별도 안정성 조건이
필요하므로 core의 1.0 배포와 분리한다. 후속 mount package는 같은
`FileStorage`를 사용하고 provider SDK에 직접 의존하지 않는다.

## 레이어와 의존 방향

```text
Application
   │  FileStorage API
   ▼
Python/Node provider plugin ─────→ 해당 OAuth·HTTP/API 의존성
   │
   └──────────────────────────────→ 각 언어의 core
                                      ▲
Python fsspec adapter ────────────────┘

spec/ + conformance/ ──→ 각 언어 구현의 검증 기준
```

이 그림의 화살표는 코드 의존 방향이다. application은 선택한 provider
class를 생성한 뒤 core의 `FileStorage` 인터페이스로 취급한다.
provider plugin은 인증, token refresh 연동, API 호출, 경로 탐색,
pagination, 전송, retry, 오류 변환을 소유한다. core는 자료형,
경로 규칙, 오류와 공개 인터페이스만 소유한다. core는 provider SDK,
HTTP client, OAuth library, fsspec, FUSE에 의존하지 않는다.
fsspec adapter는 core만 의존하며 provider를 import하지 않는다.

OneDrive와 SharePoint는 **서로 다른 공개 class**로 노출하되, Graph
transport의 공통 코드와 의존성이 실질적으로 같으므로 언어별로
`microsoft` 배포물 하나에 넣는다. 내부 모듈을 분리하고 각 class의
설정과 권한 가정을 분리한다. 별도 `graph-core` 공개 package와
상속 계층은 만들지 않는다. 중복 코드가 확인된 부분만 내부 공통
모듈로 추출한다.

```text
python/packages/core        → drivefs              (import drivefs)
python/packages/gdrive      → drivefs-gdrive       (import drivefs_gdrive)
python/packages/microsoft   → drivefs-microsoft    (import drivefs_microsoft)
python/packages/fsspec      → drivefs-fsspec       (import drivefs_fsspec)

node/packages/core          → @pydemia/drivefs
node/packages/gdrive        → @pydemia/drivefs-gdrive
node/packages/microsoft     → @pydemia/drivefs-microsoft
```

provider 배포물을 설치하면 해당 core도 설치된다. Python provider는
v1.0 출시 시 `drivefs>=1.0,<2`, Node provider는
`@pydemia/drivefs`의 호환되는 1.x에 의존한다. 새 core 기능을
사용하는 plugin release는 검증한 최소 core 버전을 올린다.
`drivefs-fsspec`은 `drivefs`와 `fsspec`에만 의존한다. 개발 환경은
각 언어의 lockfile로 재현하고, 배포물은
직접 의존성에 호환 범위를 기록한다. 인증 라이브러리와 HTTP client의
선택·버전은 provider 구현을 시작할 때 공식 지원 범위와 실제
전송 요구를 비교해 각 plugin 안에서 결정한다. 사용하지 않는
provider의 의존성은 설치되지 않아야 한다. PyPI 이름과 npm scope의
게시 권한은 첫 배포 전에 확인한다.

공통 동작 명세는 Markdown과 JSON case로 공유한다. Python과 TypeScript
사이에 runtime 코드를 공유하지 않는다. Python core는 동기식으로
`fsspec`과 일반 Python 코드에 맞추고, Node core는 비동기식으로
`Promise`와 `AsyncIterable`을 사용한다. API 이름과 오류 의미는
맞추되 언어별 코드 구조를 동일하게 강제하지 않는다.

## 사용자 사용 형태

```python
from drivefs_gdrive import GoogleDriveStorage

storage = GoogleDriveStorage(root_id="...", auth=credential_source)
storage.mkdir("/reports")
entry = storage.write("/reports/result.bin", b"data")
payload = storage.read(entry.ref)
```

```ts
import { GoogleDriveStorage } from "@pydemia/drivefs-gdrive";

const storage = new GoogleDriveStorage({
  rootId: "...",
  auth: credentialSource,
});
await storage.mkdir("/reports");
const entry = await storage.write("/reports/result.bin", bytes);
const payload = await storage.read(entry.ref);
```

위 코드는 목표 API 형태다. `auth`는 plugin이 정의하는 credential
source이며 core 형식이 아니다. caller가 credential 저장 위치와
지속성을 선택하고, plugin이 토큰 획득 및 갱신을 수행한다. 기본
생성자는 브라우저를 열거나 global 파일에 secret을 기록하지 않는다.
interactive OAuth를 돕는 예제는 provider package에 둔다.

## provider별 설정과 확인 사항

| plugin | 필요한 설정 | 구현 중 확인할 사항 |
| --- | --- | --- |
| Google | OAuth client, 지정 folder ID, credential source | `drive.file` 접근 범위, 중복 이름, resumable upload, native 문서 구분 |
| OneDrive | delegated OAuth, drive/root item 선택, credential source | personal account 동의, Graph paging, upload session과 버전 조건 |
| SharePoint | tenant/site와 document library 선택, credential source | library ID 확인, delegated 권한, Graph 응답 차이 |

Google은 기본적으로 앱이 접근 가능한 My Drive 폴더를 root로
지정한다. `drive.file`을 우선 검토하고, 기존 사용자 파일에 접근해야
한다면 필요한 scope와 동의·검증 조건을 별도로 명시한다. v1이
사용자의 My Drive 전체를 무조건 볼 수 있다고 홍보하지 않는다.
OneDrive Personal은 delegated `Files.ReadWrite`를 우선 검토한다.
SharePoint는 site와 library를 명시적으로 선택하고, 필요한
delegated permission을 실제 tenant에서 확인한다. app-only auth와
자동 site discovery는 v1의 필수 동작이 아니다.

세 plugin은 provider-native ID를 `ItemRef`에 보존한다. 항목의
경로는 매번 탐색하거나 유효성을 확인한다. 처음에는 지속 metadata
cache를 넣지 않는다. 경로 조회 비용이 실제 병목으로 확인되면
인스턴스 범위의 짧은 cache를 추가하고, write/move/delete 후 해당
경로를 무효화한다. 콘텐츠 cache는 core에 두지 않는다.

## fsspec adapter

`drivefs-fsspec`은 `FileStorage` 인스턴스를 받아 `ls`, `info`,
`exists`, `open(..., "rb")`을 연결한다. provider별 adapter를
만들지 않는다. `other` 항목은 목록에 그대로 표시하고 바이너리
읽기는 거부한다. 읽기 seek는 `read_range`로 처리하고, 서버가
범위 요청을 무시하면 무제한 전체 파일 다운로드로 대신하지 않는다.
텍스트 모드는 fsspec의 wrapper를 따른다. `wb`/`xb`, append,
`mkdir`, `rm`, `mv`는 adapter v1에서 지원하지 않는다. 쓰기는
`FileStorage.write`를 직접 사용한다. 데이터 프레임/Parquet 사용
사례는 실제 adapter 테스트로 확인한 것만 문서에 적는다.

## 인증, 실패, 보안

OAuth 토큰과 refresh token의 영속 저장은 caller가 결정한다.
plugin은 토큰 refresh를 연동하고 실패를 `AuthenticationError`로
바꾼다. 로그와 공통 예외에 access token, refresh token,
client secret, `Authorization` header, Graph의 서명된 임시
다운로드 URL을 넣지 않는다. HTTP timeout과 bounded retry를
provider별로 설정하고 `Retry-After`를 존중한다. 결과가 불확실한
변경 요청은 `IndeterminateOperationError`로 올린다.

`delete`는 휴지통 이동이다. Google My Drive와 Graph의 휴지통
동작을 사용한다. Google `appDataFolder`는 휴지통 이동을 지원하지
않으므로 v1에서 제외한다. Google native 문서는 별도 export 동작이
필요하므로 일반 파일 `read`에 암묵적으로 연결하지 않는다.
조건부 교체는 실제 API와 계정에서 검증한 plugin만 capability를
참으로 보고한다. 사용자가 명시적으로 요청한 무조건 교체는
동시 수정 내용을 덮을 수 있으므로 API 예제에는 버전 확인 방법도
함께 보여준다.

## 구현 단계와 통과 조건

| 단계 | 산출물 | 다음 단계로 가는 조건 |
| --- | --- | --- |
| A. 명세·core | 이 문서, API 명세, 양 언어 core, fake backend, 공통 JSON case | 동일 경로·오류·쓰기 규칙을 fake에서 통과 |
| B. Google | 양 언어 Google plugin과 OAuth 예제 | 실제 계정에서 lifecycle, 중복 이름, 대용량 전송 확인 |
| C. Microsoft | 양 언어 OneDrive·SharePoint class와 Graph 내부 모듈 | 두 종류 계정에서 같은 conformance와 권한·충돌 동작 확인 |
| D. fsspec·안정화 | Python adapter, API 문서, 설치 예제, release candidate | adapter 파일 작업, 배포물 설치, 전체 release gate 통과 |

단계 B와 C의 실제 계정 검증이 불가능하면 해당 provider를 지원
목록에 넣은 1.0을 배포하지 않는다. 확인되지 않은 capability를
참으로 표시하거나 integration test를 조용히 skip하지 않는다.

## v1.0.0 배포 기준

1. 두 언어의 fake backend가 같은 versioned JSON conformance case를
   통과한다. case에는 root/path, 중복 이름, pagination, 빈 파일,
   큰 파일, 범위 읽기, 생성/교체, 이동, 휴지통, 오류 변환을 포함한다.
2. Google, OneDrive Personal, SharePoint의 실제 계정에서 두 언어의
   `mkdir → write → stat → list → read → read_range → move → delete`
   흐름과 credential refresh를 각각 검증한다. test가 만든 항목의
   정리 실패도 결과로 보고한다.
3. HTTP fixture test가 401/403/404/409/412/429, 5xx, timeout,
   quota와 불확실한 업로드 완료 상태를 provider별로 검증한다.
   중복 이름과 native 문서 사례는 Google 실제 계정에서도 확인한다.
4. Python 3.12~3.14와 Node 24 LTS에서 formatter, lint, type check,
   unit/conformance test와 package build가 통과한다. 지원 OS의
   설치 smoke test는 core와 각 plugin을 분리해서 수행한다.
5. `drivefs-fsspec`의 목록, 읽기, 범위 seek, 쓰기 모드 거부를
   검증한다. provider 의존성을 설치하지 않은 core import도 확인한다.
6. 공개 API reference, OAuth 설정, scope, 대용량 파일 예제,
   안전한 overwrite 예제, provider 제한, 호환성 표와 release note를
   게시한다. LICENSE와 package metadata를 확정한다. secret이
   로그·test artifact·배포물에 없는지 확인한다.
7. rc에서 공개 API와 오류 이름을 고정하고, 이후 변경은 SemVer에
   따른다. 각 배포물의 1.0.0 버전·의존 범위를 함께 검증한다.

검증용 실제 계정과 게시 권한은 release 작업의 전제다. 이 기획은
그 자격 증명을 저장소에 넣거나 확보되었다고 가정하지 않는다.

## 공식 근거

- [Google Drive 파일·space·ID](https://developers.google.com/workspace/drive/api/guides/about-files)
- [Google appDataFolder의 제약](https://developers.google.com/workspace/drive/api/guides/appdata)
- [Google 업로드와 재개](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google 다운로드와 범위 읽기](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Google Drive OAuth scope 선택](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Microsoft Graph Drive/DriveItem](https://learn.microsoft.com/en-us/graph/api/resources/onedrive?view=graph-rest-1.0)
- [Graph upload session과 조건부 요청](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)
- [Graph 휴지통 삭제](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0)
- [Graph 권한 개요](https://learn.microsoft.com/en-us/graph/permissions-overview)
- [fsspec API](https://filesystem-spec.readthedocs.io/en/latest/api.html)
- [Python 지원 버전](https://devguide.python.org/versions/)
- [Node.js 지원 버전](https://nodejs.org/en/about/previous-releases)
