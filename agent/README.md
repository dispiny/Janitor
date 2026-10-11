# Janitor home agent

항상 켜진 기기(cloudflared와 같은 호스트)에서 돌리는 집 에이전트입니다.  
Cloud Worker / 대시보드는 Cloudflare Tunnel hostname으로 이 API를 호출합니다.

## 역할

| 기능 | 엔드포인트 |
| --- | --- |
| 상태 | `GET /v1/status` |
| 공인 IP | `GET /v1/network/public-ip` |
| WOL (수동 MAC) | `POST /v1/wake` `{ "mode":"manual", "mac", "broadcast?", "port?" }` |
| WOL (U+ 공유기) | `POST /v1/wake` `{ "mode":"uplus", "device" }` → 현재 `501` 자리 |
| HTTP 헬스 | `POST /v1/checks/http` `{ "url", "expectStatus?", "useHealthToken?" }` |
| 프로세스 프로브 | `GET /healthz` (인증 없음) |

모든 `/v1/*` 요청은 `Authorization: Bearer $AGENT_TOKEN` 이 필요합니다.

## 로컬 실행

```bash
cd agent
cp .env.example .env   # AGENT_TOKEN 설정
npm install
npm run typecheck
npm test
AGENT_TOKEN=dev-token npm start
```

기본 포트는 `3920`입니다. Tunnel은 `CF_TUNNEL_HOSTNAME`만 광고하고, 비밀값은 git에 넣지 않습니다.

## Cloud Worker 연동 메모

- Worker는 `https://$CF_TUNNEL_HOSTNAME` + `AGENT_TOKEN`으로만 호출합니다.
- 더미 서버/서비스 데이터는 에이전트가 갖지 않습니다. 목록은 Supabase 쪽입니다.
- U+ WOL은 공유기 세션 연동이 필요합니다. 자리만 두고 `501 uplus_not_implemented`를 반환합니다.
