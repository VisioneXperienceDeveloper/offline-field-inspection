# FIELDNOTE 릴리스 런북

Updated: 2026-09-02 12:26 Australia/Sydney
Current decision: **Production NO-GO**

## 1. 목적과 범위

이 문서는 FIELDNOTE client와 companion server를 검증하고, 같은 immutable artifact를 staging/production으로 승격하며, 장애 시 안전하게 복구하기 위한 절차다.

현재 저장소에서는 다음까지만 실제로 수행할 수 있다.

- client/server tests, production build와 Playwright local integration
- client/server artifact packaging
- manifest에 포함된 파일의 SHA-256 및 aggregate checksum 재검증
- local production artifact preview와 single-process companion service 실행

실제 hosting target, production IdP, managed database와 server photo binary storage는 아직 없다. 따라서 이 런북의 외부 staging/production 절차는 준비 기준이며, 아래 hard gate가 충족되기 전에는 배포를 진행하지 않는다.

## 2. Production hard gate

다음 항목 중 하나라도 미충족이면 **NO-GO**다.

- [ ] Demo profile switcher와 client bundle의 demo Bearer token이 production build에서 제거됐다.
- [ ] 외부 IdP/JWT의 발급, 서명 검증, expiry, revocation, key rotation과 queued-action 재인가가 통합됐다.
- [ ] Hosted client가 HTTPS API를 가리키는 검증 가능한 runtime/build configuration이 있다. 현재 기본 API는 `http://127.0.0.1:8787`로 고정돼 있다.
- [ ] 사진 binary upload, remote checksum 검증, durable object storage와 orphan cleanup이 구현됐다.
- [ ] Single-process JSON 파일 대신 production transaction database와 multi-instance idempotency가 검증됐다.
- [ ] 실제 staging/production host, TLS, DNS, CORS, secret store와 metrics ACL이 구성됐다.
- [ ] Server backup/restore 및 client/server schema-compatible rollback 훈련이 staging에서 통과했다.
- [ ] CI가 검증한 source SHA와 artifact checksum을 release record에 보존하고 배포 대상과 대조할 수 있다.

현재 상태에서는 위 항목이 남아 있으므로 Production NO-GO다. 강한 임시 demo token을 넣는 것만으로 실제 인증 gate를 충족하지 않는다.

## 3. 릴리스 입력

필수 조건:

- Node.js 22
- lockfile과 일치하는 `npm ci` 설치
- Playwright Chromium
- review가 끝난 clean release commit
- client/server storage schema 호환성 검토
- 배포 환경별 승인된 configuration과 secret reference

릴리스 시작 전에 다음을 확인한다.

```bash
git status --short
git rev-parse HEAD
npm ci
npx playwright install chromium
```

`git status --short` 출력이 있으면 release artifact를 만들지 않는다. Manifest의 `sourceSha`는 Git commit만 기록하므로 미커밋 변경을 식별하지 못한다.

## 4. 전체 품질 gate

Release commit에서 다음 한 명령을 실행한다.

```bash
npm run verify
```

이 명령은 순서대로 다음을 수행한다.

1. application/spec TypeScript typecheck
2. client coverage tests와 core coverage gate
3. companion server tests/coverage gate
4. production client build
5. companion server package build
6. production artifact를 사용하는 Playwright E2E
7. client/server checksum manifest 생성
8. manifest에 기록된 양쪽 파일과 aggregate checksum 재검증

어느 단계든 exit code가 0이 아니면 릴리스를 중단한다. 실패 test를 skip/expected-fail로 바꿔 진행하지 않는다.

최종 수동 재검증 명령:

```bash
npm run artifact:verify
npm run artifact:server:verify
```

## 5. Coverage와 테스트 승인 기준

최소 gate:

- client 전체 report: statements, branches, functions, lines 각각 80% 이상
- core production logic 집계: statements, branches, functions, lines 각각 80% 이상
- type-only allowlist를 제외한 `src/app/core` runtime TypeScript 100% 계측
- server lines, branches, functions 각각 80% 이상
- Playwright E2E 전부 PASS

2026-09-02 최종 local verification record:

