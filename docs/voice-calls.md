# Horizon voice calls

## Enable voice

Deploy the matching backend modules (voice-calls.mjs, voice-ice.mjs, and
messenger.mjs) and frontend assets from site/horizon-chat. Include the same
frontend assets and Tauri security configuration in the desktop build. Update
the Caddy configuration for the browser's microphone policy.

Set HORIZON_VOICE=1 under services.horizon-chat.environment in the Docker Compose
deployment override, then recreate only the horizon-chat service. No database
migration is required. To roll back, unset HORIZON_VOICE and recreate that
service. Restarting the backend ends current calls.

Horizon uses its existing authenticated Server-Sent Events stream to notify
clients of room or signaling updates. The existing HTTP API carries offers,
answers, ICE candidates and a 12-second membership heartbeat. The server checks
account membership, sessions and channel access on those requests. Run a single
backend instance for voice because signaling state is in memory.

## ICE configuration

| Environment variable | Meaning |
| --- | --- |
| HORIZON_VOICE_STUN_URLS | Comma-separated STUN URLs. Defaults to stun:stun.cloudflare.com:3478. An empty value disables STUN. |
| HORIZON_VOICE_TURN_URLS | Optional comma-separated TURN URLs. Omit for direct-only calls. |
| HORIZON_VOICE_TURN_AUTH | rest (coturn shared-secret authentication, the default and currently supported mode). |
| HORIZON_VOICE_TURN_SECRET | Shared secret from the external relay. Store as a deployment secret. |
| HORIZON_VOICE_TURN_TTL | Credential lifetime in seconds. Defaults to 3600, range 300–86400. |
| HORIZON_VOICE_OPUS_KBPS | Sender bitrate ceiling where supported. Defaults to 12 Kbps per outgoing peer stream, range 12–64. |

Horizon issues coturn REST credentials only after an authorized join. Credentials
use a timestamped username and Base64 HMAC-SHA1 password. Clients refresh these
credentials near expiration. Normal clients use ICE policy "all", allowing
direct candidates and external relay fallback. There is no Horizon media relay.
Direct connections may disclose IP addresses to participants. A full voice
channel has six people and each sends five encrypted streams, each with its own
protocol overhead.

## External coturn on Ubuntu

Install coturn on a separate VPS with a public IP and a DNS-only hostname,
such as turn.example.net. Use matching settings in /etc/turnserver.conf:

```ini
realm=turn.example.net
listening-port=3478
tls-listening-port=5349
min-port=49160
max-port=49200
use-auth-secret
static-auth-secret=REPLACE_WITH_A_RANDOM_SECRET
fingerprint
no-cli
no-multicast-peers
cert=/path/to/fullchain.pem
pkey=/path/to/privkey.pem
```

Use a valid TLS certificate readable by the coturn service. If the VPS uses NAT,
configure external-ip with the public/private mapping and forward the configured
ports. Open UDP and TCP 3478 for TURN, TCP 5349 for TLS, and UDP 49160–49200 for
media relay endpoints. Block relay access to private, loopback, link-local and
metadata networks, and use coturn allocation and rate limits appropriate to the
VPS. Restart and enable coturn through systemd. Do not point TURN at Horizon's
Cloudflare Tunnel. Configure Horizon with the same secret and URLs such as:

```text
turn:turn.example.net:3478?transport=udp,turn:turn.example.net:3478?transport=tcp,turns:turn.example.net:5349?transport=tcp
```

## Verify and troubleshoot

- Open Connection details during a call. Direct means the selected pair contains
  no relay candidate. Relay means at least one endpoint uses an external TURN
  allocation. The details show each peer's state, RTT, receive loss, jitter, and
  estimated outgoing RTP payload bitrate.
- Run node desktop/tests/voice-mesh.mjs on Windows with Edge and the existing
  Playwright test dependencies. Pass the executable path of a qa-fixture build
  to include WebView2. The test checks selected candidate types and inbound audio.
- To test relay-only, set HORIZON_TEST_RELAY_ONLY=1, point HORIZON_VOICE_TURN_URLS
  and HORIZON_VOICE_TURN_SECRET at an isolated coturn instance, and run that same
  test. The setting affects only the test harness. Run once each with UDP, TCP,
  and TLS URLs if you intend to offer all three. Check coturn allocation and NIC
  byte counters during a relayed call. During a direct call, allocation traffic
  may occur during ICE gathering, while sustained voice traffic should appear only
  on client interfaces. Horizon should show only API and event-stream traffic
  for voice. Verify separately with clients on different networks.
- In the browser, use HTTPS and grant microphone access to Horizon. On Windows,
  check microphone privacy under Settings, including permission for desktop
  applications. Horizon denies camera access and leaves the normal WebView2
  microphone permission prompt in place for its bundled origin. Change a
  microphone in Media settings and rejoin. Speaker selection is available when
  the client supports it.
- If all direct paths fail and TURN is disabled or unreachable, Horizon retries
  the affected link and then shows a direct-connection failure. Check relay DNS,
  certificate, transport ports, UDP relay range, shared secret, and synchronized
  clocks before retrying.
