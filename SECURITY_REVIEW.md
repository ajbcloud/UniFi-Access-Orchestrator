# Security Review Notes (UniFi Access Orchestrator)

This review is scoped to the code in this repository (`src/`, `public/`, `config/`).

## Scope clarification

No user-plan upgrade or entitlement-management code paths were found in this repository. If that logic exists in a separate service/repo, it should be reviewed there separately.

## High-priority findings

1. **Administrative API exposure if `admin_api_key` is not configured**
   - Risk: Sensitive endpoints (`/api/config`, `/test/unlock/:door`, `/reload`, etc.) can be used by anyone who can reach the service.
   - Recommendation:
     - Always set `server.admin_api_key` in production.
     - Run behind a reverse proxy with network ACLs/IP allowlists.
     - Consider mTLS or SSO in front of this service.

2. **Webhook authenticity depends on optional secret**
   - Risk: If `event_source.api_webhook.secret` is unset, `/webhook` accepts unsigned payloads.
   - Recommendation:
     - Require `event_source.api_webhook.secret` in production.
     - Add anti-replay controls (timestamp + nonce/event-id cache) in addition to HMAC.

3. **Potential denial-of-service via expensive discovery endpoint**
   - Risk: `/api/discover` can trigger broad subnet scans and many outbound socket attempts.
   - Recommendation:
     - Protect endpoint with strong auth and rate limiting.
     - Add a server-side cooldown and maximum scan scope.

## Medium-priority findings

4. **TLS verification disabled for internal controller checks**
   - Risk: Several HTTPS probes use `rejectUnauthorized: false`, which permits MITM in hostile networks.
   - Recommendation:
     - Add a secure mode that enforces certificate validation and pinning.
     - Keep insecure mode explicit and clearly documented as local-network-only.

5. **Config write surface is broad**
   - Risk: `PUT /api/config` can update many runtime-critical values; misuse can disable protections or redirect traffic.
   - Recommendation:
     - Add strict schema validation and per-field constraints.
     - Audit-log every config change with actor identity and source IP.

6. **Event/log data may include sensitive metadata**
   - Risk: Webhook payload excerpts and event history can expose user/location metadata.
   - Recommendation:
     - Redact IDs/names where possible.
     - Add configurable log privacy levels and retention controls.

## Suggested validation checklist

- Confirm production has non-empty:
  - `server.admin_api_key`
  - `event_source.api_webhook.secret`
- Verify reverse proxy enforces:
  - HTTPS only
  - IP restrictions for admin endpoints
  - request rate limiting
- Run adversarial tests:
  - unsigned webhook rejected
  - invalid signature rejected
  - stale/replayed signed payload rejected (after replay protection is added)
  - unauthorized admin API calls rejected
