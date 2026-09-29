# FileStorage v1 API 명세

상태: v1.0.0 설계 확정 · 2026-09-30

이 문서는 Python과 Node.js 구현이 함께 지켜야 하는 동작 규칙이다.
언어별 메서드 표기와 비동기 방식은 달라도 결과와 오류의 의미는 같다.
v1의 대상은 일반 바이너리 파일과 실제 디렉터리다.

## 저장소와 경로

`FileStorage` 인스턴스는 설정 시 선택한 **한 개의 root**만 노출한다.
Google Drive는 My Drive의 특정 folder ID, OneDrive Personal은 선택한
drive의 root item ID, SharePoint는 선택한 document library의 root item
ID를 사용한다. 경로 `/`는 그 root를 뜻하며, root 밖 이동은 지원하지
않는다. 서로 다른 storage 인스턴스 사이의 이동도 지원하지 않는다.
ref 기반 연산도 항목의 현재 parent를 확인한다. root 밖으로 이동한
항목임을 확인하면 `NotFoundError`를 낸다. 권한이나 네트워크 오류로
현재 위치를 확인할 수 없으면 그 오류를 전파한다. 위치 확인과 변경
요청 사이의 외부 이동까지 원자적으로 막는다고 보장하지 않는다.

공개 경로는 `/`로 구분하는 root 상대 경로다. `a/b`, `/a/b`,
`/a//./b/`는 모두 `/a/b`가 된다. 빈 문자열, `..`, 역슬래시,
NUL은 거부한다. root 이외의 끝 `/`는 제거한다. 이름의 대소문자와
Unicode 정규화는 변경하지 않는다. URL 디코딩, OS 경로 해석,
provider가 허용하지 않는 문자 치환도 하지 않는다. 잘못된 이름은
`InvalidPathError`로 처리한다.

경로는 탐색 수단이다. `StorageEntry.ref`는 같은 storage 인스턴스 안에서
항목을 다시 지정하는 불투명한 `ItemRef`다. `ItemRef`는 provider ID와
필요한 container 정보를 보존하며, 다른 인스턴스나 설정에 이식할 수
없다. rename이나 move 뒤에는 이전 경로가 바뀌지만 같은 root 안에서
해당 항목의 ref는 계속 사용할 수 있어야 한다. `StorageEntry.path`는
조회 시점의 경로이며 최신 경로를 보장하는 캐시가 아니다.

동일한 parent 아래 같은 이름의 항목이 여럿 있으면, 해당 경로를
해석하는 연산은 `AmbiguousPathError`를 낸다. `list`는 그 항목들을
각각 반환하고 호출자는 각 항목의 `ref`로 구별할 수 있다. 임의의
첫 번째 항목을 선택하지 않는다.

## 공개 자료형

| 자료형 | 필드와 의미 |
| --- | --- |
| `ItemRef` | storage 인스턴스에 한정된 불투명한 항목 식별자 |
| `StorageEntry` | `ref`, `id`, `path`, `name`, `kind`, `size`, `modified_at`, `mime_type`, `version` |
| `StorageCapabilities` | v1에서는 `conditional_replace`만 공개 |

`kind`는 `file`, `directory`, `other`다. `other`에는 Google Workspace
문서와 shortcut처럼 일반 바이너리 파일로 읽을 수 없는 항목이 들어간다.
이 항목도 목록에서 누락하지 않으며, 지원하지 않는 콘텐츠 연산은
`UnsupportedOperationError`를 낸다. v1에서 `other`는 `stat`/`list`로만
조회할 수 있다. `id`는 provider-native ID이며 해당 drive 또는
space 안에서만 의미가 있다. `size`, `modified_at`, `mime_type`,
`version`은 provider가 실제 값을 제공하지 않으면 `null`/`None`이다.
`size`는 알 수 있을 때 바이트 수, `modified_at`은 UTC 시각이다.
`version`은 provider에서 받은 비교용 불투명 문자열이며 S3 ETag나
해시라는 뜻이 아니다. provider 응답 전체를 공통 metadata로 노출하지
않는다.

