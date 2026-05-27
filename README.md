# WorkspaceBridge Backend

> Freelancer–client collaboration platform — Backend API

**API Docs (Swagger):** `http://localhost:4002/docs`
**Frontend repo:** [workspacebridge-frontend](../workspacebridge-frontend)

![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white&style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white&style=flat-square)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white&style=flat-square)
![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white&style=flat-square)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white&style=flat-square)

---

## What is this?

The backend API for **WorkspaceBridge**, a freelancer–client collaboration platform. Freelancers create workspaces per client, invite them via magic link or email, and collaborate through messages, files, whiteboard, and shared links.

## Tech Stack

| Category | Technology |
|----------|------------|
| Framework | NestJS (Node.js) |
| Language | TypeScript |
| Database | PostgreSQL + Prisma ORM |
| Realtime | Socket.IO (chat, whiteboard sync, presence) |
| File storage | Cloudinary |
| Auth | JWT (access + refresh), Google OAuth 2.0, TOTP 2FA |
| Password hashing | Argon2 |
| Email | Resend |
| Security | Helmet, @nestjs/throttler, argon2 hashing, AES-256-GCM at-rest encryption for 2FA secrets, refresh-token rotation, account lockout |
| Logging | nestjs-pino (pretty in dev, JSON in prod) |
| API Docs | Swagger / OpenAPI |
| Testing | Jest + Supertest |
| CI/CD | GitHub Actions + PM2 |

## Features

### Authentication
- Register & login with email/password
- Google OAuth 2.0 (one-click sign-in) — token is **never put in the redirect URL**. The callback mints a short-lived single-use `AuthExchangeCode`, the frontend POSTs it to `/auth/exchange`, and tokens are returned in the response body
- Email verification required before login (24h token)
- Forgot / reset password via email (1h token) — runs the real work **asynchronously** so unknown / known emails have identical response timing (no enumeration via timing oracle)
- TOTP 2FA — Google Authenticator / Authy compatible
- JWT access token (15m) + refresh token (7d) with rotation on every refresh
- **Separate `JWT_REFRESH_SECRET`** — leaking the access-token secret can't be turned into forged refresh tokens
- Refresh tokens stored as **argon2 hashes** in the database; plaintext never persists
- HttpOnly refresh cookie with **env-driven `SameSite`** — same-site deployments use `lax`/`strict`, cross-domain (e.g. Vercel + Render) use `none` + `secure: true`
- O(1) session lookup via `sessionId` embedded in the refresh JWT
- **Constant-time credentials check** — `argon2.verify` runs against a dummy hash for unknown emails / Google-only accounts so attackers can't enumerate users by response timing
- **Generic `Invalid credentials` response** for every login failure mode (unknown email, wrong password, Google-only account) — no message-based enumeration

### Two-factor authentication
- Enable / disable / verify on login
- **Pending setup staged in a separate table** — `/auth/2fa/generate` writes to `PendingTwoFactorSetup`, not to the user row. Abandoned setups never leave orphan secrets behind. 15-minute TTL.
- **Disabling 2FA requires password re-auth** — a hijacked session + authenticator alone is not enough
- TOTP secrets **encrypted at rest** (AES-256-GCM via `ENCRYPTION_KEY`); a DB dump no longer hands an attacker every user's seed
- **Per-tempToken replay protection** — each 2FA pre-auth token carries a `jti`; the matching `TwoFactorAttempt` row is burned on first success or after 5 failed guesses, regardless of source IP
- **Per-IP rate limit** of 5/min on `/auth/2fa/verify` on top of the per-token cap
- 2FA pre-auth tokens cannot be used as access tokens (rejected by the JWT strategy)

### Account safety & rate limiting
- Account lockout after **5 failed login attempts** (15-minute cooldown) using Prisma's atomic `{ increment: 1 }` so concurrent requests can't undercount toward the threshold
- Lockout state is **only revealed once the password is correct** — wrong-password attempts return the same generic error so attackers can't probe for the lock
- Per-user **session cap of 10** — oldest session evicted on new login
- Hourly **cleanup job** purges expired sessions, tokens, OAuth exchange codes, 2FA attempts, and pending 2FA setups
- Per-endpoint rate limiting:
  - `/auth/login` — 5 / 5 min per IP
  - `/auth/forgot-password` — 3 / 15 min per IP
  - `/auth/2fa/verify` — 5 / min per IP