| Gate | 결과 |
| --- | --- |
| Client unit/component/integration | 205/205 PASS |
| Client overall S/B/F/L | 93.42% / 81.95% / 85.60% / 93.42% |
| Core S/B/F/L | 92.72% / 83.25% / 90.58% / 92.72%; runtime 13/13 measured |
| Companion server | 13/13 PASS; L/B/F 92.04% / 82.79% / 88.79% |
| Playwright | 14/14 PASS |
| Full command | `npm run verify` PASS |

이 결과는 현재 local integration 품질 증거이며 hosted production 검증이 아니다.

## 6. Artifact 생성과 식별

`npm run verify`가 다음 두 디렉터리를 만든다.

| Artifact | 경로 | 현재 schema version |
| --- | --- | ---: |
| Angular PWA client | `dist/fieldnote` | IndexedDB 2 |
| Node companion service | `dist/fieldnote-server` | Server storage 1 |

필요하면 별도로 다시 생성한다.

```bash
npm run build
npm run build:server
npm run artifact:checksum
npm run artifact:server:checksum
npm run artifact:verify
npm run artifact:server:verify
```

각 `artifact-manifest.json`에서 다음을 release record에 기록한다.

- `sourceSha`
- `databaseSchemaVersion`
- `artifactSha256`
- 파일 수
- CI run URL과 승인자

현재 검증 결과:

| Artifact | Files | Aggregate SHA-256 |
| --- | ---: | --- |
| Client | 32 | `fe118bd224a6ffc2b74640091ffee7b48560989ca0c2e0ce6f4e940aab4d24a5` |
| Server | 9 | `ca555e9cee042933665586d2d15a006f97816f0c3f4650f162c074cef3a84282` |

현재 manifest의 `sourceSha`는 `1a5c46ef1d488436c95f6d2262663b7b7f3e8d66`이지만 검증 당시 working tree에 이후 변경이 존재한다. 따라서 위 artifact는 production 승격 대상이 아니다. 변경을 commit한 다음 새 `npm run verify`로 checksum을 다시 생성해야 한다.

Checksum verifier는 manifest에 나열된 파일의 내용과 크기를 검증한다. CI가 업로드한 artifact 디렉터리 외의 파일을 혼합하지 말고, 배포 직전과 대상 host에 복사한 뒤 같은 verifier를 실행한다.

## 7. Configuration 계약

### Client

현재 `FieldnoteSyncClient`의 API 기본값은 `http://127.0.0.1:8787`이다. 실제 hosted release 전에는 승인된 HTTPS endpoint를 runtime 또는 environment별 build configuration으로 주입하고 다음을 보장해야 한다.

- endpoint 변경이 checksum이 있는 release artifact에 명시된다.
- token/secret이 static asset, source map 또는 browser storage에 포함되지 않는다.
- service worker가 API response나 인증 정보를 application shell asset처럼 cache하지 않는다.
- `index.html`, `ngsw.json`, `ngsw-worker.js`, manifest와 artifact manifest는 재검증되고 hashed assets만 immutable cache된다.
- static host가 extension 없는 route를 `index.html`로 fallback하고 존재하지 않는 asset은 404로 반환한다.

현재 이 hosted API configuration이 구현되지 않아 외부 배포는 차단된다.

### Companion server

| 변수 | release 요구사항 |
| --- | --- |
| `FIELDNOTE_HOST` | reverse proxy 뒤의 의도한 bind address |
| `FIELDNOTE_PORT` | 플랫폼이 할당하거나 승인한 port |
| `FIELDNOTE_DATA_FILE` | 현재 local integration에서는 durable volume의 명시적 파일 경로; production DB 이관 후 사용하지 않음 |
| `FIELDNOTE_BODY_LIMIT_BYTES` | 예상 payload와 DoS 제한을 반영한 값 |
| `FIELDNOTE_CORS_ORIGINS` | HTTPS client origin의 정확한 allowlist; `*` 금지 |
| `FIELDNOTE_BUILD_VERSION` | release commit 또는 immutable release ID |
| Demo token 변수 | local demo 전용; production에서는 external IdP로 대체 |

