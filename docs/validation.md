# 0.1.0 구현 후보 검증 기록

검증일: 2026-09-30 · 코드 기준: `d3e5a3a` (`codex/implement-v1`).
Microsoft의 빈 파일 경로 수정 `4ddfd09`와 Python fsspec 변경
`413e9db`까지 포함한다.
검증 환경은 Docker Desktop의 Linux `amd64`와 로컬 Windows `x86_64`다.
`.artifacts/`는 Git에서 제외하고, 아래 hash는 해당 실행에서 생성된
파일의 SHA-256이다.

## 이미지

| 이미지 | RepoDigest | 아키텍처 |
| --- | --- | --- |
| `python:3.12-slim` | `python@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f` | amd64 |
| `python:3.13-slim` | `python@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b` | amd64 |
| `python:3.14-slim` | `python@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d` | amd64 |
| `node:24-bookworm-slim` | `node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` | amd64 |

## 실행 결과

| 실행 | 결과 |
| --- | --- |
| Python 3.12, 3.13, 3.14: Ruff E/F/I/B/UP, Ruff format, mypy strict (네 package source), unittest | 버전별 exit 0; 각 20개 unittest 통과 |
| Node 24: `npm ci`, ESLint, Prettier, TypeScript typecheck, build, Node test | exit 0; 33개 test 통과 |
| Python 3.12, 3.13, 3.14: 네 wheel 빌드 | 버전별 exit 0; 각 4개 `py3-none-any` wheel |
| Python 3.12: core 단독 새 컨테이너 설치 | exit 0; core runtime dependency 없음 |
| Python 3.12: gdrive, microsoft, fsspec 각각 별도 새 컨테이너 설치 | 각각 exit 0; 선택하지 않은 plugin import 없음 |
| Python 3.12, 3.13, 3.14: 각 버전 wheel을 새 컨테이너에 설치 후 공개 API fixture smoke | 버전별 exit 0; 세 provider stat/range와 fsspec seek |
| Node 24: core 단독·gdrive·microsoft 개별 오프라인 tarball 설치 | 각각 exit 0; 선택하지 않은 plugin 없음 |
| Node 24: 세 tarball을 새 컨테이너에 오프라인 설치 후 공개 API fixture smoke | exit 0; 세 provider stat/range |
| Windows x86_64, Python 3.12.14: 새 venv에 네 wheel 설치 후 공개 API fixture smoke와 unittest | exit 0; 20개 unittest 통과 |
| Windows x86_64, Python 3.12.14: core와 각 plugin을 별도 venv에 설치 | 네 환경 각각 exit 0; 선택하지 않은 plugin 없음 |
| Windows x86_64, Node 24.21.0: 새 디렉터리에 세 tarball을 오프라인 설치 후 공개 API fixture smoke | exit 0; 세 provider stat/range |
| Windows x86_64, Node 24.21.0: core와 두 plugin을 별도 디렉터리에 설치 | 세 환경 각각 exit 0; 선택하지 않은 plugin 없음 |
| Windows x86_64, Node 24.21.0: `npm ci`, ESLint, Prettier, TypeScript, build, test | exit 0; 33개 test 통과 |
| Gitleaks: Git 이력 및 `validation/` directory | 각 exit 0; 탐지 결과 없음 |

소스 검사에 사용한 컨테이너 내부 명령은 다음과 같다. Python에서는
`PYTHON_IMAGE`를 위의 세 이미지로 바꿔 각자 실행했다.

```powershell
docker run --rm -v "${PWD}:/workspace" -w /workspace $PYTHON_IMAGE sh -lc "python -m pip install -q -e python/packages/core -e python/packages/gdrive -e python/packages/microsoft -e python/packages/fsspec ruff mypy && ruff check --no-cache --select E,F,I,B,UP python/packages python/tests && ruff format --check python/packages python/tests && mypy --strict --cache-dir=/tmp/mypy python/packages/core/src python/packages/gdrive/src python/packages/microsoft/src python/packages/fsspec/src && python -m unittest discover -s python/tests -q"
docker run --rm -v "${PWD}:/workspace" -w /workspace/node node:24-bookworm-slim sh -lc "npm ci --no-audit --no-fund && npm run lint && npm run format:check && npm run typecheck && npm test"
```

