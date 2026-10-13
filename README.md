# Janitor

집 서버, 회선, Proxmox, 헬스 체크를 한 화면에서 다루는 콘솔입니다.  
머지된 HTML 시안(`mockup/`)을 바탕으로 **실제 Auth·DB·에이전트**로 동작하며, **샘플/더미 데이터는 포함하지 않습니다.**

## 구성

| 구성 | 역할 | 비용 |
| --- | --- | --- |
| Cloudflare Worker (`src/` + `public/`) | UI + API (`/api/*`), `*.workers.dev` | **무료** (하루 10만 요청) |
| Supabase Free | Auth, Postgres, RLS | **무료** (프로젝트 2개 등 플랜 한도) |
| Home agent (`agent/`) | 집 안 항상 켜진 기기 (cloudflared 옆) | 로컬/자택 하드웨어 |

비밀값과 환경 변수(`SUPABASE_ANON_KEY`, `SLACK_WEBHOOK_URL`, `UPLUS_ROUTER_PASSWORD`, Proxmox 토큰 비밀, `AGENT_TOKEN`)는 git에 넣지 않습니다. Worker는 `.dev.vars`(로컬) / `wrangler secret`(배포)로 주입합니다.

## 무료 배포 (권장: Cloudflare Workers)

Workers Free는 계정당 **하루 10만 요청**, Worker 크기·정적 자산까지 취미/개인 콘솔에 충분합니다.  
별도 VPS나 Pages 요금 없이 `workers.dev` URL로 공개할 수 있습니다.

### 1) 본인 Cloudflare 계정에 올리기

```bash
npm install
npx wrangler login          # 브라우저에서 무료 Cloudflare 계정 연결
# Dashboard Variables 또는:
npx wrangler secret put SUPABASE_ANON_KEY
# SUPABASE_URL 은 Dashboard → Settings → Variables 에 설정
npm run deploy              # → https://ops.<your-subdomain>.workers.dev
npx wrangler secret put SLACK_WEBHOOK_URL   # 선택
```

### 커스텀 도메인 (선택)

본인 Cloudflare 존에 붙이려면 대시보드에서:

**Workers & Pages → ops → Settings → Domains & Routes → Add → Custom Domain**

DNS를 손으로 `*.workers.dev` CNAME만 걸면 SSL/라우팅이 어긋날 수 있어, Custom Domain으로 붙이는 편이 안전합니다.  
개인 호스트명은 `wrangler.jsonc`에 커밋하지 마세요.

### 2) Supabase Auth URL 맞추기

Supabase 대시보드 → **Authentication → URL Configuration**

- Site URL: `https://ops.<your-subdomain>.workers.dev` (또는 연결한 커스텀 도메인)
- Redirect URLs: 위 URL(들) 추가

**Authentication → Providers → Email → Confirm email** 을 끄면 가입 직후 바로 로그인됩니다.

이 저장소에 연결된 Supabase 프로젝트: `ypklxfwpbyroxdolgiun` (ap-northeast-2, Free).

### 3) 홈 에이전트

```bash
cd agent
cp .env.example .env
# JANITOR_API_URL / AGENT_TOKEN 은 agent/.env 에만 넣기 (.env.example 은 localhost 예시)
npm install && npm start
```

에이전트는 집 안에서만 돌리면 되고, 클라우드 요금은 없습니다.

### 초대만 가입 (공개 가입 차단)

DB에 `hook_invite_only_signup` 이 있습니다. **한 번만** 대시보드에서 훅을 켜 주세요.

1. [Authentication → Hooks](https://supabase.com/dashboard/project/ypklxfwpbyroxdolgiun/auth/hooks)
2. **Before User Created** → Postgres → `public.hook_invite_only_signup` → Save

이후에는 설정에서 초대한 이메일만 가입됩니다. (계정이 하나도 없을 때만 첫 집 주인 가입 허용)

### 무료 티어에서 알아둘 점

| 항목 | Free 한도 / 메모 |
| --- | --- |
| Worker 요청 | 100,000/일 (초과 시 1027) |
| CPU/요청 | 10ms — UI·짧은 API에는 여유 |
| Slack 웹훅 | Worker 시크릿만 넣으면 됨 (선택) |
| Supabase | Free 프로젝트로 Auth+DB 유지 |
| 커스텀 도메인 | 없어도 `workers.dev`로 충분 |

유료가 필요해지는 경우는 요청량이 하루 10만을 넘거나, Worker CPU가 긴 Proxmox 프록시를 Worker 안에서 돌릴 때뿐입니다. 지금 구조는 **무거운 작업은 집 에이전트**, Worker는 얇은 API라 Free에 맞습니다.

## 로컬 실행

```bash
npm install
cp .dev.vars.example .dev.vars   # SUPABASE_URL, SUPABASE_ANON_KEY 필수
npm run dev
```

브라우저에서 Worker 로컬 URL을 연 뒤 로그인합니다. 공개 가입은 막혀 있고, 초대받은 이메일만 **초대 가입**할 수 있습니다.

## API 요약

- `GET /api/config` — Supabase URL/anon key + `inviteOnly` / `inviteHookReady` (`signup_status` RPC)
- `POST /api/bootstrap` — 집 생성 (가입 직후)
- `POST /api/servers` / `DELETE /api/servers/:id`
- `POST /api/services` / `DELETE /api/services/:id`
- `POST /api/jobs` — 인증된 작업 큐 enqueue (에이전트는 poll로 소비; 무인증 push 없음)
- `POST /api/agent/token` — 에이전트 토큰 발급 (해시만 DB 저장)
- `GET /api/agent/poll` / `POST /api/agent/report` — 에이전트 Bearer 전용

## 시안

정적 시안은 `mockup/index.html`에 그대로 둡니다. 앱 UI는 `public/` 입니다.
