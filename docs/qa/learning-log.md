## [2026-10-17] QA 학습 기록 - 전체 코드 리뷰 후속 보강 (`fix/review-hardening`)

검토 방식: Worker+UI / 홈 에이전트 / Supabase 스키마를 나눠 1차 리뷰 → HIGH 항목은 코드로 재확인 → 수정 → 독립 리뷰어 2차 검증.
SQL은 로컬 Postgres 15에 마이그레이션 17개를 순서대로 적용하고 member·owner·anon·service_role 시나리오로 확인했다.
보안 항목 상세는 [`../security-remediation.md`](../security-remediation.md)의 SEC-13~SEC-20.

### 1. 주요 발견 (Major Findings)
- [보안]: member가 `servers.pve_host`를 바꿔 owner의 Proxmox 토큰을 임의 호스트로 빼낼 수 있음 - High
- [보안]: member가 `agent_update`로 집 기기에서 git pull·Worker 배포 실행 가능 - High
- [버그]: Slack 전송 실패(429/5xx)를 성공으로 처리해 장애 알림이 복구 때까지 영구 누락 - High
- [버그]: 원격 업데이트가 report 전에 재시작 → job이 5분마다 재큐되어 pull·deploy 무한 반복 - High
- [보안]: `HEALTHCHECK_TOKEN`이 문서와 달리 모든 헬스 URL로 전송 - High
- [보안]: `agent_set_alert_state`가 anon에 열린 채 남음 (SEC-10 누락) - Medium
- [버그]: 속도 측정 실패가 0 Mbps로 저장돼 거짓 "회선 저하" 알림 - Medium
- [버그]: PVE 노드 응답 실패·빈 노드 목록에 해당 게스트/노드 서버(사용자 입력 MAC 포함)가 삭제됨 - Medium
- [버그]: report만 실패하면 12초짜리 속도 측정이 매 tick 반복 (회선 수 GB 소모) - Medium
- [기능 누락]: 에이전트가 죽어도 아무 알림이 없음, 복구 알림 없음 - Medium
- [문서]: Worker가 터널로 에이전트 `/v1/*`를 호출한다는 설명이 실제(에이전트 poll 모델)와 다름 - Low

### 2. 근본 원인 분석 (Root Cause Analysis)
- PVE 토큰 탈취 / member 업데이트: RLS를 테이블 단위 `for all`로만 설계하고 *필드·작업 종류 단위 권한*을 정의하지 않음. owner 모델(SEC-04) 도입 때 houses만 잠그고 servers·agent_jobs는 그대로 둠.
- Slack 누락: dedupe 상태 저장이 "보냈다"가 아니라 "보내려 했다"에 묶여 있었음. 반환값(`res.ok`)을 버려도 타입 오류가 나지 않음.
- 업데이트 반복: 재시작(부수효과)이 report(결과 전달)보다 먼저 예약됨 + DB 쪽 stale job 재큐에 상한이 없어서 두 결함이 곱해짐.
- 헬스 토큰: 문서가 먼저 쓰이고 구현이 따라가지 않음. 문서↔코드 대조 테스트 없음.
- SEC-10 누락: 같은 함수를 여러 마이그레이션에서 `create or replace` + grant를 반복하며 중간 grant가 최종 상태를 덮음. 최종 권한 상태를 검증하는 테스트 없음.
- 측정·동기화 오삭제: "실패"와 "결과 없음(0, [])"을 같은 값으로 표현함.

### 3. 권장 조치 (Recommended Actions)
- 권한: (단기) 트리거·RLS로 PVE 필드/서버 삭제/agent_update owner 전용 — 적용 / (장기) viewer 역할 포함 권한 매트릭스를 문서화하고 pgTAP으로 고정
- Slack: (단기) 전송 성공 시에만 신규 키 저장, timeout+catch — 적용 / (장기) 알림 전송 실패를 별도 지표로 노출
- 원격 업데이트: (단기) report 후 재시작, 롤백, `agent_update` 재시도 금지 — 적용 / (장기) 태그·서명 커밋 고정을 기본값으로 (`AGENT_UPDATE_REQUIRE_SIGNED`는 opt-in으로만 추가)
- 실패 표현: (단기) 측정 실패는 `speed` 미포함·`up_mbps: null`, 노드 실패는 `guestSyncFailedNodes` — 적용 / (장기) report 스키마를 zod로 Worker에서도 검증
- 마이그레이션 검증: (단기) 로컬 Postgres + Supabase 역할 stub으로 시나리오 검증 — 이번에 수동 수행 / (장기) CI에 마이그레이션 적용 + 권한 시나리오 job 추가