추가 요구사항:

- TLS는 승인된 reverse proxy/load balancer에서 종료한다.
- `/metrics`는 public internet에 노출하지 않고 monitoring network 또는 proxy ACL로 제한한다.
- token, authorization header, 사진과 inspection payload를 request log에 남기지 않는다.
- CORS preflight와 body limit 거부를 staging에서 확인한다.

## 8. Server 데이터 backup

현재 파일 storage를 사용하는 local/staging-like 환경에서만 적용한다.

1. 새 mutation 유입을 중단한다.
2. Companion process에 `SIGTERM`을 보내고 정상 종료를 기다린다.
3. 실제 `FIELDNOTE_DATA_FILE` 경로를 확인한다.
4. 같은 storage version을 포함한 파일을 timestamp와 release ID가 있는 별도 backup 위치에 복사한다.
5. backup checksum과 복구 담당자를 release record에 남긴다.
6. 원본을 수정하지 않고 staging 복제본으로 restore smoke를 수행한다.

Process가 쓰는 중인 JSON 파일을 임의로 복사하거나 빈 파일로 덮어쓰지 않는다. Production 전에는 관리형 database의 일관된 snapshot/PITR 절차로 교체해야 한다.

## 9. Staging 배포 절차

Hosting target이 결정되고 Production hard gate가 해소된 뒤에만 실행한다.

1. CI에서 release commit의 client/server artifact와 manifest를 받는다.
2. 두 artifact checksum을 로컬에서 다시 검증한다.
3. Server data backup과 storage migration plan을 승인한다.
4. Server artifact를 staging에 배치하고 승인된 environment/secret reference를 주입한다.
5. `/healthz`의 build version이 release ID와 일치하는지 확인한다.
6. `/metrics`가 보호된 monitoring 경로에서만 보이는지 확인한다.
7. Client artifact를 SPA fallback과 cache 계약을 가진 static host에 배치한다.
8. 배포된 파일이 CI artifact와 같은 checksum인지 확인한다.
9. 아래 staging smoke를 모두 수행한다.
10. 결과, source SHA, checksum, database migration과 승인자를 release record에 남긴다.

현재 실제 staging host가 없으므로 이 절차는 아직 실행되지 않았다.

## 10. Staging smoke

### 서비스와 보안

- [ ] HTTPS client와 API만 사용한다.
- [ ] `/healthz`가 예상 build version으로 200을 반환한다.
- [ ] 허용되지 않은 Origin, 무인증, 만료·폐기 token이 거부된다.
- [ ] Demo identity/profile switcher가 production UI와 bundle에 없다.
- [ ] Inspector, Reviewer, Admin의 project permission이 API 우회에도 적용된다.
- [ ] Metrics endpoint가 public client에서 차단된다.

### 핵심 업무

- [ ] Inspector가 허용 project에서 template snapshot으로 Draft를 만든다.
- [ ] Offline 작성과 reload 뒤 장치 저장 상태가 복원된다.
- [ ] 연결 복구 전에는 remote queued, 실제 ACK 뒤에만 synced가 표시된다.
- [ ] Reviewer만 별도 actor의 Submitted record를 승인할 수 있다.
- [ ] 다른 project의 목록, audit, export와 direct URL이 차단된다.
- [ ] Server-side actor/revision/timestamp audit를 조회할 수 있다.

### 동기화와 충돌

- [ ] 동일 idempotency key 재전송이 중복 record/audit를 만들지 않는다.
- [ ] Network/5xx 뒤 operation ID를 유지해 재시도한다.
- [ ] Revision conflict가 queue를 보존하고 자동 덮어쓰지 않는다.
- [ ] Server version을 명시적으로 선택한 경우에만 local queued edit가 폐기된다.
- [ ] ACK local commit 실패 시 outbox가 유지된다.

### 사진과 PWA

- [ ] 사진 binary가 remote storage에 업로드되고 checksum을 server가 확인한다.
- [ ] 실패/재시도/삭제가 orphan binary 또는 metadata를 남기지 않는다.
- [ ] 새 탭 offline cold start에서 기존 local inspection과 사진을 연다.
- [ ] Service worker update와 이전 client tab의 호환성을 확인한다.

