# Killer Game — Distributed Backend Architecture

A real-time multiplayer hidden-role game server, originally built as a single-instance
Node.js/Socket.IO application, migrated to a horizontally-scalable, Redis-backed
distributed architecture running across multiple EC2 instances.

**Live:** game.kill-your-friend.workers.dev

---

## Architecture Overview

```
                                Internet
                                   │
                                   │ HTTPS (443) / HTTP (80)
                                   ▼
                    ┌──────────────────────────────┐
                    │   EC2: Caddy + Redis          │
                    │   (reverse proxy + state)     │
                    │                                │
                    │   ┌────────┐    ┌───────────┐ │
                    │   │ Caddy  │    │   Redis    │ │
                    │   │ :80    │    │   :6379    │ │
                    │   │ :443   │    │            │ │
                    │   └───┬────┘    └─────┬──────┘ │
                    └───────┼───────────────┼─────────┘
                            │               │
              ┌─────────────┴───┐       ┌───┴──────────────┐
              │ reverse_proxy   │       │ shared state,     │
              │ (round-robin)   │       │ pub/sub, sweeps    │
              ▼                 ▼       │                    │
    ┌──────────────────┐ ┌──────────────┴───┐               │
    │  EC2: Backend 1   │ │  EC2: Backend 2   │◄──────────────┘
    │  Node.js/Socket.IO│ │  Node.js/Socket.IO│
    │  :3001            │ │  :3001            │
    └────────────────────┘ └────────────────────┘
```

Three EC2 instances, three distinct roles:

| Instance | Runs | Publicly reachable? |
|---|---|---|
| Caddy + Redis | Reverse proxy (TLS termination), Redis (shared state) | Only Caddy (80/443) |
| Backend 1 (`kgb1`) | Node.js game server | No — only from Caddy's Security Group |
| Backend 2 (`kgb2`) | Node.js game server | No — only from Caddy's Security Group |

---

## Why This Migration Was Necessary

The original single-instance design held all game state — rooms, players, live
positions, timers — in local process memory (`Map`/`Set` objects). This made
horizontal scaling impossible: a second backend instance would have no visibility
into rooms created on the first, and any player randomly load-balanced to the
"wrong" instance would simply not exist there.

Every piece of that in-memory state was externalized to Redis, and every mechanism
that depended on the process staying alive (`setTimeout`/`setInterval` for game
timers) was redesigned around a **sweep-and-claim pattern** that works correctly
regardless of which instance — or how many — are running.

---

## Core Design Decisions

### 1. State lives in Redis, not process memory

Room and game state (players, ready-status, scores, positions, killer identity) are
stored as Redis **Hashes** (one per room/player) and **Sets** (room membership,
rematch votes), not as JS `Map`/`Set` objects. Any backend instance can read or
write any room's state — no instance owns a room's data.

### 2. Cross-instance broadcasting via the Socket.IO Redis Adapter