- `trust proxy` driven by `TRUST_PROXY` env so `req.ip` reflects the real client behind a reverse proxy (Vercel, Render, Cloudflare) — required for honest session IP tracking and per-IP throttling

### Realtime authentication
- Socket gateways (`/chat`, `/whiteboard`, `/shared-tasks`) verify the JWT at connect **and** drop the connection on every event once the access token's `exp` has passed (the client refreshes via `/auth/refresh` and reconnects)

### Workspace management
- Freelancers create workspaces per client (name, description, color, status)
- Status flow: `ACTIVE` → `COMPLETED` / `ARCHIVED`
- Role-aware listing: freelancers see owned workspaces, clients see invited workspaces
- Ownership checks on all mutating endpoints

### Client invite flow
- Generate shareable invite link (UUID token, 7-day expiry)
- Send magic link email via Resend to a specific client email
- Validate invite token — returns workspace info for the accept page
- Accept invite — creates client account, adds to workspace as member, issues JWT tokens
- Invite tokens are single-use (`usedAt` stamped on acceptance)

### User management
- View / update profile (name)
- Change password (re-validates current password)
- Role-based access control: `FREELANCER` / `CLIENT` / `ADMIN`
- User status: `ACTIVE` / `SUSPENDED`

### Admin panel
- **Dashboard** — platform stats, signup/workspace trends (30-day chart)
- **User management** — list, detail view, role change, suspend/activate, reset password, force-verify, delete
- **Workspace management** — list with owner and member count, status change, delete
- **Invite management** — list all platform invites, revoke
- **Session management** — list all sessions, force-logout (revoke)
- **File management** — list all files, storage stats per workspace, permanent delete from R2
- **Audit log** — tracks all admin actions with actor, target, metadata, timestamp
- **Platform settings** — configurable invite expiry, max file size, maintenance mode, registration toggle
- All admin actions are audit-logged

### Messaging
- Realtime chat per workspace via Socket.IO
- Persistent message history (paginated REST loader)
- Sender info embedded in each message (name, avatar)

### Whiteboard collaboration
- Multiple boards per workspace — create / rename / duplicate / delete
- Realtime multi-user editing on Excalidraw scenes (debounced sync, server-side persistence)
- Live remote cursors with author name and color
- **15 starter templates** — Blank, Brainstorm, Sticky notes, Mood board, Kanban, Timeline, 2×2 Matrix, Retro, Flowchart, User journey, Wireframe, System architecture, Database schema, API sequence, State machine
- **Comments on shapes** — pin notes to any Excalidraw element, scoped per author, broadcast over socket
- **Version history** — manual snapshots with optional labels, read-only preview, restore with automatic safety snapshot of the current state, live re-sync to all collaborators

## Getting Started

### Prerequisites
- Node.js 18+
- Docker (for PostgreSQL via docker-compose)

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
Create a `.env` file:

```env
NODE_ENV=development

APPLICATION_PORT=4002
APPLICATION_URL=http://localhost:4002
ALLOWED_ORIGIN=http://localhost:5173
FRONTEND_URL=http://localhost:5173

# PostgreSQL
POSTGRES_URL=postgresql://user:password@localhost:5435/workspacebridge

# JWT
JWT_SECRET=your_jwt_secret
JWT_REFRESH_SECRET=your_separate_refresh_secret  # optional but recommended — distinct from JWT_SECRET
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# AES-256-GCM key used to encrypt 2FA TOTP secrets at rest.
# Generate with: openssl rand -base64 32
ENCRYPTION_KEY=your_base64_encoded_32_byte_key

# Cookie SameSite for the refresh cookie.
# Same-site deployments (frontend + API share an eTLD+1): "lax" or "strict"
# Cross-domain (Vercel + Render etc.): "none"  (forces secure:true)
# Default: "none" in production, "lax" in development.
COOKIE_SAMESITE=none

# Reverse proxy hop count or CIDR. Required behind Vercel / Render / Cloudflare
# so req.ip reflects the real client. Unset = no trust (safe dev default).
TRUST_PROXY=1

# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_CALLBACK_URL=http://localhost:4002/auth/google/callback

# Resend (email)
RESEND_API_KEY=your_resend_api_key
RESEND_FROM_EMAIL=noreply@yourdomain.com

# Cloudinary (file storage)
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Cloudflare R2 (workspace file storage)
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_BUCKET=workspacebridge-files
```

