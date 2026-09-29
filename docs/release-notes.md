# drivefs release notes

## 0.1.0 구현 후보 · 2026-09-30

이 버전은 registry에 게시하거나 v1.0.0으로 표시하지 않은 구현 후보이다.

- Python·Node.js의 `FileStorage` core, 공통 경로·오류·ref 규칙과
  언어 중립 conformance case를 추가했다.
- Google My Drive 지정 폴더와 Microsoft Graph의 OneDrive Personal,
  SharePoint document library plugin을 추가했다.
- Python 읽기 전용 `fsspec` adapter를 별도 package로 추가했다.
- Python 3.12~3.14 및 Node 24 Linux amd64 컨테이너에서 정적 검사,
  fixture test, wheel/tarball 설치 smoke를 통과했다. 상세 증거는
  [검증 기록](validation.md)에 있다.

공개 API와 오류 이름은 [API 명세](../spec/storage-api.md)에 정의되어
있다. 현재 구현의 모든 provider는 `conditional_replace=false`이며
동시 수정에 대한 원자적 보호를 제공하지 않는다. 실제 계정 3종 ×
2개 언어 검증, 목표 OS 설치 smoke, registry 권한 및 라이선스 확정이
끝나기 전에는 v1.0.0을 배포하지 않는다.

## v1.0.0 예정 gate

1. 실제 Google·OneDrive Personal·SharePoint 계정의 Python·Node.js
   lifecycle, refresh, 대용량 업로드·휴지통을 검증한다.
2. Linux·Windows·macOS 대상 플랫폼의 설치와 API smoke를 통과한다.
3. LICENSE·package metadata·registry 게시 권한을 확정한다.
4. release candidate에서 API와 오류 이름을 고정하고, 모든 gate를
   재검증한 뒤 1.0.0 배포물을 빌드한다.