### 4. 프로세스 개선 제안 (Process Improvement Suggestions)
- Phase 2 (Coding): 보안 함수(`security definer`)를 바꾸는 마이그레이션은 *최종 grant 상태*를 파일 끝에 다시 명시한다. 중간 grant로 덮이는 일을 막는다.
- Phase 2 (Coding): 문서에 쓴 동작(예: "`useHealthToken: true`일 때만")은 같은 PR에서 테스트로 고정한다.
- Phase 3 (Testing): CI가 호스트명 유출 검사만 하고 테스트·타입체크를 돌리지 않았음 → `ci.yml` 추가. 다음에는 SQL 시나리오 job까지 확장.
- Phase 4 (Deployment): 원격 업데이트는 DB 마이그레이션을 돌리지 않는다. 스키마 변경이 있는 릴리즈는 "마이그레이션 먼저"를 릴리즈 노트 첫 줄에 쓴다 (README에 반영).

### 5. 성공 사례 및 긍정적 발견 (Successes & Positive Discoveries)
- 영역별 병렬 리뷰 → HIGH 항목 코드 재확인: 서브 리뷰의 HIGH 주장 6건이 모두 코드로 재현됨. 재확인 단계가 오탐을 걸러 주는 장치로 유효했음.
- 2차 독립 리뷰가 1차 수정이 만든 *업그레이드 회귀*를 잡음: 헬스 토큰 opt-in이 기존 서비스 401 폭주로 이어지는 문제 → 기존 행 백필로 해결. 배포 순서 의존성도 이 단계에서 발견.
- 로컬 Postgres 검증에서 "service_role로 집을 만들면 `on_house_created` 트리거가 실패"하는 기존 제약을 실제로 재현함 (§6 참조).
- 컨트랙트(마이그레이션)를 먼저 확정하고 Worker·에이전트를 병렬로 맡겨 파일 충돌 없이 진행됨.

### 6. 미보강 항목 (Deferred Improvements)
- viewer(읽기 전용) 역할: MEDIUM - 1차 리뷰 추가 기능 제안 - 권한 매트릭스 문서화와 함께 다음 사이클
- SEC-07 PVE 토큰 암호화 저장(Vault/pgsodium): MEDIUM - 기존 보안 명세 - 다음 보안 사이클
- 속도·업타임 이력 그래프: LOW - 1차 리뷰 추가 기능 제안 - 이번에는 24개 막대 + 업로드 표시까지만. 다음 UI 사이클
- deploy 성공 Slack 중복(report 재전송 시): LOW - 2차 리뷰 #5 - `job:<id>:deploy` dedupe 키로 처리 예정
- report만 계속 실패하면 `agent:offline` 배너가 남음 / cron 오프라인 알림 실패 시 재시도 없음: LOW - 2차 리뷰 #6 - 알림 전송 지표 작업과 함께
- self-update 타임아웃 시 프로세스 종료를 기다리지 않아 `index.lock`으로 롤백이 실패할 수 있음, Windows 프로세스 그룹 kill: LOW - 2차 리뷰 #7 - 우연한 보강 기회에
- 업데이트 중 poll 중단으로 10분 넘으면 오프라인 오탐: LOW - 2차 리뷰 #4 - poll 간격 상한(5분)만 적용, 업데이트 중 heartbeat는 미적용
- `create_house` 동시 호출 시 집 2개 생성 가능 / service_role 집 생성 시 owner 트리거 실패: LOW - 1차 리뷰·로컬 SQL 재현 - 다음 스키마 정리 때 unique 제약 + 트리거 정리
- 집별 Slack 채널: 앱 기반 Incoming Webhook은 `channel` 필드를 무시함: LOW - 1차 리뷰 의심 항목 - 운영 웹훅 종류 확인 후 결정
- url-guard DNS 검사와 fetch 사이 DNS rebinding: LOW - 에이전트 수정 중 발견 - 집 환경이라 우선순위 낮음
- `app.test.ts`가 실제 example.com에 요청 (CI flaky 가능): LOW - 2차 리뷰 #9 - 로컬 서버로 교체