### 3. Start the database
```bash
docker compose up -d
```

### 4. Run database migrations
```bash
npx prisma migrate deploy
```

### 5. Start the server
```bash
# development
npm run start:dev

# production
npm run build && npm run start:prod
```

Server runs on `http://localhost:4002`. Swagger UI at `http://localhost:4002/docs`.

### 6. Run tests
```bash
npm run test       # unit
npm run test:e2e   # end-to-end
```

## API Reference

### Auth (`/auth`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/signup` | Register with email/password |
| POST | `/auth/login` | Login with email/password |
| POST | `/auth/logout` | Logout (clears the matching session only) |
| POST | `/auth/refresh` | Rotate access + refresh tokens |
| GET | `/auth/google` | Initiate Google OAuth |
| GET | `/auth/google/callback` | Google OAuth callback — redirects with a short-lived `?code=` (single-use, 30s) |
| POST | `/auth/exchange` | Exchange the OAuth `code` for `{ user, accessToken }` + refresh cookie |
| GET | `/auth/verify-email` | Verify email via token |
| POST | `/auth/forgot-password` | Send reset password email |
| POST | `/auth/reset-password` | Reset password (invalidates all sessions) |
| POST | `/auth/2fa/generate` | Generate TOTP secret + QR code |
| POST | `/auth/2fa/enable` | Enable 2FA after scanning QR |
| POST | `/auth/2fa/disable` | Disable 2FA (requires password re-auth + TOTP code) |
| POST | `/auth/2fa/verify` | Complete login with 2FA code |

### User (`/user`) — requires JWT

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/user/me` | Get current user profile |
| PATCH | `/user/me` | Update name |
| PATCH | `/user/me/password` | Change password |

### Workspace (`/workspace`) — requires JWT

| Method | Endpoint | Description | Role |
|--------|----------|-------------|------|
| POST | `/workspace` | Create a workspace | FREELANCER |
| GET | `/workspace` | List workspaces (owned or invited) | Any |
| GET | `/workspace/:id` | Get workspace detail with members | Any |
| PATCH | `/workspace/:id` | Update name, description, color, status | FREELANCER |
| DELETE | `/workspace/:id` | Delete workspace | FREELANCER |

### Invite

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/workspace/:id/invite` | Send magic link email to client | JWT (FREELANCER) |
| POST | `/workspace/:id/invite/link` | Generate shareable invite link | JWT (FREELANCER) |
| GET | `/invite/:token` | Validate token, return workspace info | Public |
| POST | `/invite/:token/accept` | Create client account + join workspace | Public |

### Admin (`/admin`) — requires JWT + `ADMIN` role

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/stats` | Platform statistics (users, workspaces, signups/day) |
| GET | `/admin/users` | List all users |
| GET | `/admin/users/:id` | User detail (workspaces, sessions, invites) |
| PATCH | `/admin/users/:id/role` | Change user role |
| PATCH | `/admin/users/:id/status` | Suspend / activate user |
| POST | `/admin/users/:id/reset-password` | Send password reset email |
| POST | `/admin/users/:id/force-verify` | Force-verify user email |
| DELETE | `/admin/users/:id` | Delete user |
| GET | `/admin/workspaces` | List all workspaces (with owner, member count) |
| PATCH | `/admin/workspaces/:id/status` | Change workspace status |
| DELETE | `/admin/workspaces/:id` | Delete workspace |
| GET | `/admin/invites` | List all invites |
| DELETE | `/admin/invites/:id` | Revoke invite |
| GET | `/admin/sessions` | List all sessions |
| DELETE | `/admin/sessions/:id` | Revoke session (force logout) |
| GET | `/admin/files` | List all files |
| GET | `/admin/files/stats` | File storage stats (total size, per workspace) |
| DELETE | `/admin/files/:id` | Permanently delete file (removes from R2) |
| GET | `/admin/audit-log` | Audit log (last 200 entries) |
| GET | `/admin/settings` | Platform settings |
| PATCH | `/admin/settings/:key` | Update a platform setting |

### Messages (`/workspace/:workspaceId/messages`) — requires JWT

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/workspace/:workspaceId/messages` | List messages (paginated, newest first) |

