# 패키지 주도 OAuth 연결 설계

상태: v1.0.0 설계 보완 · 2026-10-20. 아래의 로그인 API는 **목표 API**이며
현재 배포물에는 아직 구현되지 않았다. 현재 구현 범위는
[앱 인증 가이드](app-auth.md)에 적었다.

## 목표와 경계

앱 사용자가 실행할 때마다 access token을 발급받아 수동 주입하지 않도록
한다. 패키지가 최초 연결, 영속 cache 복원, 만료 전 갱신, 401 후 강제
갱신을 한 흐름으로 묶는다. 사용자가 동의를 취소하거나 refresh token이
만료된 경우에는 OAuth 서버가 사용자 참여를 요구한다. 이때 패키지는
로그인 절차를 제공하지만 사용자의 동의를 대신 생성하지 않는다.

```text
Application ──→ Google / Microsoft provider ──→ drivefs core
      │                    ▲
      └──→ 선택한 OAuth 연결 모듈 ┘  AccessTokenProvider
                     │
                     └──→ OAuth SDK / 계정별 영속 cache
```

기존 `GoogleAccessTokenProvider`/`GraphAccessTokenProvider`를 연결점으로
유지한다. core는 OAuth SDK를 import하지 않는다. 선택한 인증 모듈만
OAuth SDK에 의존하며, provider의 HTTP/API 코드가 인증 모듈에 역으로
의존하지 않는다. Google과 Microsoft 인증 모듈은 별도 선택 설치물로
구성해 사용하지 않는 서비스의 SDK를 설치하지 않는다. Python/Node의
정확한 배포물 이름과 SDK 라이선스는 게시 전에 검증한다.

## 최초 설정과 첫 로그인

최초 설정은 **앱 개발자의 OAuth client 등록**과 **사용자의 계정 연결**로
나뉜다. 사용자의 비밀번호나 미리 발급한 access token을 앱 설정에
입력받지 않는다.

| 대상 | 앱 개발자가 한 번 설정하는 값 | 첫 사용자 연결 |
| --- | --- | --- |
| Google Drive | Drive API 활성화, OAuth 동의 화면, Desktop 또는 Web OAuth client ID, 필요한 Drive scope. Web은 redirect URI도 등록 | 사용자가 Google 계정을 선택하고 동의. `offline` access로 갱신 가능한 credential을 받음 |
| OneDrive Personal | 개인 계정을 허용하는 Entra 앱 등록, client ID, 플랫폼별 redirect URI, delegated `Files.ReadWrite`와 `offline_access` | 사용자가 개인 Microsoft 계정으로 로그인·동의. MSAL이 계정과 token cache를 보관 |
| SharePoint | 접근 가능한 회사·학교 tenant의 앱 등록, redirect URI, 해당 site/library에 필요한 delegated 권한 | 조직 계정의 사용자 또는 관리자 동의. tenant·site·drive ID를 연결 |

데스크톱 client는 public client다. 시스템 브라우저와 loopback callback,
PKCE를 사용하고 client secret의 기밀성에 의존하지 않는다.
서버 웹 앱은 등록된 HTTPS callback으로 code를 받고 confidential client
credential은 서버에만 보관한다. Google의 `drive.file` scope는 앱이 만든
파일 또는 사용자가 Picker 등으로 앱에 제공한 파일에 접근한다. 기존
임의 폴더 ID만 저장해서는 접근 권한이 생기지 않는다.
OneDrive Personal의 authority는 `consumers`이고 SharePoint는 해당
회사·학교 tenant를 사용한다.

첫 연결의 패키지 흐름은 다음과 같다.

1. 인증 모듈이 선택 계정의 cache를 찾는다. 없으면 무작위 `state`와
   PKCE verifier를 만들고 authorization URL을 생성한다.
2. 데스크톱은 시스템 브라우저를 열고 임시 loopback 서버로 callback을
   받는다. 웹은 앱이 사용자를 로그인 URL로 redirect하고 등록된 callback
   route에서 응답을 전달한다.
3. 인증 모듈이 `state`와 callback을 검증하고 code를 교환한다. Google은
   access/refresh token을 보안 저장소에 기록한다. Microsoft는 MSAL의
   계정별 cache를 영속화한다. 코드와 token을 로그에 남기지 않는다.
4. 연결된 사용자에게 사용할 root를 선택하게 한다. Google은 앱이 전용
   폴더를 만들거나 Picker로 제공된 폴더를 사용한다. OneDrive는
   `GET /me/drive`의 drive ID와 선택한 folder ID를 저장한다.
   SharePoint는 별도 조직 tenant/site/document library의 ID가 필요하다.
5. 선택한 `root_id`와 인증 session으로 storage를 생성한다. 다음 실행부터
   cache 복원과 silent refresh를 먼저 시도한다.

Google OAuth 동의 화면이 External + Testing이고 Drive scope를 요청하면
테스트 사용자의 refresh token은 7일 후 만료될 수 있다. 이는 첫 연결
검증에는 사용할 수 있지만 장기 운영을 검증하는 설정은 아니다.

