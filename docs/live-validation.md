# 실제 계정 검증 실행

이 검증은 opt-in이다. Google Drive, OneDrive Personal, SharePoint의
**각 계정과 언어별로** 실행해 결과를 기록한다. 실행 전 테스트 전용 root
폴더를 하나 정하고, 해당 provider의 delegated OAuth access token과
refresh token을 발급한다. Google root는 앱이 접근 가능한 My Drive
폴더여야 한다. 필요한 동의 범위와 tenant 정책은
[사용 가이드](usage.md#인증과-root-선택)를 따른다.

## 개인 계정 준비 순서

1. 개인 Google Drive와 개인 OneDrive에 각각 **테스트 전용 폴더**를 만든다.
   검증기는 지정한 `root_id` 안에만 무작위 `drivefs-live-*` 폴더를 만들고
   지운다. 테스트 폴더에는 중요한 파일을 두지 않는다. Google에서
   `drive.file` scope를 쓰면 같은 OAuth 앱이 만든 폴더이거나 Google Picker로
   앱에 제공된 폴더여야 한다. Drive 웹 화면에서 만든 폴더 ID를 단순히
   복사하는 것만으로는 `drive.file` 접근이 보장되지 않는다.
2. [Google Cloud OAuth 데스크톱 앱 절차](https://developers.google.com/identity/protocols/oauth2/native-app)를
   따라 Drive API를 켜고, OAuth 동의 화면의 테스트 사용자에 본인 계정을
   추가한 뒤 Desktop client를 만든다. 우선
   `https://www.googleapis.com/auth/drive.file` scope를 사용한다.
   같은 앱의 authorization code + PKCE 흐름에서 offline access를 요청해
   access token과 refresh token을 얻는다. 선택한 root를 그 앱으로 만들거나
   Picker를 통해 제공한다. 범위를 넓혀야 한다면
   [Google scope 안내](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)의
   동의·검증 조건을 먼저 확인한다.
3. [Microsoft 앱 등록 절차](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)를
   따라 개인 계정을 허용하는 앱을 등록한다. OneDrive Personal 검증에는
   개인 계정 지원, delegated `Files.ReadWrite`, `offline_access`,
   authorization code + PKCE를 사용한다. `offline_access`를 요청해야
   refresh token을 받을 수 있다. 앱을 등록하는 Entra 환경과 파일을 가진
   개인 계정은 구별한다. 앱 등록 환경이 없다면 먼저 Microsoft의 등록
   전제 조건을 갖춰야 한다. 이 검증기의 `tenant_id`는 `consumers`다.
4. **각 OAuth 앱에서 발급한 토큰으로** ID를 확인한다. Google은 테스트 폴더의
   Drive file ID를 `root_id`로 쓴다. OneDrive는 Microsoft Graph의
   `GET /me/drive` 응답 `id`를 `drive_id`로, 테스트 폴더 DriveItem의 `id`를
   `root_id`로 쓴다. Graph Explorer 등 다른 앱의 토큰은 이 검증기의
   `client_id`와 refresh token을 대신하지 못한다.
5. SharePoint는 개인 Microsoft 계정의 OneDrive와 다른 서비스다.
   SharePoint 검증에는 접근 가능한 **회사·학교 tenant/site/document
   library**와 그 tenant용 delegated 토큰이 추가로 필요하다. 개인 계정만
   있다면 Google·OneDrive의 네 조합까지만 검증하고 SharePoint 두 조합은
   미검증으로 기록한다. 알려진 `site_id`에서
   [`/sites/{siteId}/drives`](https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0)로
   library `drive_id`를 확인하고, 그 안에 전용 `root_id`를 만든다. site ID를
   Graph로 **탐색**하려면 별도의 site 조회 권한과 tenant 동의가 필요할 수
   있다. 이 코드의 SharePoint 검증은 tenant·site·drive를 명시해 사용한다.

초기 OAuth 로그인·동의·토큰 발급은 이 저장소의 검증 스크립트가 수행하지
않는다. 발급 과정은 위 공식 안내를 따르고 토큰은 본인 기기에서만 다룬다.

## 비밀 설정 파일

설정 파일은 **저장소 밖**에 두고 본인만 읽을 수 있게 보호한다. 두
검증기는 같은 파일을 순서대로 읽고 refresh token이 회전할 때 파일에
즉시 저장한다. 동시에 실행하면 갱신 결과를 덮어쓸 수 있으므로 같은
파일에 대한 병렬 실행은 금지한다. 토큰·client secret을 명령 인자,
CI 로그, issue, PR에 넣지 않는다.

Google 예시의 값은 모두 자리표시자다.

```json
{
  "provider": "gdrive",
  "root_id": "selected-test-folder-id",
  "client_id": "oauth-client-id",
  "client_secret": "oauth-client-secret",
  "token": {
    "access_token": "issued-access-token",
    "refresh_token": "issued-refresh-token"
  }
}
```

OneDrive Personal은 `provider`를 `onedrive`로 하고 `drive_id`,
`root_id`, `client_id`, `tenant_id: "consumers"`, `token`을 넣는다.
SharePoint는 `provider: "sharepoint"`, 실제 tenant의 `tenant_id`,
`site_id`, document library의 `drive_id`, 그 안의 `root_id`,
`client_id`, `token`을 넣는다. Graph confidential client를 쓰면
`client_secret`을, refresh 요청에 scope가 필요하면 `scopes`를 추가한다.
Google의 `client_secret`은 Desktop client 설정의 값이 필요하다.
Microsoft public client 흐름에는 `client_secret`을 넣지 않는다.

POSIX에서는 `chmod 600 /outside/repo/live.json`으로 읽기 권한을
제한한다. Windows에서는 사용자 전용 위치와 ACL을 사용한다. 검증기는
저장소 내부 파일과 POSIX에서 다른 사용자도 읽을 수 있는 파일을
거부한다.

## 실행

각 언어의 패키지를 설치한 환경에서 실행한다. 아래 Python 명령의
`python`은 `drivefs-gdrive`와 `drivefs-microsoft`가 설치된
interpreter다. Node 명령은 `node/`에서 `npm ci && npm run build`
후 실행한다. 빌드 산출물 검증을 함께 하려면 새 환경에 wheel/tarball을
설치하고 동일 스크립트를 실행한 결과를 별도로 기록한다.

```powershell
$env:DRIVEFS_LIVE_CONFIG = 'C:\private\drivefs-google.json'
python validation/live_python.py
node node/tests/live-integration.mjs
```

provider를 바꿀 때 설정 파일 경로도 해당 계정의 파일로 바꾼다.
두 스크립트는 root를 조회하며 refresh를 강제한 후, 무작위 이름의
`drivefs-live-*` 하위 폴더에서 생성, 읽기, 범위 읽기, 목록, 덮어쓰기,
이동, 대용량 스트림 업로드와 다운로드, 삭제를 검사한다. 대용량 파일은
4 MiB + 17 bytes다. 변경은 생성한 폴더 안에서만 하고 종료 시 그
폴더의 항목을 삭제한다. 실패 후 정리가 끝나지 않으면 출력된
`SCRATCH` 경로를 계정에서 확인한다. 삭제는 provider 휴지통 이동이다.

성공 출력의 `PASS`는 그 계정·언어 조합에만 적용한다. 실행 명령,
exit code, 날짜, commit, wheel/tarball hash와 테스트 계정 종류를
[검증 기록](validation.md)에 추가하되 자격 증명과 사용자 파일 ID는
기록하지 않는다. Google 중복 이름·native 문서, provider별 권한과
휴지통의 실제 동작은 별도 수동 시나리오로 검사해야 한다. 여섯 조합
및 해당 추가 시나리오가 모두 확인되기 전에는 release gate가 미통과다.
토큰·client secret이나 원본 config 파일은 검증 결과로 보내지 않는다.
공유할 결과는 provider, 언어, `PASS`/`FAIL`, exit code, 날짜, commit,
실패 시 **비밀 값을 제거한** 오류 유형과 단계면 충분하다.
