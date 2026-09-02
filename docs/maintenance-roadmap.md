# FIELDNOTE 유지보수 로드맵

기준: 2026-09-02 현재 구현 및 자동화 검증
상세 근거: [제품 워크플로우 및 검증](./product-workflows-and-verification.md)
운영 절차: [릴리스 런북](./release-runbook.md)

## 현재 판정

FIELDNOTE는 오프라인 로컬 저장, PWA cold start, 프로젝트 범위, 데모 역할 분리, outbox 기반 서버 ACK, revision 충돌 탐지와 명시적 서버 버전 복구까지 자동화된 **로컬 통합 빌드**다. 그러나 실제 인증과 호스팅, 서버 사진 binary 업로드가 없으므로 **Production NO-GO**다.

검증된 기반:

- 클라이언트 unit/component/integration 205개 PASS
- 클라이언트 전체 계측 coverage: statements 93.42%, branches 81.95%, functions 85.60%, lines 93.42%
- core production logic coverage: statements 92.72%, branches 83.25%, functions 90.58%, lines 92.72%; runtime file 13/13 계측
- companion server 13개 PASS: lines 92.04%, branches 82.79%, functions 88.79%
- production artifact 대상 Playwright E2E 14개 PASS
- 전체 `npm run verify` PASS; client artifact SHA-256 `fe118bd224a6ffc2b74640091ffee7b48560989ca0c2e0ce6f4e940aab4d24a5`(32 files), server artifact SHA-256 `ca555e9cee042933665586d2d15a006f97816f0c3f4650f162c074cef3a84282`(9 files)

## 유지보수 원칙

1. 기능 확장보다 데이터 유실 방지, 권한 경계와 정직한 상태 표현을 우선한다.
2. 장치 저장, outbox 대기, 전송 중, 서버 ACK, 실패와 충돌을 별도 상태로 유지한다.
3. IndexedDB 및 서버 storage version을 올릴 때에는 migration과 rollback 호환성을 함께 검증한다.
4. 사용자 스토리, 위험과 자동 테스트를 같은 ID로 추적한다.
5. 정적 검사만으로 단계를 완료하지 않으며 production artifact와 companion server를 함께 검증한다.
6. artifact 생성과 실제 호스팅 배포를 같은 것으로 취급하지 않는다.
7. 외부 IdP와 사진 binary 저장이 없으면 production-ready로 표기하지 않는다.

## Phase 0 — 자동 품질 및 릴리스 안전장치

Status: In progress
Updated: 2026-09-02 12:26 Australia/Sydney

### 목표

회귀를 merge 전에 발견하고, 검증한 client/server 산출물을 내용 변경 없이 승격할 수 있게 한다.

### 구현 및 검증 완료

- Angular/Vitest unit·component·IndexedDB 통합 테스트와 Playwright E2E를 구성했다.
- coverage gate가 statements, branches, functions, lines 각각 80%를 강제한다.
- gate가 `src/app/core`의 runtime TypeScript 전체 계측 여부와 core 집계 80%를 별도로 검증한다.
- production build에 optimization, output hashing, bundle budget, service worker와 SPA fallback을 적용했다.
- GitHub Actions가 typecheck, client/server tests, client/server build, E2E, 양쪽 artifact checksum 검증을 수행한다.
- client와 companion server를 별도 immutable artifact로 패키징하고 SHA-256 manifest를 생성·재검증한다.
- local preview가 deep link fallback, hashed asset immutable cache와 shell/manifest 재검증 cache 정책을 제공한다.

### 남은 작업

- 실제 staging/production hosting target과 배포 자격 증명을 정한다.
- 같은 checksum artifact의 staging 승격, canary 및 rollback을 실제 호스트에서 훈련한다.
- QA 승인 source SHA, client/server aggregate checksum과 배포 기록을 영구 보존하는 release record를 마련한다.
- 현재 CI는 artifact 업로드까지만 수행하며 외부 환경 배포는 하지 않는다.

### 완료 기준

- CI의 모든 품질 gate가 동일 source SHA에서 통과한다.
- staging이 CI에서 검증한 client/server checksum과 정확히 일치한다.
- schema-compatible rollback과 서버 데이터 복구 훈련을 실제 배포 환경에서 재현한다.

## Phase 1 — 오프라인 데이터 무결성과 정직한 상태

Status: In progress
Updated: 2026-09-02 12:26 Australia/Sydney

### 목표

네트워크와 무관하게 장치 저장을 보장하고, 저장 실패나 초기화 경쟁으로 사용자의 현장 기록을 잃지 않게 한다.

### 구현 및 검증 완료

