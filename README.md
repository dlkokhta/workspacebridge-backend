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

The backend API for **WorkspaceBridge**, a freelancer–client collaboration platform. The current scope is a hardened authentication system with user management — the foundation that the rest of the product is being built on top of.

## Tech Stack

| Category | Technology |
|----------|------------|
| Framework | NestJS (Node.js) |
| Language | TypeScript |
| Database | PostgreSQL + Prisma ORM |
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
- Per-endpoint rate limiting on auth flows (forgot-password, reset-password, verify-email)
- 2FA pre-auth tokens cannot be used as access tokens (token-type confusion prevented)

### User management
- View / update profile (name)
- Change password (re-validates current password)
- Admin panel — list users, change role, delete user, pagination
- Role-based access control: `FREELANCER` / `CLIENT` / `ADMIN`

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

# Cookies
COOKIES_SECRET=your_cookies_secret

# PostgreSQL
POSTGRES_USER=your_postgres_user
POSTGRES_PASSWORD=your_postgres_password
POSTGRES_HOST=localhost
POSTGRES_PORT=5435
POSTGRES_DB=your_db_name
POSTGRES_URL=postgresql://your_postgres_user:your_postgres_password@localhost:5435/your_db_name

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

### Admin (`/admin`) — requires JWT + `ADMIN` role

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/users` | Get all users (paginated) |
| PATCH | `/admin/users/:id/role` | Change user role |
| DELETE | `/admin/users/:id` | Delete user |

## Project Structure

```
src/
├── auth/          # Login, register, OAuth, JWT strategies, 2FA, cleanup job
├── user/          # Profile, password change
├── admin/         # User management
├── mail/          # Resend email templates
├── prisma/        # PrismaService
└── libs/          # Shared utilities and validators
prisma/
├── schema.prisma  # User, Session, Account, Token models
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