`conditional_replace=true`는 `expected_version`을 사용한 교체를
provider의 조건부 요청으로 시행하고, 버전 불일치를 `ConflictError`로
반환하는 동작을 실제로 검증했다는 뜻이다. 검증 전에는 `false`다.
이 경우 교체 가능한 일반 파일의 `version`은 제공되어야 한다.
기능의 지원 여부와 권한 부족은 별개다.

## 연산

| 연산 | v1 동작 |
| --- | --- |
| `stat(path_or_ref)` | 현재 항목 metadata 반환. 없으면 `NotFoundError` |
| `exists(path)` | 없는 경로에서만 `false`; 다른 오류는 전파 |
| `list(path_or_ref)` | 직계 자식 전체를 페이지 단위로 순회 |
| `read(path_or_ref)` | 전체 바이너리 내용을 메모리에 반환 |
| `open_reader(path_or_ref)` | 순차 읽기 스트림 반환 |
| `read_range(path_or_ref, offset, length)` | 지정 범위의 바이트 반환 |
| `write(path, data, overwrite=false, expected_version=null, size=null)` | 파일 생성 또는 명시적 교체 후 `StorageEntry` 반환 |
| `mkdir(path)` | parent가 있는 새 디렉터리 생성 후 `StorageEntry` 반환 |
| `move(path_or_ref, destination)` | 같은 root 안에서 이름/parent 변경 후 `StorageEntry` 반환 |
| `delete(path_or_ref)` | 파일 또는 빈 디렉터리를 휴지통으로 이동 |

`list`는 순서를 보장하지 않는다. Python에서는 iterator, Node에서는
`AsyncIterable`로 제공하여 provider pagination을 숨기되 목록 전체를
메모리에 강제로 적재하지 않는다. 순회 중 발생한 인증·네트워크 오류도
반복 시점에 전파한다.

`read`는 편의 API이므로 전체 파일 크기만큼 메모리를 쓸 수 있다.
큰 파일은 `open_reader`나 `read_range`를 사용한다.
`read_range`의 `offset`과 `length`는 0 이상의 정수다. `length=0`은
빈 바이트를 반환하고 EOF를 넘는 범위는 가능한 바이트만 반환한다.
provider가 전체 응답을 보낸 경우 구현은 범위 응답을 검증하고,
의도치 않은 전체 파일 적재 없이 처리하거나 오류를 낸다.
별도 범위 요청들 사이에 remote 파일이 바뀌지 않는 snapshot 보장은
없다. 연속 범위 읽기를 조합하는 adapter는 가능한 버전 변화를 확인하고
감지한 변경을 `ConflictError`로 알린다.

`write`의 parent는 이미 존재해야 한다. `overwrite=false`가 기본이며
기존 이름이 있으면 `AlreadyExistsError`다. `overwrite=true`는 기존
바이너리 파일 하나를 명시적으로 교체한다. 이때
`expected_version`을 주지 않으면 호출자가 최신 변경을 덮을 수 있다.
`expected_version`을 주면 `overwrite=true`여야 하고, capability가
거짓이면 `UnsupportedOperationError`다. 조건이 맞지 않으면
`ConflictError`다. provider의 원자적인 이름 생성 보장이 없으면
`overwrite=false`의 경쟁 상태까지 원자적으로 막는다고 약속하지
않는다. 생성 후 중복을 발견하면 `ConflictError`로 알리고 조정에
필요한 ID를 오류 정보에 담는다.

`write`는 bytes와 스트리밍 source를 받을 수 있다. bytes/`Uint8Array`는
길이를 자동으로 얻는다. Python binary reader와 Node `AsyncIterable`에는
전체 바이트 길이 `size`를 반드시 전달한다. 길이 미상 source는 원격
요청 전에 `InvalidUploadSourceError`로 거부한다. 전송한 길이가
`size`와 다르면 session을 가능한 한 취소하고 같은 오류를 낸다.
plugin은 재시도할 fragment만 제한된 크기로 보관하며 stream 전체를
메모리에 적재하지 않는다. 실패 후 성공 여부를 확인할 수 없고 안전한
재시도 방법도 없으면 `IndeterminateOperationError`를 낸다.
성공을 가정하거나 동일 이름으로 무조건 다시 생성하지 않는다.

