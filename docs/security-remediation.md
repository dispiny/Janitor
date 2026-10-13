# 보안 스캔 결과 및 수정 명세

스캔 일자: 2026-10-13  
대상: `main` 전체 (`src/`, `public/`, `agent/`, `supabase/migrations/`) + 원격 Supabase 프로젝트 `ypklxfwpbyroxdolgiun`  
범위: 코드 리뷰, RLS/RPC 정책 점검, Supabase Database Linter (security advisors)  
이 PR: **수정 구현이 아니라 명세**. 구현은 이슈별 후속 PR로 진행한다.

---

## 요약

| 심각도 | 건수 | 핵심 |
| --- | ---: | --- |
| Critical | 1 | `house_members` INSERT로 임의 집 자가 합류 가능 |
| High | 3 | 멤버 전원 집 삭제·토큰 재발급, `houses` INSERT 우회, owner 권한 미구분 |
| Medium | 4 | 홈 에이전트 SSRF, manage URL 스킴, PVE 비밀 평문, Auth Hook 의존 |
| Low / Ops | 4 | 보안 헤더, HIBP 비활성, anon RPC 노출, agent_report 무결성 |

**즉시 조치 권장:** SEC-01 ~ SEC-03 (RLS). 초대만으로 가입해도, 계정만 있으면 UUID를 알면 타 집에 붙을 수 있다.

---

## Critical / High

### SEC-01 — `house_members` 자가 INSERT (Critical)

**위치:** `supabase/migrations/20261011181000_agent_rpcs_and_invites.sql` (원격에도 동일)

```sql
-- 현재 (취약)
create policy members_insert on public.house_members for insert to authenticated
  with check (user_id = auth.uid() or public.is_house_member(house_id));
```

**문제:** 인증된 사용자가 `user_id = auth.uid()` 조건만으로 **초대 없이** 임의 `house_id`에 자신을 INSERT할 수 있다. `role`도 `'owner'`로 넣을 수 있다.  
UI는 `claim_house_invites`만 쓰지만, 클라이언트는 anon key로 PostgREST에 직접 접근한다 (`public/app.js` → Supabase JS).

**재현 (개념):**

1. 피해자 집 `house_id` UUID를 입수(로그, 공유, 초대 메일 맥락 등).
2. 공격자 계정으로:

```http
POST /rest/v1/house_members
Authorization: Bearer <attacker_access_token>
apikey: <anon_key>
Content-Type: application/json

{ "house_id": "<victim-house-uuid>", "user_id": "<attacker-uid>", "email": "attacker@example.com", "role": "owner" }
```

3. 이후 해당 집 servers/secrets(에이전트 경로)/jobs에 접근 가능.

**수정 명세:**

1. `members_insert` 정책 삭제 또는 `with check (false)`.
2. 멤버 추가는 **오직** `claim_house_invites()` (및 필요 시 owner 전용 `add_house_member` SECURITY DEFINER)로만 허용.
3. `claim_house_invites`는 `role = 'member'` 고정 유지(현재와 동일).
4. owner가 임의 유저를 넣는 RPC가 필요하면 `is_house_owner(house_id)` 검사 + `role` 화이트리스트(`member`만).
5. 회귀 테스트: 초대 없는 INSERT → 실패; 초대 후 claim → 성공; 멤버가 타인을 INSERT → 실패.

**수용 기준:** PostgREST로 직접 `house_members` INSERT가 어떤 경우에도 성공하지 않는다(service_role 제외).

---

### SEC-02 — 멤버가 집 삭제·에이전트 탈취 가능 (High)

**위치:** 동일 마이그레이션 RLS

```sql
create policy houses_delete ... using (public.is_house_member(id));
create policy houses_update ... using (public.is_house_member(id)) with check (...);
```

**문제:** `role`을 검사하지 않아 **아무 멤버**나:

- 집 전체 DELETE (cascade로 servers/services/jobs/secrets 삭제)
- `agent_token_hash` UPDATE → 에이전트 토큰 사실상 교체/무력화
- `slack_channel`, `speed_threshold_mbps` 등 설정 변조

Worker `/api/agent/token`, `/api/invite`도 `requireUser`만 하고 **owner 여부 미확인**.

**수정 명세:**

1. 헬퍼 추가:

```sql
create or replace function public.is_house_owner(target_house uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.house_members m
    where m.house_id = target_house
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;
```

2. RLS:
   - `houses_delete` → `is_house_owner(id)`
   - `houses_update` → owner만, 또는 컬럼 단위로 분리(이름만 멤버 허용 시 컬럼 제한 RPC 권장)
   - `agent_token_hash` 변경은 UI/Worker의 mint RPC만 허용하고 일반 UPDATE에서는 제외(컬럼 권한 또는 트리거로 차단)
3. API:
   - `POST /api/agent/token`, `POST /api/invite`, 멤버 제거 → owner 필수
   - `DELETE /api/servers/:id`, `DELETE /api/services/:id` → 최소 멤버, 파괴적 작업은 owner 권장
4. `members_delete` → owner만 다른 멤버 제거; 자기 탈퇴는 별도 정책.

