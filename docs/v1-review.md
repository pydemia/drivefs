# v1.0.0 기획 검토 기록

검토일: 2026-09-30
결론: [개발 기획서](v1-plan.md)와
[FileStorage API 명세](../spec/storage-api.md)의 **설계 확정**.
provider 구현과 실제 계정 검증은 아직 시작하지 않았으므로 배포 승인은
별도의 release gate를 통과한 뒤에 한다.

## 검토 기준

handoff의 목적을 기준으로 다음을 확인했다.

- 애플리케이션이 provider별 API를 직접 다루지 않고 파일 lifecycle을
  호출할 수 있는가.
- 경로·ID·중복 이름·디렉터리·휴지통·native 문서의 차이를 정확히
  드러내는가.
- core만 쓰는 프로젝트에 Google/Microsoft/fsspec/FUSE 의존성이
  들어오지 않는가.
- Python과 Node가 같은 동작을 검증할 수 있는가.
- 실제 인증과 네트워크 실패가 성공·미존재로 바뀌지 않는가.
- 검증하지 않은 기능을 v1.0.0의 지원 범위로 표시하지 않는가.

## 발견 사항과 반영 결정

| 발견 사항 | v1.0.0 결정 | 근거 |
| --- | --- | --- |
| Google `appDataFolder`는 trash를 지원하지 않음 | 공통 `delete=trash`를 유지하고 appDataFolder 제외 | [Google appDataFolder](https://developers.google.com/workspace/drive/api/guides/appdata), [Graph delete](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0) |
| Google Workspace 문서는 일반 blob과 다운로드 방식이 다름 | 목록에는 `other`로 표시하고 binary read/export 자동 변환 제외 | [Google 다운로드](https://developers.google.com/workspace/drive/api/guides/manage-downloads) |
| Google의 이름 검색은 path를 안정 ID로 만들지 못함 | `ItemRef`를 공개하고 중복 경로에 `AmbiguousPathError` | [Google 파일 ID와 검색](https://developers.google.com/workspace/drive/api/guides/about-files) |
| Graph의 OneDrive·SharePoint가 `DriveItem`을 공유함 | 공개 class는 분리, 내부 Graph 모듈과 배포물은 공유 | [Graph 파일 모델](https://learn.microsoft.com/en-us/graph/api/resources/onedrive?view=graph-rest-1.0) |
| Python fsspec은 동기 파일 API가 자연스러움 | Python core 동기, Node core 비동기; 동작 case만 공유 | [fsspec API](https://filesystem-spec.readthedocs.io/en/latest/api.html) |
| fsspec 쓰기 close 실패 시 staging 파일 복구 정책이 필요함 | adapter 1.0은 읽기 전용; 쓰기는 직접 `FileStorage.write` 사용 | handoff의 write cache·실패 상태 분석 |
| POSIX mount의 write/seek/cache는 별도 실패 모델이 필요함 | mount는 core 1.0의 공개 보장에서 제외 | handoff의 mount·write cache 위험 분석 |
| object facade와 directory copy는 최소 lifecycle에 불필요함 | v1 공개 surface에서 제외 | handoff의 작은 API 원칙 및 [Google folder copy 제한](https://developers.google.com/workspace/drive/api/guides/create-file) |
| 조건부 교체의 provider별 실제 지원 정도가 다를 수 있음 | 검증한 경우만 capability=true; 미지원 시 명시적 오류 | [Graph upload precondition](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0) |

provider API의 문서상 가능 여부만으로 지원을 확정하지 않았다.
특히 Google 조건부 교체, `drive.file`로 접근 가능한 기존 폴더의
범위, OneDrive Personal과 SharePoint의 OAuth 권한, Graph의 범위
응답, 각 provider의 이동 후 ID 유지 여부는 구현 단계에서 실제
계정으로 확인해야 한다. 결과가 다르면 임의로 공통 보장을 늘리지
말고 conformance case와 지원 표를 먼저 수정한다.

## 의존성 검토

`core ← provider`와 `core ← fsspec adapter`만 허용한다.
application의 `FileStorage` 타입 import는 core에서 가능하고,
선택한 provider 생성 시에만 그 plugin을 import한다. Microsoft의
두 class는 동일 Graph 의존성을 사용하므로 하나의 배포물로 묶어
패키지 간 내부 버전 결합을 없앤다. provider를 모두 설치해야 하는
상위 meta package나 자동 registry는 만들지 않는다. 첫 구현 PR부터
package manifest와 import graph를 검사하여 역방향 의존을 막는다.

계획한 Python 배포물 네 개와 npm 배포물 세 개는 2026-09-30
registry 조회에서 모두 404였다. 이것은 게시 권한이나 향후 점유를
보장하지 않는다. 첫 배포 전 maintainer 계정으로 이름과 scope
권한을 다시 확인한다.

## 공개 동작 검토

| 검토 대상 | 결론 |
| --- | --- |
| `exists` | 미존재만 `false`; 인증·네트워크 장애를 숨기지 않음 |
| `list` | pagination을 순회로 숨기고 같은 이름의 항목은 각각 반환 |
| `read` | 작은 파일용 편의 API; 대용량은 stream/range 사용 |
| `write` | 기본은 새 파일 생성; 기존 파일 교체는 명시적으로 요청 |
| 동시 변경 | 검증된 조건부 교체만 강한 보장; 미지원은 capability에 반영 |
| `move` | 같은 root에서만 허용; 공통 원자성 보장은 없음 |
| `delete` | 파일 또는 빈 디렉터리의 휴지통 이동; 영구 삭제 없음 |
| 실패 결과 | 완료 여부가 불명확한 변경은 별도 오류로 전파 |

이 규칙을 먼저 고정하면 provider 구현이 편의상 `404`와 `403`을
섞거나, Graph의 이름 충돌을 Google의 중복 이름 허용과 동일하게
해석하는 문제를 막을 수 있다. fsspec adapter도 같은 규칙에만
의존한다.

## 배포 전 남아 있는 검증

| 위험 | 통과 조건 |
| --- | --- |
| Python/Node 간 의미 차이 | 동일 version의 JSON conformance case를 양쪽 fake와 실제 provider가 통과 |
| 잘못된 OAuth scope 또는 갱신 | 세 provider 유형에서 권한·refresh·재인증 실패를 실험 |
| 대용량 업로드 중단 | 재개 가능한 세션과 불확실한 완료 상태를 fixture 및 실제 파일로 확인 |
| 중복 이름과 path cache 오염 | Google 계정에 중복 항목을 만들고 path 오류 및 ref 접근 확인 |
| 데이터 손실성 교체 | 조건부 교체 가능 여부를 provider별로 측정하고 충돌을 재현 |
| fsspec의 숨은 전체 다운로드 | 범위 seek와 서버의 범위 무시 응답을 실제로 확인 |
| 패키지 간 결합 | 각 plugin만 새 환경에 설치하고 core 단독 import 확인 |
| secret 유출 | 로그, 예외, test artifact, wheel/tarball에 token·임시 URL이 없는지 검사 |

이 표는 설계상 미해결 결정 목록이 아니라 구현 검증 목록이다.
검증 결과가 v1 API 보장과 충돌하면 release candidate 전에 명세를
수정하고 다시 review한다. 모든 gate가 통과하기 전에는 v1.0.0을
배포하지 않는다.

## 단계별 작업 설정 권장

아래는 handoff가 지정한 software-engineering 지침의 작업 설정
권장안이다. 모델 성능 보장이나 실제 적용 상태를 뜻하지 않는다.

| 단계 | 기획 | 설계 | 구현 | 검증 |
| --- | --- | --- | --- | --- |
| A. 명세·core | gpt-6-astra/high | gpt-6-astra/high | gpt-5.6-sol/medium | gpt-5.6-sol/high |
| B. Google | 해당 없음 | gpt-6-astra/high | gpt-5.6-sol/high | gpt-5.6-sol/high |
| C. Microsoft | 해당 없음 | gpt-6-astra/high | gpt-5.6-sol/high | gpt-6-astra/high |
| D. fsspec·안정화 | 해당 없음 | gpt-5.6-sol/medium | gpt-5.6-sol/medium | gpt-6-astra/high |

단계 B·C에서 업로드 결과의 불확실성이나 동시성 처리처럼 의미가
아직 정해지지 않은 작업은 gpt-6-astra/high로 별도 검토한다.
