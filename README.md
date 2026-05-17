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
| Security | Helmet, @nestjs/throttler, argon2-hashed refresh tokens |
| Logging | nestjs-pino (pretty in dev, JSON in prod) |
| API Docs | Swagger / OpenAPI |
| Testing | Jest + Supertest |
| CI/CD | GitHub Actions + PM2 |

## Features

### Authentication
- Register & login with email/password
- Google OAuth 2.0 (one-click sign-in)
- Email verification required before login (24h token)
- Forgot / reset password via email (1h token)
- TOTP 2FA — Google Authenticator / Authy compatible (enable, disable, verify on login)
- JWT access token (15m) + refresh token (7d) with rotation on every refresh
- Refresh tokens stored as **argon2 hashes** in the database; plaintext never persists
- HttpOnly, `sameSite: strict` refresh cookie (CSRF-resistant)
- O(1) session lookup via `sessionId` embedded in the refresh JWT

### Account safety
- Account lockout after **5 failed login attempts** (15-minute cooldown)
- Per-user **session cap of 10** — oldest session evicted on new login
- Hourly **cleanup job** purges expired sessions and tokens
- Per-endpoint rate limiting on auth flows
- 2FA pre-auth tokens cannot be used as access tokens

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
- Admin panel — list users, change role, delete user, pagination
- Role-based access control: `FREELANCER` / `CLIENT` / `ADMIN`

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
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

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
| GET | `/auth/google/callback` | Google OAuth callback |
| GET | `/auth/verify-email` | Verify email via token |
| POST | `/auth/forgot-password` | Send reset password email |
| POST | `/auth/reset-password` | Reset password (invalidates all sessions) |
| POST | `/auth/2fa/generate` | Generate TOTP secret + QR code |
| POST | `/auth/2fa/enable` | Enable 2FA after scanning QR |
| POST | `/auth/2fa/disable` | Disable 2FA |
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
| GET | `/admin/users` | Get all users (paginated) |
| PATCH | `/admin/users/:id/role` | Change user role |
| DELETE | `/admin/users/:id` | Delete user |

### Messages (`/workspace/:workspaceId/messages`) — requires JWT

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/workspace/:workspaceId/messages` | List messages (paginated, newest first) |

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
| `Whiteboard` | Excalidraw board with scene JSON |
| `WhiteboardComment` | Comment pinned to an Excalidraw element |
| `WhiteboardVersion` | Snapshot of a board's scene (manual or auto on restore) |

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

## Project Structure

```
src/
├── auth/          # Login, register, OAuth, JWT strategies, 2FA, cleanup job
├── user/          # Profile, password change
├── admin/         # User management
├── workspace/     # Workspace CRUD
├── invite/        # Invite generation, email sending, accept flow
├── message/       # Workspace chat (REST history + Socket.IO gateway)
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
