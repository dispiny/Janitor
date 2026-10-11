# 집 에이전트 ↔ Cloudflare Tunnel

대시보드/Cloud Worker는 집 LAN에 직접 붙지 않습니다.  
항상 켜진 호스트에서 **에이전트 + cloudflared**를 같이 두고, Worker는 Tunnel hostname으로만 호출합니다.

시안 설정 화면의 이름:

- `AGENT_TOKEN`
- `CF_TUNNEL_HOSTNAME`

## 권장 배치

```text
[ Cloud Worker / 대시보드 ]
            |
            | HTTPS + Bearer AGENT_TOKEN
            v
[ Cloudflare Tunnel hostname = CF_TUNNEL_HOSTNAME ]
            |
            v
[ 항상 켜진 기기 ]
   cloudflared  -->  http://127.0.0.1:3920  (janitor-home-agent)
```

같은 기기가 U+ 공유기·매직 패킷 브로드캐스트에 닿을 수 있어야 합니다.

## 에이전트 쪽

1. `agent/.env`에 `AGENT_TOKEN`, 필요 시 `UPLUS_*` / `HEALTHCHECK_TOKEN` 설정
2. `CF_TUNNEL_HOSTNAME`에 Tunnel이 광고하는 호스트명을 넣으면 `/v1/status`에 표시됩니다
3. `npm start` (또는 systemd/docker로 상시 실행)
4. 로컬에서 `curl http://127.0.0.1:3920/healthz`로 기동 확인

## Tunnel 쪽 (개념)

cloudflared가 에이전트 origin으로 프록시하도록 구성합니다.

예시 ingress (호스트/대시보드에서 실제 값으로 교체):

```yaml
ingress:
  - hostname: agent.example.com
    service: http://127.0.0.1:3920
  - service: http_status:404
```

Worker 환경에는 다음만 둡니다.

| Worker env | 값 |
| --- | --- |
| `CF_TUNNEL_HOSTNAME` | `agent.example.com` (스킴 없이 호스트만, 또는 팀이 정한 규칙) |
| `AGENT_TOKEN` | 에이전트와 **동일한** 토큰 |

호출 URL은 문서/계약 기준 `https://$CF_TUNNEL_HOSTNAME/...` 입니다.

## 보안 체크리스트

- Tunnel hostname을 알아도 `AGENT_TOKEN` 없이는 `/v1/*` 호출 불가
- 토큰·공유기 비밀번호·헬스 토큰을 git / 시안 UI에 넣지 않음
- `/healthz`는 프로브용이므로 민정보 없이 `ok`만 반환
- U+ 비밀번호는 에이전트 프로세스 env에만 존재; wake API body에 포함 금지

## Worker 연동 순서 (권장)

1. `GET /v1/status`로 연결·capability 확인
2. 대시보드 “깨우기” → `POST /v1/wake`
3. 서비스 카드 새로고침 → `POST /v1/checks/http` (URL·expect는 Supabase에서)
4. 네트워크 카드 → `GET /v1/network/public-ip`

계약이 바뀌면 [`agent/contract.json`](../agent/contract.json)과 [API 문서](./home-agent-api.md)를 같이 갱신하세요.
