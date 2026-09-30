# 라이선스 검토 (2026-09-30)

## 결정과 범위

drivefs 자체 코드와 독립적으로 배포하는 Python 4개·Node.js 3개 패키지는
Apache-2.0으로 배포한다. 각 빌드 프로젝트에 `LICENSE`와 SPDX 메타데이터를
둔다. 아래 표는 Windows Python 3.12의 격리 설치 환경과 `node/package-lock.json`
기준이다. 버전 범위가 바뀌거나 새 의존성을 추가하면 배포 전에 다시 확인한다.

| 배포 구성 | 외부 runtime 의존성 | 확인한 라이선스 |
| --- | --- | --- |
| Python `drivefs` | 없음 | 해당 없음 |
| Python `drivefs-gdrive`, `drivefs-microsoft` | `httpx` 0.28.1 → `anyio` 4.15.1, `certifi` 2026.7.22, `httpcore` 1.0.9, `h11` 0.16.0, `idna` 3.20, Python 3.12에서는 `typing_extensions` 4.16.0 | `httpx`·`httpcore`·`idna`: BSD-3-Clause; `anyio`·`h11`: MIT; `typing_extensions`: PSF-2.0; `certifi`: MPL-2.0 |
| Python `drivefs-fsspec` | `fsspec` 2026.9.0 | BSD-3-Clause |
| Node.js 3개 패키지 | 외부 runtime 의존성 없음; provider는 workspace core만 사용 | 해당 없음 |

Python wheel에는 위 외부 패키지를 넣지 않는다. `pip`가 별도 배포물로
설치한다. 특히 `certifi`의 MPL-2.0 코드를 Apache-2.0 코드로
재라이선스하지 않는다. Mozilla는 MPL 코드와 Apache 코드의 결합을 허용하되,
MPL 코드의 별도 권리와 배포 의무를 유지한다고 설명한다. 향후 단일 실행 파일,
컨테이너 이미지 등으로 `certifi`를 포함해 재배포할 때는 해당 버전의
라이선스·고지·소스 접근 요건을 그 배포물에서 검토한다. `certifi` 또는 다른
제3자 코드를 수정하거나 저장소에 복사하면 다시 검토한다.

Node.js lockfile의 외부 97개 패키지는 lint·format·TypeScript 빌드용
개발 의존성이다. lockfile의 라이선스 필드는 MIT 71, Apache-2.0 13,
BSD-2-Clause 6, BSD-3-Clause 1, ISC 5, BlueOak-1.0.0 1이며 누락은
없었다. 이 도구들은 npm 배포 tarball의 runtime 의존성에 포함되지 않는다.
Python의 `setuptools`, `wheel`, `ruff`, `mypy` 등 빌드·검증 도구도
배포물의 runtime 의존성이 아니다.

## 확인 근거

- [Apache-2.0 원문](https://www.apache.org/licenses/LICENSE-2.0.txt),
  [적용 안내](https://www.apache.org/legal/apply-license.html)
- [`httpx` 0.28.1 메타데이터](https://github.com/encode/httpx/blob/0.28.1/pyproject.toml),
  [`httpcore` 메타데이터](https://github.com/encode/httpcore/blob/master/pyproject.toml),
  [`fsspec` 2026.9.0 메타데이터](https://github.com/fsspec/filesystem_spec/blob/2026.9.0/pyproject.toml)
- [`certifi` 2026.7.22 PyPI 라이선스](https://pypi.org/project/certifi/2026.7.22/),
  [`typing_extensions` 4.16.0 PyPI 라이선스](https://pypi.org/project/typing-extensions/4.16.0/),
  [Mozilla MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/),
  [ASF의 제3자 라이선스 분류](https://www.apache.org/legal/resolved.html)
- 설치된 Python wheel의 `License-Expression` 메타데이터 및
  [`node/package-lock.json`](../node/package-lock.json)의 `license` 필드

이 검토는 현재 의존성 및 배포 형태에 대한 기술적 라이선스 점검이다.
제3자 구성 요소를 묶어 배포하는 방식이 바뀌면 별도 검토가 필요하다.
