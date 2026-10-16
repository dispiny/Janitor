# Janitor docs

| 문서 | 내용 |
| --- | --- |
| [집 에이전트 개요](./home-agent.md) | 역할, 구조, 환경 변수, 로컬 실행 |
| [집 에이전트 API](./home-agent-api.md) | HTTP 계약, 요청/응답, 오류 코드 |
| [Tunnel 연동](./home-agent-tunnel.md) | (선택) 에이전트 로컬 API를 터널로 노출하기 — Worker는 호출하지 않고 에이전트가 poll |
| [속도 측정](./home-agent-speedtest.md) | Fast.com 스타일 병렬 CDN · 단위 Mbps |
| [보안 수정 명세](./security-remediation.md) | 스캔 결과·심각도·수정 수용 기준 |

기계가 읽는 계약 JSON은 [`../agent/contract.json`](../agent/contract.json)에 있습니다.
코드와 짧은 실행 안내는 [`../agent/README.md`](../agent/README.md)를 보세요.
