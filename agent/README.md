# Janitor home agent

항상 켜진 기기(cloudflared와 같은 호스트)에서 돌리는 집 에이전트입니다.

문서:

- [개요 · 환경 변수 · 로컬 실행](../docs/home-agent.md)
- [HTTP API](../docs/home-agent-api.md)
- [Cloudflare Tunnel 연동](../docs/home-agent-tunnel.md)
- [docs 인덱스](../docs/README.md)

기계용 계약: [`contract.json`](./contract.json)

## 빠른 실행

```bash
cd agent
cp .env.example .env   # AGENT_TOKEN 설정
npm install
npm test
npm start
```

기본 포트 `3920`. `/v1/*`는 `Authorization: Bearer $AGENT_TOKEN` 필요.