사진 binary 항목은 현재 구현으로 통과할 수 없으므로 Production NO-GO다.

## 11. Production 승격

다음을 모두 만족한 경우에만 staging에서 검증한 동일 checksum artifact를 production으로 승격한다.

- Production hard gate 전부 충족
- Full CI와 staging smoke 전부 PASS
- Client/server checksum이 staging 검증값과 동일
- Schema migration과 backup/restore 승인 완료
- 관측 dashboard/alert와 on-call 담당자 확인
- Rollback 또는 roll-forward artifact의 schema compatibility 확인
- Release owner와 QA 승인 기록 완료

Production에서 다시 build하거나 configuration 파일을 직접 편집하지 않는다. 환경별 configuration 때문에 artifact 내용이 달라지면 별도 checksum과 승인을 받아야 한다.

## 12. Rollback 및 roll-forward

### 호환성 확인

- Client artifact manifest의 현재 IndexedDB schema version은 2다.
- Server artifact manifest의 현재 storage version은 1이다.
- Schema 2 DB를 이미 연 장치에 version 1 client를 배포하면 `VersionError`가 발생할 수 있다.
- 이전 server가 현재 JSON storage version을 이해하지 못하면 시작을 거부하거나 데이터를 손상할 수 있다.

따라서 단순히 이전 정적 파일로 되돌리지 않는다. Target artifact가 현재 client DB/server storage version을 읽을 수 있음을 사전에 증명한 경우에만 rollback한다. 호환성이 불명확하면 현재 schema를 지원하는 수정 artifact로 roll-forward한다.

### 절차

1. 새 mutation 유입과 자동 승격을 중단한다.
2. 영향 release ID, client/server checksum과 최초 오류 시각을 기록한다.
3. Server를 정상 종료하고 현재 data snapshot을 보존한다.
4. 검증된 이전 artifact의 manifest/checksum과 schema compatibility evidence를 확인한다.
5. Server를 교체한 뒤 `/healthz`, read-only GET, permission과 audit smoke를 수행한다.
6. Client artifact를 교체하고 shell/manifest는 재검증, hashed asset은 immutable cache 계약을 유지한다.
7. Service worker update가 적용된 새 탭과 기존 탭을 모두 확인한다.
8. Offline local record, outbox와 사진 Blob이 보존됐는지 확인한다.
9. 동일 문제 재발 시 rollback을 반복하지 않고 roll-forward 또는 데이터 복구 절차로 전환한다.

Server data restore는 artifact rollback과 별도 결정이다. 새 release에서 생성된 정상 데이터를 잃을 수 있으므로 incident owner와 data owner 승인 없이 이전 snapshot으로 덮어쓰지 않는다.

## 13. 운영 관측과 사고 대응

현재 companion service는 health와 Prometheus text metrics를 제공하지만 collector/dashboard/alert는 구성되지 않았다. Production 전 다음을 연결한다.

- 요청 수와 latency
- operation `acked`, `rejected`, `conflict`
- retry 증가와 outbox age
- 401/403 증가와 revoked credential 재시도
- photo upload 실패/checksum mismatch/orphan cleanup
- storage quota, backup age와 restore test 상태

사고 발생 시:

1. 자동 배포와 destructive cleanup을 중단한다.
2. Release ID, checksum, server storage version과 client DB version을 기록한다.
3. Health/metrics, server audit와 영향 project 범위를 수집한다.
4. 장치의 local inspection/outbox/photo DB를 삭제하지 않는다.
5. Schema compatibility에 따라 rollback 또는 roll-forward를 결정한다.
6. 복구 후 offline queue-to-ACK, conflict, project isolation과 사진 checksum을 다시 smoke한다.

## 14. 현재 최종 판정

Local `npm run verify`와 artifact integrity gate는 통과했다. 그러나 실제 IdP, remote photo binary, managed storage와 hosted deployment가 없고 현재 manifest가 미커밋 변경을 완전히 식별하지 못하므로 **Production NO-GO**를 유지한다.
