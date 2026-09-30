# 지속 실행 애플리케이션의 인증 설계

`docs/live-validation.md`의 토큰 JSON 주입은 실제 계정 검증 절차다. 앱의
운영 인증 방식으로 사용하지 않는다. 운영 앱은 사용자를 처음 연결할 때
OAuth 로그인과 동의를 받고, 이후에는 저장된 credential 또는 OAuth SDK의
token cache에서 유효한 access token을 조용히 가져온다. 토큰이 폐기되거나
재동의가 필요해지면 앱의 로그인 화면으로 돌아간다.

## 책임과 의존성

```text
애플리케이션 ──→ OAuth SDK / 로그인 UI / 계정별 보안 저장소
      │                         │
      └── token provider ──────┘
                │ access_token(force_refresh, failed_token)
                ▼
        drivefs provider (Google / Microsoft) ──→ drivefs core
```

앱은 사용자의 계정 선택, 최초 동의, cache 저장 및 복원, 갱신 실패 후
재인증을 담당한다. drivefs provider는 API 요청 때 `access_token`을
호출하고 401을 한 번 받으면 `force_refresh=True`(Node는 두 번째 인수
`true`)로 다시 호출한다. 세 번째 인수 `failed_token`은 실패한 토큰이다.
구현체는 다른 요청이 이미 갱신했다면 그 새 토큰을 돌려줄 수 있다.
갱신 후 일반 호출에서도 새 토큰을 돌려줘야 한다. core는 인증 및 OAuth
SDK에 의존하지 않는다. 각 provider package는 자체 HTTP 의존성만 가지며,
MSAL이나 Google OAuth SDK는 이를 선택한 **앱의** 의존성이다.
token provider는 토큰을 얻지 못하면 `drivefs`의 `AuthenticationError`를
발생시켜 앱이 재인증 흐름으로 연결할 수 있게 한다. 외부 SDK 오류
메시지에는 민감한 정보가 있을 수 있으므로 그대로 노출하지 않는다.

`GoogleAuth`와 `GraphAuth`는 기존의 token/refresh-token 저장 방식으로
계속 쓸 수 있다. 앱이 공식 OAuth SDK를 쓰는 경우에는 공개
`GoogleAccessTokenProvider` 또는 `GraphAccessTokenProvider` 인터페이스를
구현해 `auth`에 전달한다. Graph 구현체에는 `tenant_id`도 필요하다.
Microsoft의 MSAL은 refresh token을 앱에 노출하지 않으므로 MSAL 사용 시
`GraphToken`으로 옮기지 않고 이 인터페이스를 사용한다.

## 앱 형태에 따른 초기 연결과 저장소

| 앱 | 초기 연결 | 지속 저장 |
| --- | --- | --- |
| 서버 웹 앱/API | 사용자별 authorization code 로그인과 redirect | 계정별 암호화 DB 또는 분산 token cache. 서버 세션에 계정 식별자만 연결 |
| 데스크톱/CLI | 시스템 브라우저의 authorization code + PKCE 또는 지원되는 device flow | 사용자별 OS credential store 또는 OAuth SDK의 암호화 cache |

Google은 `offline` access를 요청해 받은 refresh token을 보관한다.
앱이 직접 저장소를 제공하면 `GoogleAuth(store=...)`가 만료 및 401 시
갱신한다. 계정별 store의 `load`/`save`는 프로세스가 재시작돼도
토큰을 복원해야 한다. 여러 서버나 프로세스가 같은 계정의 refresh token을
갱신한다면 저장소에서 잠금 또는 원자적 버전 갱신을 구현한다. 라이브러리의
인스턴스 내부 잠금만으로는 다른 프로세스와의 경쟁을 막지 못한다.

Microsoft는 MSAL의 계정별 영속 token cache와 `acquire_token_silent` /
`acquireTokenSilent`을 사용한다. 일반 요청은 cache를 사용하고,
drivefs가 401을 보고한 경우 `force_refresh` / `forceRefresh`를 넘긴다.
아래 코드는 **로그인과 cache 복원을 마친 앱**에서 `auth`를 연결하는 부분이다.
MSAL 앱 객체, 계정 및 cache는 앱이 관리한다.

```python
from drivefs import AuthenticationError
from drivefs_microsoft import OneDriveStorage

class MsalGraphAuth:
    tenant_id = "consumers"

    def __init__(self, msal_app, account):
        self.msal_app = msal_app
        self.account = account

    def access_token(self, client, *, force_refresh=False, failed_token=None):
        try:
            result = self.msal_app.acquire_token_silent(
                ["Files.ReadWrite"], account=self.account,
                force_refresh=force_refresh,
            )
        except Exception:
            raise AuthenticationError("Microsoft token acquisition failed") from None
        if not result or not result.get("access_token"):
            raise AuthenticationError("Microsoft sign-in is required")
        return result["access_token"]

storage = OneDriveStorage(
    drive_id=drive_id, root_id=root_id,
    auth=MsalGraphAuth(msal_app, selected_account),
)
```

```ts
import { AuthenticationError } from "@pydemia/drivefs";
import { OneDriveStorage } from "@pydemia/drivefs-microsoft";

const auth = {
  tenant_id: "consumers",
  async access_token(_fetcher: typeof fetch, forceRefresh = false) {
    let result;
    try {
      result = await msalApp.acquireTokenSilent({
        account: selectedAccount,
        scopes: ["Files.ReadWrite"],
        forceRefresh,
      });
    } catch {
      throw new AuthenticationError("Microsoft token acquisition failed");
    }
    if (!result?.accessToken) {
      throw new AuthenticationError("Microsoft sign-in is required");
    }
    return result.accessToken;
  },
};

const storage = new OneDriveStorage({ driveId, rootId, auth });
```

위 adapter는 MSAL의 재로그인 필요 오류를 `AuthenticationError`로
전달한다. 앱은 이 오류를 계정 재연결 화면으로 연결한다. 앱 사용자별로
선택한 계정, scope, OAuth client,
drive/root ID를 함께 관리해야 다른 사용자의 토큰으로 접근하지 않는다.

Google OAuth 동의 화면이 **External + Testing** 상태이고 Drive scope를
요청했다면 refresh token은 7일 후 만료된다. 이 상태는 장기 운영
검증에 적합하지 않다. 운영 전 앱 게시 상태와 필요한 scope의 검증 요건을
확인한다. 게시 후에도 사용자가 접근을 취소하거나 정책이 변경되면
재인증이 필요할 수 있다. 어떤 OAuth 방식도 무기한 무인 사용을
보장하지 않는다.

## 공식 참고 자료

- [Google 웹 서버 OAuth와 offline access](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google 설치형 앱 OAuth와 PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google refresh token 만료 조건](https://developers.google.com/identity/protocols/oauth2#expiration)
- [MSAL Node token cache](https://learn.microsoft.com/en-us/entra/msal/javascript/node/caching)
- [MSAL Node Extensions](https://learn.microsoft.com/en-us/entra/identity-platform/msal-node-extensions)
- [MSAL Python cache 직렬화](https://learn.microsoft.com/en-us/entra/msal/python/advanced/msal-python-token-cache-serialization)
