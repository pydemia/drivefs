# drivefs v1 구현계획

상태: 독립 review 반영 · 2026-09-30
기준: `main`의 `8974441` 및
[v1 기획서](v1-plan.md), [API 명세](../spec/storage-api.md)

## 목표와 현재 상태

이 계획은 Python과 Node.js에서 같은 `FileStorage` 동작을 제공하고,
Google Drive, OneDrive Personal, SharePoint document library를
선택적으로 설치할 수 있는 v1 구현을 목표로 한다. 마지막에는 빌드한
배포물을 새 컨테이너에 설치해 high-level 사용 예제를 실행한다.

계획 작성 시 저장소에는 설계 문서만 있고 구현, 패키지 설정,
테스트는 없었다. 로컬 shell에는 Node 24가 있지만 `npm`과 Python
실행기가 확인되지 않아, 빌드와 검증은 독립된 Python/Node
container에서 수행한다. 실제 provider credential은 저장소에
없으므로 네트워크 없는 fixture 검증과 실제 계정 integration
결과를 구분한다.

## 작업 브랜치와 커밋

`codex/implement-v1`은 `8974441`에서 분기한다. `.worknotes/`의
기존 handoff는 커밋하지 않는다. 각 커밋은 구현·테스트·문서가 함께
검토 가능한 한 가지 결과를 담는다. 순서는 의존 관계를 따른다.

| 단계 | 커밋 단위 | 완료 증거 |
| --- | --- | --- |
| A. 명세·core | `docs: plan v1 implementation` | 이 계획과 review 기록 |
| A. 명세·core | `feat(python): add storage core and fake` | Python path·error·fake conformance |
| A. 명세·core | `feat(node): add storage core and fake` | Node path·error·fake conformance |
| B. Google | `feat(python): add Google Drive backend` | fixture와 공통 conformance |
| B. Google | `feat(node): add Google Drive backend` | 같은 fixture와 conformance |
| C. Microsoft | `feat(python): add Graph drive backends` | OneDrive·SharePoint fixture |
| C. Microsoft | `feat(node): add Graph drive backends` | 같은 fixture와 conformance |
| D. fsspec·안정화 | `feat(python): add read-only fsspec adapter` | 목록·range seek·쓰기 거부 |
| D. fsspec·안정화 | `build: verify packages in containers` | wheel/npm tarball 신규 설치와 사용 예제 |
| D. fsspec·안정화 | `docs: record v1 support and release gates` | API·인증·제한·검증 결과 문서 |

실제 작업에서 독립적인 수정이 필요하면 같은 단계 안에서 더 작은
커밋으로 나눌 수 있다. 단계 이름과 완료 조건은 바꾸지 않는다.
각 단계의 fixture·conformance와 정적 검사를 통과한 커밋을 다음
단계의 기준으로 쓴다. 실제 계정 integration은 별도 누적
merge·release gate다. credential이 없어도 B/C fixture를 통과하면
다음 구현 단계로 진행할 수 있으나 실제 지원은 미검증으로 남는다.

## A. 명세·core

`conformance/cases/`에 언어 중립 JSON 입력·기대 결과를 둔다.
Python과 TypeScript는 같은 case ID를 실행한다. 각 언어의 core는
경로 규칙, `ItemRef`, `StorageEntry`, capability, 예외, 공개
`FileStorage` 타입만 갖는다. provider SDK, OAuth, HTTP client,
fsspec을 core dependency에 넣지 않는다. 언어별 in-memory fake는
test support에 두고 중복 이름과 pagination을 만들 수 있게 한다.

필수 case는 경로 정규화·거부, root 보호, 동일 이름 모호성,
ref 이동 후 조회와 외부 root 이탈, 파일 종류, 빈 파일, 범위 읽기,
크기가 필요한 streaming write, 생성/교체,
버전 충돌, 빈 디렉터리 삭제, 장애 시 `exists` 오류 전파다.
fake가 provider보다 강한 원자성을 가진다고 공통 보장으로
해석하지 않는다.

## B. Google Drive

Python `drivefs-gdrive`와 Node `@pydemia/drivefs-gdrive`가
core 인터페이스를 구현한다. plugin은 OAuth credential source,
Google REST 호출, parent ID 탐색, page token, upload session,
오류 변환을 소유한다. 사용자 지정 My Drive folder ID만 root로
받는다. 중복 이름은 모든 경로 단계에서 검사한다. Google native
문서와 shortcut은 `kind=other`다. `delete`는 휴지통 이동이다.

HTTP fixture에는 목록 페이지 누락·중복, 401/403/404/429/5xx,
업로드 완료 응답 소실, range 206/200, 크기 누락·불일치 stream,
fragment retry를 포함한다. 실제 계정에서는 OAuth refresh,
빈 파일과 대용량 파일, 중복 이름, 이동 후 ID, 휴지통을 확인한다.
조건부 교체는 실제 동작이 검증되기 전까지 capability=false다.

## C. Microsoft Graph

각 언어의 `microsoft` package 안에 `OneDriveStorage`와
`SharePointStorage`를 공개한다. Graph HTTP·pagination·upload
session과 오류 변환은 내부 코드로 공유하고 인증·root 선택은
class별로 둔다. OneDrive Personal은 delegated auth, SharePoint는
site와 document library ID를 명시한다. site discovery와 app-only
auth는 구현 범위에 넣지 않는다.