A WebSocket connection is pinned to whichever process accepted it — `io.to(roomId)`
only reaches sockets connected to *that specific instance* by default. The
[`@socket.io/redis-adapter`](https://github.com/socketio/socket.io-redis-adapter)
uses Redis pub/sub so that a broadcast issued from any instance is relayed to every
instance's locally-connected sockets in that room, making `io.to()`/`socket.to()`
transparently cross-instance with no per-call code changes required.

### 3. Timers can't survive across instances — replaced with sweep + atomic claim

`setTimeout`/`setInterval` are process-local handles; they vanish if that process
dies. Every timer-driven mechanic (killer rotation, player respawn, rematch-window
resolution) uses the same pattern instead:

- The due time is stored as an **absolute timestamp** in a Redis Sorted Set
  (score = due time, member = room/player ID).
- **Every** instance independently polls that Sorted Set on a short interval
  (250ms), asking "what's due right now?"
- Whichever instance's poll notices first **atomically claims** the specific due
  item via a small Lua script (`SET key val PX ttl` guarded by `EXISTS`) — Redis
  executes this as a single atomic step, so concurrent claims from multiple
  instances can never both succeed.
- The winner executes the event and re-schedules the next occurrence (for
  recurring timers like rotation).

**Why not a single "owner" instance with a heartbeat/lock instead?** That design
was considered and rejected: it trades correctness for a real UX cost — losing the
owning instance means waiting out a lock TTL (many seconds) before another instance
notices and takes over, which is disruptive for a game with a 20-second rotation
cycle. The sweep-based design has **no owner to fail over from** — every instance
is already polling independently, so failover latency is bounded by the poll
interval (~250ms) rather than a lock timeout, regardless of which instance dies.

### 4. Network isolation: Security Groups, not private subnets

Given the added cost of a NAT Gateway (no free tier, ~$32/month baseline) for a
personal project, all three instances sit in the default public subnet. Isolation
is enforced entirely through **Security Group references**: each backend's
Security Group only accepts inbound traffic from Caddy's Security Group; Redis's
Security Group only accepts inbound traffic from the backends' Security Group.
Docker's `ports:` (host-published) vs `expose:` (container-network-only) is used
consistently with this: any port that needs to be reached from a *different EC2
instance* is published via `ports:`, with the Security Group — not Docker — being
the actual enforcement of who's allowed to connect.

### 5. No SSH — access via AWS Systems Manager Session Manager

All three instances have port 22 closed entirely. Administrative access goes
through SSM Session Manager: the instance's SSM Agent maintains an outbound-only
connection to AWS, and access is granted via IAM policy rather than a distributed
SSH key or an open inbound port. Every session is logged and attributable to the
IAM identity that started it.

---

## CI/CD Pipeline

GitHub Actions (`.github/workflows/deploy-distributed.yml`), triggered on push to
the feature branch:

1. Builds the backend Docker image, pushes to GitHub Container Registry.
2. Authenticates to AWS using a dedicated, narrowly-scoped IAM user
   (`github-actions-deploy`) — separate from any human user, permissioned only for
   `ssm:SendCommand` on these three specific instance ARNs.
3. Sends a deploy command via `aws ssm send-command` to `kgb1`+`kgb2` (`git pull`,
   `docker compose pull`, `docker compose up -d`) and a separate command to the
   Caddy/Redis instance — no SSH, no manual steps, fully auditable via SSM's Run
   Command history.

---

## Environment Configuration

Private IPs are never committed — each instance has its own `.env` (gitignored),
referenced via Docker Compose variable substitution:

| Instance | Required `.env` values |
|---|---|
| Caddy + Redis | `BACKEND1_ADDR`, `BACKEND2_ADDR` |
| Backend 1 / Backend 2 | `REDIS_ADDR` |

See `.env.example` for the expected shape.

---

## Known Limitations / Honest Trade-offs

- **Public subnet, not private** — instances have public IPs; isolation is via
  Security Group only. A deliberate cost trade-off, not an oversight.
- **Fixed 2 backend instances, no Auto Scaling Group yet** — ASG's core benefit
  (replacing a dead instance with a new one at a new IP) directly conflicts with
  Caddy's current static-IP `reverse_proxy` config. Solving this properly requires
  either an internal Load Balancer in front of the ASG or a service-discovery
  mechanism — deliberately out of scope for this pass.
- **Visitor counter is not yet migrated to Redis** — it still uses a local
  per-instance file, meaning the two backend instances undercount independently
  rather than sharing one true total. Low-priority since it's a non-critical stat.
- **Single Redis instance, no replication/cluster yet** — Redis itself is a
  single point of failure for all game state. Redis Cluster (hash-slot based
  sharding, conceptually identical to the consistent-hashing pattern used for
  Kafka-style partitioning) is a natural next step, not yet implemented.

---

## Tech Stack

Node.js, TypeScript, Socket.IO, `@socket.io/redis-adapter`, Redis (`ioredis`),
Docker & Docker Compose, Caddy (reverse proxy + automatic TLS via Let's Encrypt),
AWS EC2 / IAM / Systems Manager / Security Groups, GitHub Actions, GHCR.