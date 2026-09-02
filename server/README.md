# FIELDNOTE companion backend

Node.js 22 내장 모듈만 사용하는 단일 프로세스 companion API다. 프로젝트 권한, 서버 검증 상태 전이, 낙관적 revision, idempotent outbox ACK, append-only 감사 이벤트를 제공한다.

## 실행과 테스트

필수 조건은 Node.js 22 이상이다. 별도 패키지 설치는 필요 없다.

```bash
node server/index.mjs
node --test server/test/*.test.mjs
```

기본 주소는 `http://127.0.0.1:8787`이며 데이터는 `server/data/fieldnote.json`에 저장된다. 프로세스는 `SIGTERM`/`SIGINT` 수신 시 새 연결을 닫고 진행 중 요청의 종료를 기다린다.

## 환경 변수

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `FIELDNOTE_HOST` | `127.0.0.1` | listen 주소 |
| `FIELDNOTE_PORT` | `8787` | listen 포트, 테스트에서는 `0` 허용 |
| `FIELDNOTE_DATA_FILE` | `./server/data/fieldnote.json` | durable JSON 상태 파일 |
| `FIELDNOTE_BODY_LIMIT_BYTES` | `1048576` | JSON 요청 최대 크기, 1 KiB~10 MiB |
| `FIELDNOTE_CORS_ORIGINS` | `http://localhost:4200,http://127.0.0.1:4200,http://127.0.0.1:4173` | 쉼표로 구분한 명시적 Origin allowlist. `*` 금지 |
| `FIELDNOTE_DEMO_INSPECTOR_TOKEN` | `demo-inspector-token` | Inspector Bearer token |
| `FIELDNOTE_DEMO_REVIEWER_TOKEN` | `demo-reviewer-token` | Reviewer Bearer token |
| `FIELDNOTE_DEMO_ADMIN_TOKEN` | `demo-admin-token` | Admin Bearer token |
| `FIELDNOTE_BUILD_VERSION` | `development` | health 응답의 immutable build/release 식별자 |

기본 토큰은 로컬 데모 전용 공개 값이다. 공유 환경에서는 세 토큰을 서로 다른 16자 이상의 강한 비밀값으로 반드시 교체하고, 배포 플랫폼의 secret store에서 주입해야 한다. 요청이나 로그에 토큰을 기록하지 않는다.

## 데모 사용자와 프로젝트 권한

| 사용자 | 역할 | 프로젝트 | 권한 |
| --- | --- | --- | --- |
| Henry Kim (`demo-inspector`) | Inspector | `project-c3` | read, write, export |
| Rina Park (`demo-reviewer`) | Reviewer | `project-c3` | read, export, approve/return |
| Alex Morgan (`demo-admin`) | Admin | `project-c3`, `project-p2`, `project-north` | read, write, export, approve/return |

모든 `/v1` 요청은 `Authorization: Bearer <token>`을 요구한다. `write`는 생성·Draft 수정·Draft 삭제·제출을 포함한다. `approve`는 제출된 검사의 승인 또는 Draft 반려를 포함한다. 작성자와 승인자는 달라야 하므로 Admin도 자신이 만든 검사를 승인할 수 없다.

## 상태와 동시성 계약

허용되는 전이는 다음뿐이다.

```text
Draft --(write, 제출 조건 충족)--> Submitted
Submitted --(approve)-----------> Approved
Submitted --(approve)-----------> Draft
```

제출에는 실제 구역, 모든 필수 답변, fail 항목별 조치 메모, `requiresPhotos=true`일 때 최소 한 개의 업로드된 사진 메타데이터가 필요하다. Approved 레코드는 수정·삭제할 수 없다.

모든 mutation은 다음 값을 요구한다.

- `operationId`: 클라이언트 outbox의 영구 작업 식별자
- `Idempotency-Key` 헤더(배치에서는 작업 필드): 요청 중복 방지 키
- `baseRevision`: 클라이언트가 작업을 만든 시점의 서버 revision. 생성은 `0`

같은 사용자·프로젝트에서 동일한 operation과 payload를 반복하면 최초 ACK를 바이트 수준에서 같은 JSON 값으로 재생하며 inspection과 감사 이벤트를 중복 생성하지 않는다. 동일 키를 다른 payload에 재사용하면 `409`. 현재 revision과 `baseRevision`이 다르면 `REVISION_CONFLICT` `409`와 두 revision을 반환한다.

## API

### 읽기

| Method | Path | 권한 | 응답 |
| --- | --- | --- | --- |
| `GET` | `/health` 또는 `/healthz` | 공개 | liveness, build version |
| `GET` | `/metrics` | 공개 | Prometheus text metrics |
| `GET` | `/v1/projects/:projectId/inspections` | read | `{ "data": Inspection[] }` |
| `GET` | `/v1/projects/:projectId/inspections/:id` | read | `{ "data": Inspection }` |
| `GET` | `/v1/projects/:projectId/inspections/:id/audit` | read | 서버 작성 감사 이벤트 |
| `GET` | `/v1/projects/:projectId/inspections/export` | export | 해당 프로젝트만 포함한 CSV |