fixture에서 Graph의 `@odata.nextLink`, 302 임시 다운로드 URL,
범위 읽기, upload session의 `if-match`, 409/412/429 및 5xx를
재현한다. URL이나 토큰은 로그·예외에 남기지 않는다. 두 종류의
실제 계정에서 각각 lifecycle과 refresh를 실행한다.
각 plugin의 구현 전에 공개 `auth` 입력 형태, refresh 결과 저장,
저장 실패, 동시 refresh의 책임을 문서화한다. core는 credential
형식을 알지 않는다.

## D. fsspec·안정화

`drivefs-fsspec`은 core의 `FileStorage` 인스턴스를 받아 읽기 전용
`AbstractFileSystem`을 제공한다. `ls`, `info`, `exists`, `rb`
읽기와 range seek를 연결하고, `wb`/`xb`, append, mutation은
명시적으로 거부한다. provider plugin은 import하지 않는다.

Python wheel 네 개와 Node tarball 세 개를 각각 새 컨테이너 환경에
설치한다. source checkout이나 workspace link 없이 빌드 산출물만
사용한다. artifact hash, image digest, package dependency metadata와
공개 import 결과를 기록한다.
선택한 plugin 설치만으로 core가 들어오고, core 단독 설치에는
provider 의존성이 없는지 확인한다. README의 high-level 예제는
fake credential/HTTP fixture를 사용해 컨테이너에서 실행한다.
fixture는 외부 응답만 바꾸며 사용자 예제는 공개 package import와
constructor, `FileStorage` 메서드만 사용한다.
실제 계정용 예제는 credential을 환경 또는 호출자 주입으로 받아
별도로 실행하며, secret을 image나 artifact에 넣지 않는다.

## 테스트와 컨테이너 검증

| 시점 | 검증 | 실패 시 처리 |
| --- | --- | --- |
| 매 커밋 | 관련 언어 formatter·lint·type check·unit test | 해당 커밋 수정 후 재실행 |
| A 완료 | 양 언어가 같은 JSON case ID와 기대 오류를 통과 | 명세와 구현 차이를 먼저 판정 |
| B·C 구현 진행 | fake transport fixture와 공통 conformance | 실제 계정은 별도 merge·release gate로 누적 |
| D 완료 | Python 3.12~3.14, Node 24 image의 build·test·install smoke | 깨끗한 image에서 재현될 때까지 수정 |
| merge 전 | 전체 conformance, package import, secret scan, 문서 예제 | 증거가 없는 항목은 merge gate 미통과 |

테스트용 Dockerfile은 Python과 Node를 분리한다. 현재 작업의
컨테이너 검증 범위는 Linux x86_64다. v1.0.0 배포 목표 플랫폼은
Linux x86_64, Windows x86_64, macOS x86_64/arm64이며 각 플랫폼의
설치 smoke와 테스트 결과가 없으면 지원 완료로 표시하지 않는다.
Python image는
`python:3.12-slim`, `3.13-slim`, `3.14-slim`을 인자로 빌드하고,
Node image는 `node:24-bookworm-slim`을 사용한다. image tag는
CI에서 digest로 고정하고 갱신 시 결과를 다시 검증한다.
기본 container run에는 credential을 전달하지 않는다. 실제 계정
integration은 opt-in 환경에서만 실행한다. 실행한 명령과 exit code를
`docs/validation.md`에 commit, artifact hash, image digest,
실행 명령과 exit code를 기록한다.

## review와 merge

먼저 이 계획을 기준 문서와 함께 통합 개발자·검증 담당자 관점에서
독립적으로 검토한다. 지적은 설계 선결, 구현 검증, 선택 개선으로
나누고, 채택 여부와 수정 내용을 기록한다. 이 review가 끝난 뒤
구현 커밋을 시작한다. 구현 중 API 명세와 충돌하면 코드에 맞춰
조용히 바꾸지 않고 명세·호출자·테스트를 함께 review한다.

`codex/implement-v1`의 단계 커밋을 보존한다. `origin/main`이
바뀌면 최신 main 위로 rebase하고 전체 검증을 다시 실행한다.
모든 단계와 세 provider × 두 언어의 실제 계정 gate, 대상 OS matrix가
통과하면 PR에서 변경 범위,
커밋, container 결과, 미검증 사항을 review한다. 승인과 green
checks 뒤에 main으로 merge한다. 실제 계정 검증이 부족하면
구현 브랜치의 draft PR과 미완료 gate를 유지하고 v1.0.0 배포나
main merge를 완료로 표시하지 않는다. release tag와 registry
게시 작업은 merge 후 별도 gate다.

## 작업 설정 권장

이 표는 `software-engineering` 지침의 작업별 권장안이며 실제 적용
모델을 뜻하지 않는다.

| 단계 | 기획 | 설계 | 구현 | 검증 |
| --- | --- | --- | --- | --- |
| A. 명세·core | gpt-6-astra/high | gpt-6-astra/high | gpt-5.6-sol/medium | gpt-5.6-sol/high |
| B. Google | 해당 없음 | gpt-6-astra/high | gpt-5.6-sol/high | gpt-6-astra/high |
| C. Microsoft | 해당 없음 | gpt-6-astra/high | gpt-5.6-sol/high | gpt-6-astra/high |
| D. fsspec·안정화 | 해당 없음 | gpt-5.6-sol/medium | gpt-5.6-sol/medium | gpt-6-astra/high |