### Files (`/files`, `/workspace/:workspaceId/files`) — requires JWT

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/workspace/:workspaceId/files` | List active files in a workspace |
| POST | `/workspace/:workspaceId/files` | Upload a file (multipart `file`, server-side MIME + size + quota checks) |
| GET | `/workspace/:workspaceId/files/trash` | List soft-deleted files within the 30-day retention window |
| GET | `/files/:id/download` | Get a short-lived presigned R2 download URL (`{ url, expiresIn, name }`) |
| DELETE | `/files/:id` | Soft-delete (moves to trash, keeps bytes for 30 days) |
| POST | `/files/:id/restore` | Restore a soft-deleted file (quota re-checked) |
| DELETE | `/files/:id/purge` | Permanently delete a trashed file from R2 + DB (uploader or workspace owner) |

### Shared Links (`/links`, `/workspace/:workspaceId/links`) — requires JWT

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/workspace/:workspaceId/links` | List shared links in a workspace (any member) |
| POST | `/workspace/:workspaceId/links` | Add a link (`{ url, title? }`, any member) |
| DELETE | `/links/:id` | Delete a link (creator OR workspace owner) |

### Whiteboards — requires JWT

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/workspace/:workspaceId/whiteboards` | List boards in workspace |
| POST | `/workspace/:workspaceId/whiteboards` | Create board (optionally seeded with template `elements`) |
| GET | `/whiteboards/:boardId` | Get board snapshot |
| PATCH | `/whiteboards/:boardId` | Save scene (elements, appState, files) |
| PATCH | `/whiteboards/:boardId/rename` | Rename board |
| POST | `/whiteboards/:boardId/duplicate` | Duplicate board |
| DELETE | `/whiteboards/:boardId` | Delete board (workspace owner only) |

### Whiteboard comments — requires JWT

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/whiteboards/:boardId/comments` | List shape comments for a board |
| POST | `/whiteboards/:boardId/comments` | Add comment on a shape |
| DELETE | `/whiteboards/:boardId/comments/:commentId` | Delete own comment |