`mkdir`는 중간 디렉터리를 만들지 않는다. 대상이 이미 있으면
종류와 관계없이 `AlreadyExistsError`다. `move`의 destination parent도
존재해야 하며 대상 이름이 있으면 `AlreadyExistsError`다. 단일 항목을
이동하며, 디렉터리의 하위 경로도 따라 바뀐다. 이 동작의 원자성은
보장하지 않는다. 이동 결과가 불확실한 네트워크 실패는
`IndeterminateOperationError`로 처리한다.

`delete`는 root에 사용할 수 없다. 비어 있지 않은 디렉터리는
`DirectoryNotEmptyError`다. 삭제 후 일반 `stat`/`list`에서는 보이지
않아야 한다. v1은 영구 삭제와 복구 API를 제공하지 않는다. provider
계정의 휴지통 정책에 따른 복구 가능 기간은 공통 API가 보장하지 않는다.
`other` 종류에 대한 `move`와 `delete`는 v1에서 지원하지 않는다.

## 언어별 형태

Python 공개 API는 동기식이다. `read`는 `bytes`, `open_reader`는
context manager로 닫을 수 있는 binary reader를 반환한다. `write`는
`bytes` 또는 binary reader를 받는다. 미소비 reader도 context 종료 시
HTTP 응답을 닫는다. Node 공개 API는 비동기식이다.
`read`는 `Promise<Uint8Array>`, `open_reader`는
`AsyncIterable<Uint8Array>`, `write`는 `Uint8Array` 또는
`AsyncIterable<Uint8Array>`를 받는다. Node stream 변환은 Node core의
얇은 편의 함수로 둘 수 있으나 저장소 의미는 바꾸지 않는다.
Node reader는 순회가 끝나거나 `return()`으로 조기 종료되면 HTTP
응답을 닫는다. `open_reader`는 선택적 `AbortSignal`을 받아 명시적
취소도 지원한다.

두 언어는 같은 메서드 이름, 기본값, 오류 의미를 유지한다.
Python의 동기 호출을 mount의 비동기 이벤트 루프에서 직접 실행하지
않는다. mount 구현 시 작업 스레드로 분리한다.

## 오류와 재시도

공통 오류는 `StorageError`를 기반으로 한다.

| 오류 | 의미 |
| --- | --- |
| `NotFoundError` | 항목 또는 parent가 없음 |
| `AlreadyExistsError` | 생성/이동 대상 이름이 이미 있음 |
| `AmbiguousPathError` | 한 경로에 여러 항목이 대응됨 |
| `InvalidPathError` | 공통 또는 provider 이름 규칙 위반 |
| `InvalidUploadSourceError` | 크기 누락·불일치 등 업로드 입력 오류 |
| `NotDirectoryError`, `IsDirectoryError` | 기대한 항목 종류가 다름 |
| `DirectoryNotEmptyError` | 비어 있지 않은 디렉터리 삭제 시도 |
| `AuthenticationError` | 토큰 부재·만료·갱신 실패 |
| `PermissionDeniedError` | 인증은 됐으나 권한 부족 |
| `RateLimitError`, `QuotaExceededError` | 호출 제한과 저장 용량 부족 |
| `ConflictError` | 버전 불일치 또는 동시 변경 충돌 |
| `IndeterminateOperationError` | 변경 연산의 완료 여부를 확인할 수 없음 |
| `UnsupportedOperationError` | 명시적으로 지원하지 않는 기능 |
| `ProviderUnavailableError`, `ProviderError` | 일시 장애와 기타 provider 오류 |

오류에는 연산, 경로 또는 ref, provider 식별자, 안전한 원인 정보와
가능한 경우 `retry_after`를 담는다. 토큰, 다운로드 URL, 요청 인증
header는 담지 않는다. `exists`는 `NotFoundError`만 `false`로
바꾼다. 읽기 요청과 안전성이 증명된 업로드 단계만 제한 횟수로
재시도한다. `Retry-After`를 존중하고, 결과가 불확실한 변경 요청을
맹목적으로 반복하지 않는다.

## 범위 밖의 의미

v1은 S3 API, POSIX 원자성, cross-provider copy/move, 파일 공유,
검색, 버전 이력, Google Workspace 문서 export, shortcut 추적,
영구 삭제, 동기화, offline write, mount를 보장하지 않는다. 이 항목은
`FileStorage`의 필수 메서드로 예약하지 않는다.