Python wheel은 `python -m pip wheel --no-deps --wheel-dir
/workspace/.artifacts/<version> python/packages/core python/packages/gdrive
python/packages/microsoft python/packages/fsspec`으로 만들었다. 서로 다른
Python 버전의 wheel 빌드를 동일 소스 checkout에서 동시에 실행했을 때
공유 `build/` 디렉터리 충돌로 한 번 실패했다. 세 버전을 **순차 재실행**해
모두 통과했다. CI에서는 버전별 독립 checkout/build 디렉터리를 사용해야
한다.

Node tarball은 `npm ci && npm run build && npm pack --workspaces
--pack-destination /workspace/.artifacts/node`로 만들었다. 새 컨테이너의
`/tmp`에는 `.artifacts/`와 `validation/`만 read-only로 마운트했다.
Python은 외부 `httpx`·`fsspec` 설치 후 `--no-index --find-links=/artifacts`
로 로컬 wheel을 설치했고, Node는 로컬 tarball 세 개를 `npm install
--offline`으로 설치했다. Windows도 별도 venv와 빈 npm 프로젝트에서
동일한 산출물을 설치했다. 따라서 artifact smoke에서 workspace link와
소스 checkout을 사용하지 않았다. 스크립트는
[`python_package_smoke.py`](../validation/python_package_smoke.py)와
[`node_package_smoke.mjs`](../validation/node_package_smoke.mjs)이다.

빌드 산출물의 dependency metadata를 설치 환경에서 확인했다. Python
`drivefs`는 runtime dependency가 없고, `drivefs-gdrive`와
`drivefs-microsoft`는 `drivefs`·`httpx`, `drivefs-fsspec`은
`drivefs`·`fsspec`만 요구한다. Node core는 dependency가 없고 두
plugin은 `@pydemia/drivefs`만 요구한다.

## 산출물 SHA-256

| 환경 | 파일 | SHA-256 |
| --- | --- | --- |
| Python 3.12 | `drivefs-0.1.0-py3-none-any.whl` | `18ff35906a413d48d25a13c77b3dd755cb482bed01ac087905c4278581432e9c` |
| Python 3.12 | `drivefs_gdrive-0.1.0-py3-none-any.whl` | `9dfe6de4490df82dd25e31170846fa7941c2973aace9a4aec593f1247a228d62` |
| Python 3.12 | `drivefs_microsoft-0.1.0-py3-none-any.whl` | `e0a3eca71156f116d0242c7efa0fd0c4e0674a02508627846730f98814c6b4b1` |
| Python 3.12 | `drivefs_fsspec-0.1.0-py3-none-any.whl` | `adabc700919d5586f1665d65b8741fb18c338626b9fe24d2dd61bf4f19437de3` |
| Python 3.13 | `drivefs-0.1.0-py3-none-any.whl` | `a901090044c22a9f5bfc69d9e64dadcee3023f67c59756211d42f63d69b9df14` |
| Python 3.13 | `drivefs_gdrive-0.1.0-py3-none-any.whl` | `840fd760fea24de470e28c45f175b4acdac7cda3d70910737d48f2a2e166d93d` |
| Python 3.13 | `drivefs_microsoft-0.1.0-py3-none-any.whl` | `47546d12ecf7d254cfbf216284fdf742ddbbee4e5723fd76c386a118270e2f68` |
| Python 3.13 | `drivefs_fsspec-0.1.0-py3-none-any.whl` | `7613367e8955f3095618659c767862e01d3a824c3acd4df77851e58c27c1e7bc` |
| Python 3.14 | `drivefs-0.1.0-py3-none-any.whl` | `464a012a37fb7d9da2e089587746bffd0f7c8ae4b4845df7f309bba43d43caa2` |
| Python 3.14 | `drivefs_gdrive-0.1.0-py3-none-any.whl` | `a426815f5dc63eec618d90ea283b8795fffe864d72ab8b9855a1032678e9f302` |
| Python 3.14 | `drivefs_microsoft-0.1.0-py3-none-any.whl` | `d5f02701ec98b53793ec41d9fcc517f90feea5f821bdd0adb73f14d42554782a` |
| Python 3.14 | `drivefs_fsspec-0.1.0-py3-none-any.whl` | `8599ad3e76f71b95f2ace1390ef234d0829061a228bef87a24af273c6657f780` |
| Node 24 | `pydemia-drivefs-0.1.0.tgz` | `731c4060810b3406458b6fef8d0c68de809578239ceb4723a60ff1269ec1206c` |
| Node 24 | `pydemia-drivefs-gdrive-0.1.0.tgz` | `62d5bfa46e899bfd1e14942c49aaebb32f8705ec4b8d4ec2dd3897a8fae935dc` |
| Node 24 | `pydemia-drivefs-microsoft-0.1.0.tgz` | `5d0df8d6b2aca15ba33c87d63c4cf3cb4dcfbafe29015aff68c4b6f75bd76c70` |

