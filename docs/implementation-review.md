# 구현계획 review 판정

검토일: 2026-09-30
입력: `implementation-plan.md` SHA-256
`D27C38348DD45E8B6E4289BB25F79DD937B20182F8B516B713FE7D1984AD1AAE`,
`v1-plan.md` SHA-256
`9B0552DFD89C45C01184D22D70847E0EAC8AF556C18121FA14020F773592154E`,
`storage-api.md` SHA-256
`23022761BE1DCB76CD1FBD309DC6FC60969B140BACFDCEA04ED16482ED8C8E11`.
기준 commit은 `8974441`이다. 원본 독립 보고서는 작업 트리의
`.worknotes/reviews/integration.md`와 `validation.md`에 보존했다.

통합 개발자와 검증 담당자 관점의 독립 1차 review를 완료한 뒤,
각 지적의 명세·계획 내 보호 장치와 공식 API 근거를 직접 확인했다.
같은 원인의 INT-05와 VAL-01은 하나로 판정했다. 아직 코드가
없으므로 아래의 실패 시나리오를 실제 장애로 보고하지 않는다.

| finding | 판정과 적용 | 남은 검증 |
| --- | --- | --- |
| INT-01 | 채택. stream은 명시적 전체 `size`가 필요하고 fragment만 buffer한다. | 크기 누락·불일치, 대용량 fragment 실패 |
| INT-02 | 일부 채택. ref 연산 전 현재 root ancestry 확인; 확인과 변경 사이 race는 보장하지 않는다. | 외부 이동 fixture와 실제 계정 사례 |
| INT-03 | 채택. Python context 종료와 Node iterator 종료·취소가 응답을 닫는다. | 조기 종료·취소 시 자원 해제 |
| INT-04 | 구현 검증으로 이관. auth 형식과 refresh 저장 책임을 plugin 첫 커밋에서 문서화한다. | 만료·회전·저장 실패·동시 refresh |
| INT-05 / VAL-01 | 채택. fixture gate와 실제 계정 merge·release gate를 분리했다. | 여섯 실제 계정 결과는 현재 미확인 |
| VAL-02 | 채택. 배포 목표 OS와 현재 Linux container 검증 범위를 분리했다. | 목표 OS별 CI 설치 결과 |
| INT-06 / VAL-03 | 구현 검증으로 이관. 7개 artifact를 checkout 밖에서 개별 설치한다. | dependency metadata와 import smoke |
| VAL-04 | 구현 검증으로 이관. README 예제는 공개 import와 constructor를 사용한다. | 새 container의 lifecycle 예제 |
| VAL-05 | 현 상태 확인. credential과 게시 권한의 증거가 없다. | 계정 3종×2언어, registry 권한 |

INT-01은 [Graph upload session](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)이
첫 fragment 전에 전체 길이를 요구한다는 근거와 일치한다.
INT-02의 ancestry preflight는 외부 이동을 감지할 수 있으나
원자적인 root 보호를 제공하지 않는다. 이 한계를 API 명세에 적었다.

review 후 구현계획은 A–D 단계와 커밋 경계를 유지한다. 구현 진행에는
fixture·conformance가 필요하고, main merge와 v1.0.0 배포에는
실제 계정·지원 OS 검증이 별도로 필요하다. 코드와 컨테이너 검증이
없으므로 이 review는 구현 완료 또는 배포 승인이 아니다.
