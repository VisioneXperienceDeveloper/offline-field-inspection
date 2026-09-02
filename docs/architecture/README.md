# FIELDNOTE 아키텍처 문서

이 디렉터리는 FIELDNOTE의 현재 구현을 설명하는 아키텍처 진입점이다. 신규 개발자, QA, 운영자와 아키텍처 검토자가 코드와 운영 문서를 같은 기준으로 읽을 수 있도록 구성했다.

## 문서 지도

| 문서 | 목적 |
| --- | --- |
| [arc42 아키텍처 문서](./arc42.md) | 목표, 제약, C4 구조, UML 런타임, 배포, 결정, 품질 시나리오, 위험과 용어를 arc42 12개 섹션으로 정리 |
| [제품 워크플로우 및 검증](../product-workflows-and-verification.md) | 사용자 사례, 사용자 스토리, 자동 검증 근거 |
| [유지보수 로드맵](../maintenance-roadmap.md) | 단계별 완료 상태와 다음 구현 우선순위 |
| [릴리스 런북](../release-runbook.md) | 빌드, 검증, 승격, 백업, 복구와 롤백 절차 |
| [Companion API 문서](../../server/README.md) | API, 인증, 상태 전이, 환경 변수와 저장 계약 |

## 현재 판정

문서 기준일은 2026-09-02이며, 코드 구현 기준선은 `feature/offline-inspection-reliability` 브랜치의 `11a89f5`다. 문서 변경 commit은 별도로 추적한다. FIELDNOTE는 자동 테스트가 갖춰진 로컬 통합이지만 실제 IdP, 사진 binary 원격 저장, 관리형 데이터베이스와 배포 대상이 없어 Production NO-GO다.

## 다이어그램 규칙

- 정적 구조는 C4의 System Context, Container, Component 관점으로 표현한다.
- 시간 순 상호작용과 상태 전이는 UML sequence/state/class 관점을 Mermaid로 표현한다.
- C4에서 Container는 Docker만을 뜻하지 않는다. 독립 실행 애플리케이션이나 데이터 저장소를 뜻한다.
- 현재 구현과 목표 아키텍처를 섞지 않는다. `Planned / not implemented` 표기가 없는 요소만 현재 존재한다고 해석한다.
- 다이어그램과 설명은 같은 Markdown 파일에서 코드와 함께 변경 이력을 관리한다.

## 갱신 규칙

다음 변경은 같은 커밋에서 [arc42 문서](./arc42.md)를 함께 갱신한다.

- 런타임 컨테이너, 저장소 또는 외부 시스템 경계 변경
- 인증, 권한, 프로젝트 격리 또는 데이터 권위 변경
- IndexedDB나 서버 storage schema version 변경
- outbox, ACK 순서, retry 또는 충돌 정책 변경
- API 계약, 환경 변수, 배포 토폴로지 또는 rollback 전략 변경
- 품질 gate, SLO, Production GO/NO-GO 기준 변경