wheel hash는 각각의 빌드 실행 결과이며, wheel zip metadata 때문에
다른 빌드에서 byte-for-byte 동일함을 주장하지 않는다.

## 자동 OS 행렬

[`verify.yml`](../.github/workflows/verify.yml)은 Python 3.12·3.13·3.14와
Node 24를 Linux x86_64, Windows x86_64, macOS x86_64/arm64에서 각각
검사한다. 소스 검사와 fixture test 후 wheel·tarball을 만들고, core만
설치한 환경, plugin별 환경, 전체 설치 환경에서 공개 API smoke를 실행한다.
외부 의존성을 먼저 설치한 뒤 drivefs 배포물은 로컬 산출물에서 설치하며,
provider credential이나 게시 권한은 workflow에 제공하지 않는다.

검증 스크립트는 Windows Python 3.12·Node 24와 Linux 컨테이너 Python
3.12~3.14·Node 24에서 **새로 빌드한** 배포물로 각각 exit 0을 확인했다.
`actionlint`로 workflow 구문 검사도 통과했다. 이후
[GitHub Actions 실행 36627177438](https://github.com/pydemia/drivefs/actions/runs/36627177438)에서
`f73f0d8`의 Python 3.12·3.13·3.14 × Linux·Windows·macOS Intel·
macOS arm64 12개 job이 모두 통과했다. Node 4개 job은 실패했다.
Linux·macOS는 core를 빌드하기 전에 type check가 실행되어
`@pydemia/drivefs` 선언을 찾지 못한 것이 check annotation으로 확인됐다.
Windows는 lint 단계 실패이며 상세 로그에 대한 접근은 확인되지 않았다.
후속 변경에서 Node type check 전에 빌드하도록 하고, checkout의
줄바꿈 차이를 막도록 `.gitattributes`를 추가했다.

[GitHub Actions 실행 36628748926](https://github.com/pydemia/drivefs/actions/runs/36628748926)은
`3ccbde6`에서 **16개 job 모두 success**로 완료됐다. Python 3.12·
3.13·3.14와 Node 24의 Linux x86_64, Windows x86_64, macOS
x86_64/arm64 조합마다 wheel 또는 tarball을 새 환경에 설치하는 마지막
artifact smoke 단계도 모두 success였다. 이 결과로 목표 OS의
fixture·배포물 설치 gate를 통과했다. 실제 계정 검증은 별개다.

## 후속 Node HTTP deadline 검증

Node provider의 모든 HTTP 호출에 기본 5분 deadline을 적용했다. 본문
읽기 실패가 조회 중 발생하면 일시 장애로, 변경 응답 중 발생하면
완료 여부 불명으로 분류하는 fixture를 추가했다. 이 후속 변경의
Linux Node 24 컨테이너와 Windows Node 24에서 ESLint·Prettier·
TypeScript 및 37개 test가 각각 exit 0이었다. 새 tarball을 각 환경에서
다시 만들고 core·plugin별·전체 설치 smoke도 exit 0이었다. 두 환경의
산출물 SHA-256은 다음과 같다. 앞 표의 Node hash는 이전 코드 기준의
이력으로 남겨 둔다.

| 환경 | 파일 | SHA-256 |
| --- | --- | --- |
| Linux Node 24 | `pydemia-drivefs-0.1.0.tgz` | `8fde025674b4a69ead9bf11c58e6a1e9f8f5b1f679a5edc659f5bd7561d925d3` |
| Linux Node 24 | `pydemia-drivefs-gdrive-0.1.0.tgz` | `633c076022e8055bd4f52ab8f13ce4cb83b30a0a86e8d25f8b4e43c02f646409` |
| Linux Node 24 | `pydemia-drivefs-microsoft-0.1.0.tgz` | `b50f302170b236cf4331cf3131220b485594d2acbe28d41931b568bdf7aabf08` |
| Windows Node 24 | `pydemia-drivefs-0.1.0.tgz` | `fd54bb991177c41155ee1272c4359be5556ad0b8a9c14a7c95e0185655850117` |
| Windows Node 24 | `pydemia-drivefs-gdrive-0.1.0.tgz` | `dcd12839e0a9e6b3597587e3bed59162c13e14709f6ce952cf87c3ce0e6d63a1` |
| Windows Node 24 | `pydemia-drivefs-microsoft-0.1.0.tgz` | `7dbe5f99483e7e3b98f4999f362f2c9e7c13af2fda4bdf1505c01077d6c42469` |

## 후속 Python 동시 refresh 검증

두 Python provider에서 여러 401 응답이 같은 실패 토큰에 대해 도착하면
이미 저장된 새 access token을 재사용하도록 수정했다. Linux 컨테이너
Python 3.12·3.13·3.14와 Windows Python 3.12에서 Ruff·mypy strict 및
22개 test가 각각 exit 0이었다. 각 환경에서 wheel 네 개를 다시 빌드해
core·plugin별·전체 설치 smoke도 exit 0을 확인했다. 후속 산출물의
SHA-256은 다음과 같다.

| 환경 | 파일 | SHA-256 |
| --- | --- | --- |
| Linux Python 3.12 | `drivefs-0.1.0-py3-none-any.whl` | `5ad73b9621b4319e046189081362e7dfcfcab3effdffb9cd52544c904e9536c0` |
| Linux Python 3.12 | `drivefs_gdrive-0.1.0-py3-none-any.whl` | `b129636ccff86cafac12160ac4c604259f157060543080764f84fb38e6fe76f2` |
| Linux Python 3.12 | `drivefs_microsoft-0.1.0-py3-none-any.whl` | `dc816cad8e2d9e258578a9186bdc32902a8a5bebae079c46a0494053e3b91d66` |
| Linux Python 3.12 | `drivefs_fsspec-0.1.0-py3-none-any.whl` | `9e2f36d5631730f96eee86c454fee9f6e8d74535f9439917ca707ea4bad22e6c` |
| Linux Python 3.13 | `drivefs-0.1.0-py3-none-any.whl` | `8d5ced364abe5d1e671a27151100bde4ebaa90bd55853a3606c2e69bc76af6b7` |
| Linux Python 3.13 | `drivefs_gdrive-0.1.0-py3-none-any.whl` | `1e8b0a49f42d09db3bd48dd19801778f80bbac1aed34c966aedae55265e7fcf1` |
| Linux Python 3.13 | `drivefs_microsoft-0.1.0-py3-none-any.whl` | `ff25f286b70ee0e10f63c29346674dba705599b8546b3eb9184949ae363bc361` |
| Linux Python 3.13 | `drivefs_fsspec-0.1.0-py3-none-any.whl` | `49b08abcd74350cb554a908efbaa29666f29963b8f4e61be6ce34c9003e81904` |
| Linux Python 3.14 | `drivefs-0.1.0-py3-none-any.whl` | `e12077b58beee371b56d37f9312da36742833b8acef5be4bddad97c36e4ce50a` |
| Linux Python 3.14 | `drivefs_gdrive-0.1.0-py3-none-any.whl` | `20b8a618ef2e8db26e48f773fc125d36bddece8546df963fe651f102f9111492` |
| Linux Python 3.14 | `drivefs_microsoft-0.1.0-py3-none-any.whl` | `5acf2537bc712b66be99722bc689f9a482b399ecd408780802856e24d9557ad9` |
| Linux Python 3.14 | `drivefs_fsspec-0.1.0-py3-none-any.whl` | `9e76990fd262e8de95ab5f102cbe4ed92b7e3b402bab6f63a9de27934b83224b` |
| Windows Python 3.12 | `drivefs-0.1.0-py3-none-any.whl` | `a8d93528e41d54b89ff8485f19031790742c38a6412dc7cdaeb0cf25cbbf7c77` |
| Windows Python 3.12 | `drivefs_gdrive-0.1.0-py3-none-any.whl` | `b1c22973e18b96a1a13e6bba39531e4ebbf0732e6e6a5ad87db5895642ff1705` |
| Windows Python 3.12 | `drivefs_microsoft-0.1.0-py3-none-any.whl` | `f945bbb8a708321bdec8e856cc5b3fbae5f0f174893ca7813254bf07c9fc08a2` |
| Windows Python 3.12 | `drivefs_fsspec-0.1.0-py3-none-any.whl` | `6997e67c0c475da747abee98f45ccf9f4556f7347ba534c8179f487df29b7e61` |

## 후속 변경 응답 검증 (`275e18e`)

성공 상태의 변경 응답 본문이 깨졌거나 필수 metadata가 빠졌다면
완료 여부를 알 수 없으므로 두 언어의 Google·Graph plugin이
`IndeterminateOperationError`를 낸다. 조회 응답의 형식 오류는
`ProviderError`로 남는다. Python은 24개, Node는 37개 fixture test가
Windows와 Linux 컨테이너에서 통과했다. Linux amd64 컨테이너의
Python 3.12·3.13·3.14는 각 이미지에서 Ruff·mypy strict, 테스트,
wheel 네 개의 새 환경 격리 설치가 모두 exit 0이었다. Node 24는
ESLint·Prettier·TypeScript, 테스트, tarball 세 개의 새 환경 격리
설치가 exit 0이었다. 사용한 이미지 digest는 위 [이미지](#이미지)
표와 같다. 재현 명령은 위의 소스 검사 명령과
`python validation/verify_python_artifacts.py --build .artifacts/mutation-py3XX`,
`npm pack --workspaces --pack-destination /out`,
`node validation/verify_node_artifacts.mjs <tarball-directory>`다.

| 환경 | 산출물 | SHA-256 |
| --- | --- | --- |
| Python 3.12 | `drivefs-0.1.0-py3-none-any.whl` | `b632dbd8ed17364d1487815c3fa5718c47d6f4afe590f33a87ec3c7c9e7a88f6` |
| Python 3.12 | `drivefs_gdrive-0.1.0-py3-none-any.whl` | `4281836e8cc0426d15fc756a386a3d2b05e67129d1d99974d4fe320e4e8b1268` |
| Python 3.12 | `drivefs_microsoft-0.1.0-py3-none-any.whl` | `11249d2be6af0d5a1030ca67a497adf29232fe27f00097cf3b26cc1234d6b17f` |
| Python 3.12 | `drivefs_fsspec-0.1.0-py3-none-any.whl` | `068aa3d0585ccc26ed74a43c5b7948382736befce81c9820b17b479fff10088b` |
| Python 3.13 | `drivefs-0.1.0-py3-none-any.whl` | `2022381276fe05071ccdd651734039f21ceb08b8186a63f7d91b448a0d3c30cf` |
| Python 3.13 | `drivefs_gdrive-0.1.0-py3-none-any.whl` | `0daae9f0e9c969c15a660271fe4cd7df172dcd5c5808038def576510ddeda153` |
| Python 3.13 | `drivefs_microsoft-0.1.0-py3-none-any.whl` | `5f121fc0c955d1f216f53624bdd07f5ce9102d1c0252404131813f5da930fdc9` |
| Python 3.13 | `drivefs_fsspec-0.1.0-py3-none-any.whl` | `127ebd8fc751ff6f1199dd4498a75de83a7431b6368464caaf352d573a38119b` |
| Python 3.14 | `drivefs-0.1.0-py3-none-any.whl` | `424b589667c6f486353e6ca02637b011c9eebb437a51d93780de7371e0e92434` |
| Python 3.14 | `drivefs_gdrive-0.1.0-py3-none-any.whl` | `10b9d014d066f830e37b050a85a1ec863238ebc07105b2eb062b82baa462e100` |
| Python 3.14 | `drivefs_microsoft-0.1.0-py3-none-any.whl` | `023725d49acd947d17a94b38bd6b813e3a913ae9f82216cc76a2b06dc084a04f` |
| Python 3.14 | `drivefs_fsspec-0.1.0-py3-none-any.whl` | `855d1a3ea500b13b843c8ac19bbb36adc1d64c4dcdc853546fff15b4ec41d737` |
| Node 24 | `pydemia-drivefs-0.1.0.tgz` | `731c4060810b3406458b6fef8d0c68de809578239ceb4723a60ff1269ec1206c` |
| Node 24 | `pydemia-drivefs-gdrive-0.1.0.tgz` | `57bd77932a968a366c833fab84de9f305888e04923f6f4aa58ddd7668e8127f7` |
| Node 24 | `pydemia-drivefs-microsoft-0.1.0.tgz` | `d9e91b6fb6e36da72cdb8228cca831f46299e714bc813dc9c61ecd02b0b0d263` |

## 후속 Node Graph byte range 검증 (`99cb291`)

`offset + length - 1`이 JavaScript 안전 정수 범위를 넘는 요청은
`InvalidArgumentError`로 원격 호출 전에 거부한다. Windows Node 24와
Linux amd64 `node:24-bookworm-slim`에서 ESLint·Prettier·TypeScript,
38개 테스트가 exit 0이었다. Linux 컨테이너에서 새 tarball을 만든 후
`node validation/verify_node_artifacts.mjs <tarball-directory>`로 core,
plugin별, 전체 설치 smoke가 exit 0이었다.

| 산출물 | Linux Node 24 SHA-256 |
| --- | --- |
| `pydemia-drivefs-0.1.0.tgz` | `731c4060810b3406458b6fef8d0c68de809578239ceb4723a60ff1269ec1206c` |
| `pydemia-drivefs-gdrive-0.1.0.tgz` | `57bd77932a968a366c833fab84de9f305888e04923f6f4aa58ddd7668e8127f7` |
| `pydemia-drivefs-microsoft-0.1.0.tgz` | `cf694b47e0473d5e4bd1ba37409b72d2e7e12c6dfbbb900ae3194cb56d798f06` |

## 후속 Node Google reader 정리 검증 (`6755e63`)

Google 다운로드 reader를 조기 중단하거나 범위 읽기를 마칠 때
`cancel()`이 실패해도 읽기 결과를 덮어쓰지 않는다. 실패하는 취소를
재현한 회귀 테스트를 포함해 Windows Node 24에서 `npm test` 39개,
`npm run lint`, `npm run format:check`, `npm run typecheck`가 모두
exit 0이었다. Linux amd64 `node:24-bookworm-slim`
(`node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`)
컨테이너에서 깨끗한 소스 복사본에 `npm ci` 후 같은 검사와 39개 테스트를
실행했고 모두 exit 0이었다. 이어 `npm pack --workspaces`로 세 tarball을
빌드하고 `node validation/verify_node_artifacts.mjs /out`으로 격리 설치,
공개 API 및 dependency layer smoke를 실행해 exit 0을 확인했다.

| 산출물 | Linux Node 24 SHA-256 |
| --- | --- |
| `pydemia-drivefs-0.1.0.tgz` | `731c4060810b3406458b6fef8d0c68de809578239ceb4723a60ff1269ec1206c` |
| `pydemia-drivefs-gdrive-0.1.0.tgz` | `9592aece6403494ae2d85699dd178e04ee0af5a9da754e0cce4bb30b00b1c1c9` |
| `pydemia-drivefs-microsoft-0.1.0.tgz` | `cf694b47e0473d5e4bd1ba37409b72d2e7e12c6dfbbb900ae3194cb56d798f06` |

## 공통 대용량 conformance 검증 (`7ab3bbb`)

`conformance/cases/v1.json`에 `large-stream-and-range`를 추가했다.
4 MiB + 17 bytes를 두 언어의 fake storage에 스트림으로 쓰고,
전체 reader 길이, EOF 부근 범위 읽기, 삭제 후 조회를 같은 case에서
검사한다. Node 테스트 입력은 64 KiB 조각으로 전달한다.
Windows에서 Python 3.12의 24개 unittest와 Node 24의 40개 테스트,
Ruff·mypy strict·ESLint·Prettier·TypeScript 검사가 exit 0이었다.
Linux amd64 컨테이너에서 위 [이미지](#이미지)의 Python 3.12·3.13·3.14는
각각 `pip install -e` 후 같은 Python 정적 검사와 24개 테스트가
exit 0이었다. Node 24는 `npm ci` 후 같은 Node 검사와 40개 테스트가
exit 0이었다. 이번 변경은 conformance 입력과 테스트 실행기에만
한정되며 배포 package source는 변경하지 않았다.

## Registry 이름 조회

2026-09-30에 공식 [PyPI JSON API](https://pypi.org/pypi/drivefs/json)의
`drivefs`, `drivefs-gdrive`, `drivefs-microsoft`, `drivefs-fsspec`와
[npm registry](https://registry.npmjs.org/@pydemia%2fdrivefs)의
`@pydemia/drivefs`, `@pydemia/drivefs-gdrive`,
`@pydemia/drivefs-microsoft` 공개 metadata endpoint를 `curl.exe`로
조회했다. 일곱 요청 모두 HTTP 404였고, 각 registry의 대표 응답
본문은 `Not Found`였다.
이는 공개 package metadata가 현재 없다는 증거일 뿐, 이름 예약
가능성이나 해당 계정의 게시 권한을 증명하지 않는다.

## Apache-2.0 배포 패키지 검증 (2026-09-30)

[의존성 라이선스 검토](license-review.md)를 마친 뒤 Windows Python 3.12에서
네 wheel을 다시 빌드했다. 각각 `License-Expression: Apache-2.0` 메타데이터와
`dist-info/licenses/LICENSE`를 포함했다. 네 개를 선택 provider별 격리
환경 및 전체 환경에 설치해 `pip check`와 API smoke가 exit 0이었다.
Node 24에서는 세 workspace tarball을 다시 빌드해 각각 `LICENSE`가
포함됨을 확인했고, 선택 provider별 격리 설치 및 전체 설치 smoke가
exit 0이었다. Python unittest 24개, Node 테스트 40개와 Node lint,
format, typecheck가 통과했다. 실제 계정 검증은 아직 실행하지 않았다.

## v1.0.0 미통과 gate

실제 계정용 opt-in 실행 절차는 [live-validation.md](live-validation.md)에
있다. Windows에서 Python 3.12·Node 24 검증기를 각각 언어별 fake
storage에 연결해 lifecycle·대용량 경로·정리 절차를 실행했고, 임시
설정 파일에 갱신 token을 저장하는 경로도 확인했다. 실제 계정
credential 없이 실행하면 쓰기 전에 종료된다. 아직 어떤 실제 계정
결과도 얻지 못했다.

| gate | 현재 증거 |
| --- | --- |
| Google·OneDrive Personal·SharePoint 실제 계정 × Python·Node lifecycle 및 refresh | 계정·credential이 없어 실행하지 못함. fixture 통과는 대체 증거가 아님 |
| Google 실제 계정 중복 이름·native 문서, provider별 권한·휴지통·대용량 응답 | 실행하지 못함 |
| registry 이름·npm scope 게시 권한, 최종 1.0 metadata | 위 공개 metadata 조회는 404. Apache-2.0 LICENSE 및 package metadata는 확인했으나, 게시 권한·이름 예약 가능성·1.0 metadata는 미확정 |
| 원자적 조건부 교체 | 모든 provider가 capability=false; 1.0 필수 기능은 아니나 지원 주장 불가 |

따라서 이 기록은 구현 후보의 컨테이너 검증 증거이며 v1.0.0 배포
승인이나 main merge 승인으로 해석하지 않는다.

## 앱 소유 token provider 검증 (2026-09-30)

Python 3.13에서 Ruff check/format, mypy strict 및 unittest 26개가
통과했다. Node 24에서 ESLint, Prettier, TypeScript typecheck 및 테스트
42개가 통과했다. Google과 Graph 양쪽의 새 fixture는 구체
`GoogleAuth`/`GraphAuth` 없이 앱 소유 token provider를 주입하고,
401 후 `failed_token`을 전달해 새 토큰으로 재시도하는 흐름을 확인한다.
이번 검증은 OAuth SDK 자체와 실제 계정의 cache 지속성을 실행하지
않았으므로 실제 계정 release gate는 그대로 남는다.
