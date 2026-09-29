# 0.1.0 구현 후보 검증 기록

검증일: 2026-09-30 · 코드 기준: `7404814` (`codex/implement-v1`).
Microsoft의 빈 파일 경로 수정 `4ddfd09`와 Python fsspec 변경
`413e9db`까지 포함한다.
검증 환경은 Docker Desktop의 Linux `amd64`다. `.artifacts/`는 Git에서
제외하고, 아래 hash는 해당 실행에서 생성된 파일의 SHA-256이다.

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
--offline`으로 설치했다. 따라서 smoke에서 workspace link와 소스
checkout을 사용하지 않았다. 스크립트는
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

## v1.0.0 미통과 gate

| gate | 현재 증거 |
| --- | --- |
| Google·OneDrive Personal·SharePoint 실제 계정 × Python·Node lifecycle 및 refresh | 계정·credential이 없어 실행하지 못함. fixture 통과는 대체 증거가 아님 |
| Google 실제 계정 중복 이름·native 문서, provider별 권한·휴지통·대용량 응답 | 실행하지 못함 |
| Windows x86_64, macOS x86_64/arm64 설치 smoke·테스트 | 현재 Linux amd64 컨테이너만 검증 |
| registry 이름·npm scope 게시 권한, LICENSE, 최종 1.0 metadata | 확인·확정 전 |
| 원자적 조건부 교체 | 모든 provider가 capability=false; 1.0 필수 기능은 아니나 지원 주장 불가 |

따라서 이 기록은 구현 후보의 컨테이너 검증 증거이며 v1.0.0 배포
승인이나 main merge 승인으로 해석하지 않는다.
