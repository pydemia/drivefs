# 실제 계정 검증 실행

이 검증은 opt-in이다. Google Drive, OneDrive Personal, SharePoint의
**각 계정과 언어별로** 실행해 결과를 기록한다. 실행 전 테스트 전용 root
폴더를 하나 정하고, 해당 provider의 delegated OAuth access token과
refresh token을 발급한다. Google root는 앱이 접근 가능한 My Drive
폴더여야 한다. 필요한 동의 범위와 tenant 정책은
[사용 가이드](usage.md#인증과-root-선택)를 따른다.

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