## 사용 흐름

### 데스크톱·대화형 CLI

```python
# 목표 API 예시: 아직 구현되지 않음
auth = GoogleOAuthSession.desktop(
    client_id=client_id,
    scopes=["https://www.googleapis.com/auth/drive.file"],
    cache=UserCredentialStore(account_key),
)
auth.connect()  # cache 우선, 필요한 경우 시스템 브라우저에서 동의
storage = GoogleDriveStorage(root_id=root_id, auth=auth)
```

`connect()`는 명시적으로 호출한다. 생성자나 백그라운드 파일 연산이
예고 없이 브라우저를 열지 않는다. cache가 유효하면 브라우저 없이
돌아오고, 갱신도 불가능하면 authorization code + PKCE 흐름을 시작한다.
Microsoft는 MSAL의 대화형 인증과 silent acquisition을 사용한다.
브라우저를 열 수 없는 Microsoft CLI에는 device code 흐름을 별도
옵션으로 제공할 수 있다.

### 서버 웹 앱/API

서버는 요청 중 브라우저를 직접 열 수 없다. 인증 모듈이
`begin_authorization(user_key, redirect_uri)`로 URL, state, PKCE 정보를
만들고, 앱이 사용자를 해당 URL로 redirect한다. callback에서는 앱이
받은 `state`와 `code`를 `complete_authorization(...)`에 전달한다.
인증 모듈이 code 교환과 계정별 cache 저장을 수행한다. 이후 파일 API는
같은 사용자 계정의 session을 주입해 호출한다. 앱은 HTTP route, 사용자
세션, 계정 선택 및 보안 저장소의 배치를 담당한다.

## 파일 작업 중의 상태 전이

1. 요청 전에 선택 계정의 cache를 읽는다. 유효한 token은 그대로 쓰고,
   만료가 가까우면 SDK로 갱신한 뒤 저장한다.
2. provider API가 401을 반환하면 해당 token을 무효화하고 강제 갱신한
   뒤 **한 번만** 재시도한다. 한 프로세스의 동시 요청은 같은 계정의
   갱신을 합치고, 다중 프로세스는 저장소의 잠금 또는 버전 비교로 조정한다.
3. cache 부재·refresh 실패·추가 동의 요구가 발생하면 인증 모듈의
   `InteractionRequiredError`(`AuthenticationError`의 하위 유형)를
   올린다. 앱은 사용자 동작 시 `connect()` 또는 웹 redirect를 실행한다.
   인증이 끝난 뒤 앱이 파일 작업을 다시 시작한다. 완료 여부가 불명확한
   변경 요청을 인증 모듈이 임의로 재실행하지 않는다.
4. 네트워크 장애, 권한 부족, 사용자 재동의 요구는 별도 오류로 분류한다.
   같은 실패에 대한 무한 갱신·로그인 반복은 금지한다. token, code,
   verifier, 서명 URL은 오류와 로그에 남기지 않는다.

MSAL은 refresh token을 응용 코드에 노출하지 않으므로 MSAL cache 자체를
보존한다. Google은 offline access로 얻은 refresh token과 갱신 결과를
보존한다. 단일 사용자 데스크톱에서는 OS 보호 저장소를 사용할 수 있고,
서버에서는 사용자별 암호화 cache와 원자적 저장·갱신을 주입받는다.
임의의 전역 평문 파일을 기본 저장소로 만들지 않는다. OAuth client 설정,
사용자 식별자, scope, root ID는 앱이 제공한다.

## v1.0.0 수용 조건

- 두 언어에서 Google 및 Microsoft의 최초 연결, 프로세스 재시작 후
  cache 복원, 만료 갱신, 401 강제 갱신을 검증한다.
- cache 부재, refresh token 만료·철회, 추가 동의 요구에서 명확히
  사용자 연결 단계로 돌아간다. 읽기·쓰기 중 재시도 횟수는 제한한다.
- 계정 간 cache 격리와 동시에 발생한 refresh의 저장 경쟁을 검증한다.
- 데스크톱과 웹 흐름을 문서화하고, auth 모듈만 설치한 격리 환경에서
  선택하지 않은 provider SDK가 설치되지 않음을 확인한다.
- 추가 SDK·cache 의존성의 라이선스를 다시 검토하고 실제 계정으로
  각 흐름을 검증한 뒤 1.0.0을 배포한다.

## 공식 근거

- [Google 설치형 앱의 PKCE와 refresh](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google 웹 서버의 offline access](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Drive `drive.file` scope](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google token 만료·철회 대비](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)
- [Microsoft 앱 등록과 계정 유형](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
- [Microsoft desktop 앱 redirect 설정](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration)
- [MSAL Python의 silent·interactive 흐름](https://learn.microsoft.com/en-us/entra/msal/python/getting-started/acquiring-tokens)
- [MSAL Node token acquisition](https://learn.microsoft.com/en-us/entra/msal/javascript/node/acquire-token-requests)
- [MSAL Node cache 지속성](https://learn.microsoft.com/en-us/entra/msal/javascript/node/caching)