**수용 기준:** `role = 'member'` 세션으로 집 DELETE, agent token mint, invite INSERT가 거부된다.

---

### SEC-03 — `houses` INSERT `with check (true)` (High)

**위치:** `houses_insert` 정책

**문제:** `create_house` RPC는 유저당 멤버십 1개를 강제하지만, 직접 `houses` INSERT는 통과하고 트리거 `handle_new_house_owner`가 owner 멤버십을 만든다 → **집 무제한 생성** 및 RPC 우회.

**수정 명세:**

1. `houses_insert` → `with check (false)` (또는 정책 제거 후 INSERT revoke).
2. 집 생성은 `create_house`만 허용.
3. (선택) 유저당 `house_members` 최대 1행 CHECK/유니크 partial index:

```sql
create unique index house_members_one_house_per_user
  on public.house_members (user_id);
```

(다중 집 지원 계획이 있으면 이 항목은 보류하고 RPC만 강화.)

**수용 기준:** authenticated 역할의 직접 `insert into houses` 실패; `rpc/create_house`만 성공.

---

### SEC-04 — owner/member 권한 모델 부재 (High, SEC-02와 연계)

**위치:** 스키마에 `role` 컬럼은 있으나 RLS/API에서 미사용.

**수정 명세:**

| 동작 | owner | member |
| --- | :---: | :---: |
| 대시보드 조회 | ✓ | ✓ |
| 서버/서비스 추가 | ✓ | ✓ 또는 ✗ (제품 결정) |
| 초대, 토큰 발급, 집 삭제, 멤버 추방 | ✓ | ✗ |
| 설정(속도·슬랙) | ✓ | ✗ |

문서(`README.md`)와 UI에 역할 표시를 맞춘다.

---

## Medium

### SEC-05 — 홈 에이전트 SSRF / 내부망 스캔 (Medium)

**위치:**

- `src/api.ts` — `healthUrl`이 `^https?:\/\/`만 검사
- `agent/src/health-check.ts` — 임의 URL `fetch`
- `agent/src/app.ts` — `POST /v1/checks/http`
- `agent/src/poller.ts` — `pve_host`로 홈 LAN fetch

**문제:** 집 멤버(또는 SEC-01로 침입한 계정)가 `health_url` / 체크 API로 **공유기·NAS·클라우드 메타데이터** 등 에이전트 네트워크 자원을 호출하게 할 수 있다.

**수정 명세:**

1. URL 허용 목록 정책 문서화(예: https만, 사설 IP/링크로컬/메타데이터 IP 차단 또는 명시적 allowlist).
2. Worker 저장 시와 에이전트 실행 시 **이중 검증** (`isPublicHttpsUrl` / `isAllowedLanTarget`).
3. `POST /v1/checks/http`에 동일한 가드.
4. redirect: `manual` 유지 + Location이 차단 대상이면 실패 처리.
5. 테스트: `http://127.0.0.1`, `169.254.169.254`, `http://192.168.0.1` 등 정책에 따라 거부/허용.

**수용 기준:** 정책에 없는 대상은 에이전트가 요청하지 않는다.

---

### SEC-06 — `manageUrl` / 리다이렉트 스킴 미검증 (Medium)

**위치:** `public/app.js` `openManage`, `src/api.ts` 서버/서비스 insert

**문제:** `manage_url` / `pve_host`에 `javascript:` 등 위험 스킴이 들어가면 `#open-redir` `href`로 이어질 수 있다.

**수정 명세:**

1. 저장·표시 모두 `https:` (필요 시 `http:` LAN)만 허용.
2. `openManage`에서 스킴 재검증 후 거부.
3. 외부 링크에 `rel="noopener noreferrer"` (모달 링크).

---

### SEC-07 — PVE 토큰 비밀 평문 저장 (Medium)

**위치:** `server_secrets.pve_token_secret`, `agent_poll`이 plaintext로 반환

**문제:** DB 유출·백업·과도한 권한 시 Proxmox 토큰 노출. 에이전트 전달은 불가피하나 **저장 암호화**는 가능.

**수정 명세 (단계적):**

1. Short-term: `server_secrets` 접근 감사, 백업 권한 최소화, 토큰을 PVE에서 read-only로 발급.
2. Mid-term: pgsodium/`vault` 또는 Worker가 보유한 래핑 키로 encrypt-at-rest; `agent_poll`에서만 decrypt.
3. `agent_poll`을 PostgREST anon 직접 호출이 아니라 **Worker + service_role** 경유로 좁히기(SEC-10).

---

### SEC-08 — 초대 전용 가입이 Auth Hook 대시보드 설정에 의존 (Medium)

**위치:** `hook_invite_only_signup`, README, `signup_status.hookReady`

**문제:** SQL 함수만으로는 가입이 막히지 않는다. Dashboard **Before User Created** 미연결 시 공개 가입 가능. UI는 경고만 한다.

**수정 명세:**

1. 배포 체크리스트/CI 또는 `signup_status`로 hookReady=false면 운영 알림.
2. (가능 시) 앱 부트스트랩 후 `inviteHookReady === false`이면 회원가입 UI 비활성 + 관리자 배너.
3. Supabase Auth **Leaked password protection** 활성화 ([문서](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)) — Linter WARN.