- `localSaveStatus`와 `syncStatus`를 분리하고 서버 ACK 전에는 `synced`를 표시하지 않는다.
- IndexedDB transaction 완료를 await하고 open/request/abort/quota 오류를 호출자에게 전달한다.
- 검사별 write를 직렬화하고 hydrate 중 생성·편집한 변경을 병합한다.
- 잘못된 저장 행을 quarantine하고 legacy 날짜 및 inline data URL 사진을 정규화·이관한다.
- 사진 binary를 별도 IndexedDB Blob store로 분리하고 metadata 실패 시 보상 정리를 수행한다.
- 압축 결과 사진당 5 MiB, 프로젝트당 100 MiB 한도를 적용한다.
- 앱 셸을 PWA로 캐시하고 새로 만든 로컬 검사의 offline 새 탭 cold start를 Playwright로 검증했다.
- 장치 저장 실패를 성공으로 표시하지 않으며 재시도 경로를 제공한다.

### 남은 작업

- quarantine 행을 사용자가 확인하고 export 또는 정리할 수 있는 복구 UI를 제공한다.
- 브라우저 실제 quota exhaustion과 장시간 현장 데이터 누적 시나리오를 확장한다.
- IndexedDB schema 2에서 구버전 client로의 downgrade는 `VersionError` 위험이 있으므로 schema-compatible rollback만 허용하고 실제 훈련을 추가한다.
- 서비스 워커 update 적용/유예 UX와 장치별 storage pressure 안내를 추가한다.

### 완료 기준

- 정상 저장, 저장 실패, hydrate race, migration, quota와 offline cold start가 지원 브라우저에서 통과한다.
- 손상 데이터의 사용자 복구 경로와 schema migration/rollback 정책이 실제 배포 런북으로 검증된다.

## Phase 2 — 프로젝트·사용자·감사 신뢰 경계

Status: In progress
Updated: 2026-09-02 12:26 Australia/Sydney

### 목표

현장과 사용자 사이의 경계를 UI 표시가 아니라 인증된 서버 권한과 신뢰 가능한 감사 기록으로 강제한다.

### 구현 및 검증 완료

- project membership을 목록, 상세 deep link, dashboard, 감사와 export query에 적용했다.
- Inspector, Reviewer, Admin 데모 권한을 client와 companion API 양쪽에서 검사한다.
- 작성자와 승인자를 분리하고 Inspector 제출 후 Reviewer 승인 흐름을 E2E로 검증했다.
- 서버가 revision, actor와 timestamp를 생성하고 mutation/거부 이벤트를 append-only 상태에 기록한다.
- 서버 CSV는 project scope와 formula injection 방어를 적용한다.
- membership이 없는 사용자가 기본 프로젝트 데이터로 fallback하지 않도록 `No project access` 상태를 둔다.

### 남은 작업

- 현재 identity와 Bearer token은 client bundle에 포함된 선택형 데모 값이다. 외부 IdP/JWT, 안전한 세션, token expiry·revocation·key rotation을 구현해야 한다.
- 오프라인에서 생성된 queued action을 재연결 시 실제 IdP 권한으로 재인가하는 정책이 필요하다.
- UI 감사 화면은 여전히 장치 로컬 이력 중심이다. 서버 권위 audit 조회, 보존 정책과 운영 export를 연결해야 한다.
- 단일 JSON storage를 관리형 transaction database로 교체하고 다중 인스턴스 권한·동시성을 검증해야 한다.
- 암호학적 tamper-evident 감사 체인은 구현되지 않았다.

### 완료 기준

- production identity로 프로젝트 간 read/write/export/approve 격리가 API와 UI에서 통과한다.
- 만료·폐기된 자격과 권한 변경 후 queued action이 안전하게 거부 또는 재인가된다.
- 승인·거부와 서버 audit가 production database의 보존·백업 정책 안에서 검증된다.

## Phase 3 — UX, 접근성, 성능 안정화

Status: In progress
Updated: 2026-09-02 12:26 Australia/Sydney

### 목표

현장 장치에서 반복 작업을 빠르고 접근 가능하며 예측 가능하게 유지한다.

### 구현 및 검증 완료

- 기본 검사자, 자동 동기화, Wi-Fi 전용, 사진 메타데이터와 compact register 설정을 실제 동작에 연결했다.
- 새 검사 dialog에 초기 focus, focus trap, Escape와 focus 복귀를 추가했다.
- 체크 응답 선택 상태를 `aria-pressed`와 명시적 label로 전달한다.
- 핵심 목록에 axe serious/critical 0건과 390×844 horizontal overflow 없음이 자동화됐다.
- ISO timestamp 정규화와 en-AU 표시 로케일을 적용했다.
- UUID 기반 record/operation ID를 사용한다.
- JPEG/PNG/WebP 입력 검증, 최대 10 MiB 입력, 1920px 축소와 압축을 적용했다.
- 템플릿 edit/publish version과 검사 생성 시 snapshot을 저장한다.
- 위치 정보는 수집하지 않음을 UI에 명확히 표시한다.