CSV 셀은 항상 따옴표로 감싸고 `=`, `+`, `-`, `@`로 시작하는 값 앞에 `'`를 붙여 formula injection을 막는다.

### 단일 mutation

생성 예시:

```bash
curl -X POST http://127.0.0.1:8787/v1/projects/project-c3/inspections \
  -H 'Authorization: Bearer demo-inspector-token' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-INSP-100' \
  -d '{
    "operationId":"op-create-INSP-100",
    "baseRevision":0,
    "inspection":{
      "id":"INSP-100",
      "title":"Daily safety inspection",
      "zone":"Zone A",
      "requiresPhotos":false,
      "photos":[],
      "checklist":[{"id":1,"title":"Guard rail","answer":"pass","note":"","required":true}]
    }
  }'
```

| Method | Path | body |
| --- | --- | --- |
| `POST` | `/v1/projects/:projectId/inspections` | `{ operationId, baseRevision: 0, inspection }` |
| `PATCH` | `/v1/projects/:projectId/inspections/:id` | `{ operationId, baseRevision, changes }` |
| `DELETE` | `/v1/projects/:projectId/inspections/:id` | `{ operationId, baseRevision }` |
| `POST` | `/v1/projects/:projectId/inspections/:id/transitions` | `{ operationId, baseRevision, status }` |

성공 ACK 예시:

```json
{
  "operationId": "op-create-INSP-100",
  "idempotencyKey": "create-INSP-100",
  "status": "acked",
  "projectId": "project-c3",
  "inspectionId": "INSP-100",
  "revision": 1,
  "serverTimestamp": "2026-09-02T01:23:45.000Z",
  "inspection": {}
}
```

### 배치 outbox

`POST /v1/projects/:projectId/sync/batch`는 1~100개 작업을 배열 순서대로 적용한다. 각 작업은 자체 idempotency key를 갖고, 일부 실패가 다른 작업의 ACK를 숨기지 않는다. HTTP 응답은 `200`이며 각 결과의 `status`가 `acked`, `rejected`, `conflict` 중 하나다.

```json
{
  "operations": [
    {
      "operationId": "op-001",
      "idempotencyKey": "idem-001",
      "kind": "update",
      "inspectionId": "INSP-100",
      "baseRevision": 1,
      "payload": {"weather": "Rain"}
    }
  ]
}
```

### 오류

mutation 전에 발생한 인증·라우팅·JSON 오류는 다음 형식이다.

```json
{"error":{"code":"AUTH_REQUIRED","message":"A Bearer token is required."},"requestId":"..."}
```

mutation 처리 결과는 operation 정보와 `status`, `error`를 함께 반환한다. 주요 상태 코드는 `400` malformed request, `401` auth, `403` membership/permission/separation of duties, `404` unknown resource, `409` revision/state/idempotency conflict, `413` body limit, `415` content type, `422` domain validation이다.

## 저장, 감사, 운영

- `TransactionalStorage`가 요청을 직렬화하고 inspection, operation ACK, 감사 이벤트를 하나의 상태 변경으로 commit한다.
- 파일 구현은 같은 디렉터리의 임시 파일을 `fsync`한 뒤 atomic rename한다. 테스트는 `createMemoryStorage()`를 주입한다.
- 감사 이벤트의 `actor`, `serverTimestamp`, `revision`은 서버만 생성한다. client payload의 감사·작성자·승인자 필드는 거부한다. 거부된 mutation도 security audit와 해당 inspection 감사에 기록한다.
- `/metrics`는 normalized route별 request 수/지연과 ACK 상태별 operation 수를 노출한다. 인터넷에 직접 공개하지 말고 배포 환경에서 모니터링 네트워크나 proxy ACL로 제한한다.
- 백업은 프로세스를 정상 종료한 뒤 `FIELDNOTE_DATA_FILE`을 복사한다. 복구는 서비스 중지 → 현재 파일 보존 → 검증된 백업을 같은 경로에 배치 → 시작 → `/healthz` 및 핵심 GET smoke 순서다.
- rollback은 이전 immutable server artifact와 호환되는 storage version인지 확인한 뒤 artifact만 되돌린다. 현재 storage version은 `1`이며 알 수 없는 version은 시작을 거부한다.

## 현재 제약

이 구현은 단일 프로세스 companion backend다. 여러 인스턴스 사이의 파일 잠금, 외부 IdP/JWT, 토큰 만료·폐기, 관리형 데이터베이스, 암호학적 감사 체인, 사진 binary 업로드는 포함하지 않는다. 사진은 checksum/upload id를 포함한 메타데이터만 저장한다. 다중 인스턴스 production 전에는 storage adapter를 트랜잭션 DB로 교체하고 인증 공급자·키 회전·백업 복구 훈련을 추가해야 한다.