---

## Low / 운영

### SEC-09 — Worker 보안 헤더 부재 (Low)

**위치:** `src/index.ts`

**수정 명세:** API·HTML 응답에 최소:

- `Content-Security-Policy` (esm.sh / Supabase 도메인 allow)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Frame-Ancestors: 'none'` 또는 CSP `frame-ancestors`

---

### SEC-10 — anon이 `agent_poll` / `agent_report` SECURITY DEFINER 실행 가능 (Low~Medium, Linter)

**위치:** grants + Supabase advisor `anon_security_definer_function_executable`

**현재:** 토큰 해시 검증으로 설계상 의도적. 다만 Supabase REST로 Worker를 우회해 호출 가능 → 레이트리밋·감사 어려움, secrets 직접 노출 경로 증가.

**수정 명세 (권장 hardening):**

1. `revoke execute on function agent_poll/agent_report from anon, authenticated`.
2. Worker에 `SUPABASE_SERVICE_ROLE_KEY` 시크릿 추가 후 서버에서만 RPC 호출; 에이전트는 계속 Worker `/api/agent/*`만 사용.
3. `signup_status`는 읽기 전용이라 anon 유지 가능(또는 결과 캐시 후 Worker만 노출).

---

### SEC-11 — `agent_report` 게스트 `server_id` 집 소속 미검증 (Low)

**위치:** `agent_report` 게스트 upsert 루프

**문제:** `house_id`는 토큰 집으로 넣지만 `server_id`가 다른 집 서버여도 FK만 만족하면 삽입될 수 있어 데이터 무결성 훼손.

**수정 명세:** upsert 전 `servers.id = server_id AND servers.house_id = h.id` 확인; 아니면 skip/exception.

---

### SEC-12 — Supabase Auth leaked password protection 비활성 (Low, Ops)

Dashboard에서 HaveIBeenPwned 연동 활성화. 코드 변경 없음.

---

## 이미 양호한 점 (참고)

- `server_secrets` RLS deny-all + service_role만 테이블 권한
- 에이전트 토큰은 SHA-256 해시만 DB 저장, 평문은 1회 표시
- 무인증 job push 없음 (`/api/jobs`는 사용자 Bearer)
- 홈 에이전트 `/v1/*` Bearer + timing-safe 비교
- UI 대부분 `textContent`로 사용자 문자열 반영 (innerHTML 템플릿은 고정 마크업)

---

## 구현 순서 (후속 PR)

| 순서 | ID | 후속 PR 제안 |
| ---: | --- | --- |
| 1 | SEC-01, SEC-03 | `supabase/migrations/..._lock_down_member_rls.sql` + 정책 테스트 |
| 2 | SEC-02, SEC-04 | `is_house_owner` + API owner 가드 |
| 3 | SEC-05, SEC-06 | URL 가드 (Worker + agent) |
| 4 | SEC-11, SEC-10 | `agent_report` 무결성 + (선택) service_role 전용 poll |
| 5 | SEC-07, SEC-08, SEC-09, SEC-12 | 암호문/훅/헤더/Auth 설정 |

---

## 검증 체크리스트 (구현 PR용)

- [ ] 초대 없이 `house_members` INSERT 실패
- [ ] member로 `houses` DELETE / agent token / invite 실패
- [ ] owner로 동일 동작 성공
- [ ] 직접 `houses` INSERT 실패, `create_house` 성공
- [ ] 차단 URL health check 실패
- [ ] `manageUrl=javascript:...` 저장·오픈 거부
- [ ] `npm test` / agent 테스트 / 타입체크 통과
- [ ] 원격에 마이그레이션 적용 후 Supabase advisors 재확인

---

## 부록: SEC-01~03 초안 SQL (미적용)

구현 PR에서 타임스탬프를 붙여 `supabase/migrations/`에 넣고 원격 적용한다. **이 명세 PR에서는 적용하지 않는다.**

```sql
-- DRAFT ONLY — do not apply from this docs PR

create or replace function public.is_house_owner(target_house uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.house_members m
    where m.house_id = target_house
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;

revoke all on function public.is_house_owner(uuid) from public, anon;
grant execute on function public.is_house_owner(uuid) to authenticated;

drop policy if exists members_insert on public.house_members;
-- no direct insert policy: membership only via claim_house_invites / owner RPC

drop policy if exists houses_insert on public.houses;
-- create via create_house() only

drop policy if exists houses_delete on public.houses;
create policy houses_delete on public.houses for delete to authenticated
  using (public.is_house_owner(id));

drop policy if exists houses_update on public.houses;
create policy houses_update on public.houses for update to authenticated
  using (public.is_house_owner(id))
  with check (public.is_house_owner(id));

drop policy if exists members_delete on public.house_members;
create policy members_delete on public.house_members for delete to authenticated
  using (
    public.is_house_owner(house_id) and user_id <> auth.uid()
  );

drop policy if exists invites_insert on public.house_invites;
create policy invites_insert on public.house_invites for insert to authenticated
  with check (public.is_house_owner(house_id));
```