### Whiteboard versions — requires JWT

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/whiteboards/:boardId/versions` | List version snapshots (lightweight) |
| GET | `/whiteboards/:boardId/versions/:versionId` | Get full version (elements, appState, files) |
| POST | `/whiteboards/:boardId/versions` | Save manual snapshot of current scene |
| POST | `/whiteboards/:boardId/versions/:versionId/restore` | Restore version (auto-snapshots current state first) |

## Socket.IO

Two namespaces, both authenticated via the JWT access token in the connection handshake (`auth.token`).

### `/messages`

| Event | Direction | Purpose |
|---|---|---|
| `joinRoom` | client → server | Join a workspace's chat room |
| `sendMessage` | client → server | Send a message; persisted then broadcast |
| `newMessage` | server → client | New message in room |

### `/whiteboard`

| Event | Direction | Purpose |
|---|---|---|
| `joinBoard` | client → server | Join a board room |
| `boardState` | server → client | Initial scene on join |
| `sceneUpdate` | bidirectional | Debounced scene diff (broadcast + persisted) |
| `pointerUpdate` | bidirectional | Throttled cursor position |
| `collaboratorJoined` | server → client | A user joined the board |
| `collaboratorLeft` | server → client | A user left the board |
| `commentCreated` | server → client | New shape comment |
| `commentDeleted` | server → client | Comment deleted |
| `boardRestored` | server → client | A version was restored — reload scene |

## Database Models

| Model | Description |
|-------|-------------|
| `User` | Freelancers, clients, and admins |
| `Session` | Refresh token sessions (argon2-hashed) |
| `Account` | OAuth provider accounts |
| `Token` | Email verification, password reset, 2FA tokens |
| `Workspace` | Per-client project space owned by a freelancer |
| `WorkspaceMember` | Links clients to workspaces |
| `WorkspaceInvite` | Invite tokens (email or shareable link, single-use) |
| `Message` | Workspace chat messages |
| `File` | Workspace file (R2 storage key + metadata, soft-delete via `deletedAt`) |
| `SharedLink` | URL shared in a workspace (creator attribution, optional title) |
| `Whiteboard` | Excalidraw board with scene JSON |
| `WhiteboardComment` | Comment pinned to an Excalidraw element |
| `WhiteboardVersion` | Snapshot of a board's scene (manual or auto on restore) |
| `AuditLog` | Admin action audit trail (actor, action, target, metadata) |
| `PlatformSetting` | Key-value platform configuration (invite expiry, file limits, feature flags) |

## File Storage Plans

Per-plan file size and workspace storage limits (enforced server-side on upload):

```ts
// Per-file size limit by plan
const FILE_SIZE_LIMITS = {
  free: 25 * 1024 * 1024,       // 25 MB
  pro: 100 * 1024 * 1024,       // 100 MB
  business: 500 * 1024 * 1024,  // 500 MB
};

// Total workspace storage limit by plan
const STORAGE_LIMITS = {
  free: 500 * 1024 * 1024,         // 500 MB
  pro: 10 * 1024 * 1024 * 1024,    // 10 GB
  business: 50 * 1024 * 1024 * 1024, // 50 GB
};
```

| Plan | Max file size | Max workspace storage |
|------|---------------|-----------------------|
| Free | 25 MB | 500 MB |
| Pro | 100 MB | 10 GB |
| Business | 500 MB | 50 GB |

### Trash and quota

Deleting a file via `DELETE /files/:id` is a **soft delete** — the file moves
to trash and its bytes keep occupying R2 storage for a 30-day retention
window. Trashed bytes count against the workspace quota during that window,
so the upload and restore checks see the workspace's real R2 footprint
rather than just active files.

Two paths free those bytes:

- **Auto:** the daily cleanup cron (`FileCleanupService`, 03:00) purges
  files whose `deletedAt` is older than 30 days from R2 and the DB.
- **Manual:** `DELETE /files/:id/purge` lets the uploader or workspace
  owner permanently delete a trashed file immediately, recovering the
  bytes without waiting for the sweep.

## Project Structure

```
src/
├── auth/          # Login, register, OAuth, JWT strategies, 2FA, cleanup job
├── user/          # Profile, password change
├── admin/         # Admin panel (stats, users, workspaces, invites, sessions, files, audit log, settings)
├── workspace/     # Workspace CRUD
├── invite/        # Invite generation, email sending, accept flow
├── message/       # Workspace chat (REST history + Socket.IO gateway)
├── file/          # Uploads, downloads, trash + restore + purge, R2 storage, daily cleanup cron
├── shared-link/   # Workspace URL bookmarks (any-member add, creator-or-owner delete)
├── whiteboard/    # Boards, realtime sync, comments, version snapshots
├── mail/          # Resend email templates
├── prisma/        # PrismaService
└── libs/          # Shared utilities and validators
prisma/
├── schema.prisma  # All models and enums
└── migrations/    # Migration history
```

## CI/CD

Automated deployment via **GitHub Actions** on every push to `master`:

1. SSH into production server
2. Pull latest code
3. Install dependencies
4. Run Prisma migrations
5. Build the app
6. Restart with **PM2**

| GitHub Secret | Description |
|---------------|-------------|
| `SERVER_HOST` | Production server IP or domain |
| `SERVER_USER` | SSH username |
| `SSH_PRIVATE_KEY` | SSH private key |