### 남은 작업

- detail, 사진, 신규 검사, 템플릿 편집, 설정, 감사 전체에 axe·키보드 자동화를 확대한다.
- tablet 및 지원 브라우저 조합에서 CTA, scroll과 overflow를 검증한다.
- 긴 메모의 입력별 전체 저장·audit event 폭증을 debounce 또는 event aggregation으로 줄이고 성능 budget을 정한다.
- quarantine 복구와 storage pressure UI를 현장 사용성 테스트에 포함한다.
- 향후 위치 정보가 필요하면 명시적 동의, 권한 거부, 정확도와 보존 정책을 먼저 정의한다.

### 완료 기준

- 지원 viewport와 키보드/보조기술 경로에서 핵심 작업을 끝까지 완료한다.
- 대형 사진·긴 메모·장기 데이터에서 저장 응답성과 storage 사용량이 합의된 budget 안에 든다.

## Phase 4 — 실제 동기화와 운영 관측성

Status: In progress
Updated: 2026-09-02 12:26 Australia/Sydney

### 목표

인증된 권위 서버, 데이터/사진 전송, 재시도, 충돌 복구와 운영 관측성을 갖춘 동기화 제품으로 전환한다.

### 구현 및 검증 완료

- IndexedDB outbox에 actor, operation ID, idempotency key, base revision과 payload를 영속화한다.
- 연결 복구 시 최대 100개를 actor별 순서대로 전송하고 network/timeout/5xx에 지수 backoff를 적용한다.
- 서버 ACK를 로컬 inspection에 먼저 저장한 뒤 outbox를 제거하며, 남은 작업이 있으면 `pending`을 유지한다.
- `pending`, `syncing`, `failed`, `conflicted`, `synced`를 구분하고 401/403에는 자동 재시도를 중단한다.
- 서버가 idempotent batch, optimistic revision, 상태 전이와 separation of duties를 검증한다.
- revision conflict는 queue를 보존·중단하고 사용자가 경고를 확인한 뒤 **Use server version**을 선택할 때만 서버 snapshot으로 교체한다.
- 서버 버전 복구 후 stale outbox를 제거하고 새 server revision/ACK를 저장하는 E2E가 통과했다.
- health와 Prometheus request/latency/operation 결과 지표를 제공한다.

### 남은 작업

- 사진 binary multipart/resumable upload, checksum 검증, remote object storage와 orphan cleanup을 구현한다. 현재 서버에는 metadata만 전송된다.
- 충돌 시 server version 수용 외에 local rebase 또는 field-level merge 경로를 설계한다.
- 실제 IdP 자격, HTTPS API endpoint, production CORS와 secret rotation을 연결한다.
- managed database, multi-instance idempotency, audit/outbox retention과 backup 복구를 검증한다.
- hosted staging/canary/production 승격과 rollback을 구현한다.
- metrics를 보호된 수집 시스템, dashboard와 alert에 연결한다.

### 완료 기준

- 텍스트와 사진 모두 server ACK 전에는 `synced`가 되지 않는다.
- 중복 전송, 재시작과 다중 인스턴스에서도 inspection·사진·audit 중복이 없다.
- server/local 양쪽 수정이 자동 손실 없이 탐지되고 사용자가 두 방향 중 하나를 안전하게 완료할 수 있다.
- 실제 장애, 자격 폐기, backup restore와 schema-compatible rollback 훈련이 운영 환경에서 통과한다.

## 다음 권장 작업

1. production IdP와 hosted API/storage 대상을 결정하고 demo identity를 production build에서 제거한다.
2. 사진 binary upload와 remote checksum/정리 계약을 구현한다.
3. server audit를 UI/운영 export에 연결하고 managed transaction database로 이관한다.
4. 실제 staging에서 immutable client/server artifact 승격과 rollback 훈련을 수행한다.
5. 전체 route 접근성, tablet/browser matrix와 긴 입력 성능 테스트를 보강한다.

위 네 production 선행 조건 중 인증, 사진 binary, managed storage, 실제 hosting이 완료되기 전까지 릴리스 판정은 **NO-GO**를 유지한다.

## 재현 명령

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
npm run build:server
npm run e2e
npm run artifact:checksum
npm run artifact:verify
npm run artifact:server:checksum
npm run artifact:server:verify
```

로컬 production-artifact 흐름은 `npm run build` 후 `npm run e2e`로 재현한다. Playwright가 companion server와 `dist/fieldnote` preview를 함께 시작한다. 실제 외부 staging 검증은 호스팅 대상이 아직 없으므로 완료되지 않았다.
