# CodeInsight AI

An AI-powered coding workspace with user authentication, real-time streaming AI responses, and per-user history/stats, built on Node.js + Express.

## Architecture

- **Backend**: Node.js + Express (port 5000, host 0.0.0.0)
- **Frontend**: Vanilla HTML/CSS/JS SPA (protected, requires auth)
- **AI**: OpenRouter API — 6-model automatic fallback (openai/gpt-oss-120b:free primary)
- **Streaming**: Server-Sent Events (SSE) via `axios` responseType stream
- **Auth**: JWT (30-day tokens), bcryptjs password hashing
- **Database**: PostgreSQL (pg) — users, user_stats, user_history tables

## Key Files

| File | Purpose |
|---|---|
| `server.js` | Main server with all API routes, auth, streaming |
| `db.js` | PostgreSQL pool and schema initialization |
| `email.js` | Nodemailer email utility (dev fallback: console log) |
| `public/index.html` | Main app SPA |
| `public/script.js` | App logic with auth, DB-backed history/stats, theme |
| `public/style.css` | Styles with dark/light theme CSS variables |
| `public/auth.html` | Login / Signup / Forgot password page |
| `public/auth.js` | Auth page logic |
| `public/auth.css` | Auth page styles |
| `public/reset-password.html` | Password reset page |
| `public/reset.js` | Reset page logic |

## Features

| Feature | Description |
|---|---|
| Auth | Signup, login, JWT auth, forgot/reset password |
| Dark/Light Mode | Toggle persisted per-user in DB + localStorage |
| Dashboard | Per-user stats and recent activity from DB |
| Error Explainer | Real-time streaming AI error explanations |
| Code Analyzer | Complexity, issues & improvements |
| Code Review | Senior-level review (security, perf, architecture) |
| AI Chat | Multi-turn conversational AI |
| History | DB-backed per-user history with filtering & modal |
| **Code Translator** | Idiomatic code translation between 15+ languages with explanations |
| **Bug Bounty Challenge** | AI injects hidden bugs into your code for you to find; spoiler reveal |
| **Interview Coach** | Generates 5 targeted interview Q&A from your actual code |
| **Code DNA** | Personal developer fingerprint built from your coding history |
| **Test Generator** | Full unit test suite generation (Jest/pytest/JUnit etc.) with edge cases |
| **Code Simplifier** | Rewrites complex code with plain-English explanations for any skill level |
| **Regex Builder** | Describe a pattern in plain English → working regex with visual breakdown |
| **Learning Roadmap** | Personalized phase-by-phase learning plan for any topic |

## Auth API Endpoints

- `POST /api/auth/signup` — Create account, returns JWT
- `POST /api/auth/login` — Login, returns JWT
- `GET  /api/auth/me` — Get current user (protected)
- `PUT  /api/auth/theme` — Update theme preference (protected)
- `POST /api/auth/forgot-password` — Send reset email (dev: console log)
- `POST /api/auth/reset-password` — Reset password with token

## Tool API Endpoints (all protected with JWT)

- `POST /api/explain` — Streaming error explanation
- `POST /api/analyze` — Streaming code analysis
- `POST /api/chat` — Streaming multi-turn chat
- `POST /api/review` — Streaming code review
- `POST /api/translate` — Streaming idiomatic code translation
- `POST /api/bugify` — Streaming bug injection challenge
- `POST /api/interview` — Streaming interview Q&A from code
- `POST /api/dna` — Streaming developer fingerprint from history
- `GET  /api/stats` — Get user stats
- `POST /api/stats/:type` — Increment stat counter
- `GET  /api/history` — Get history (last 100)
- `POST /api/history` — Save history item
- `DELETE /api/history` — Clear all history
- `DELETE /api/history/:id` — Delete single item

## Environment Variables

- `OPENROUTER_API_KEY` — Required. OpenRouter API key (secret)
- `JWT_SECRET` — Required for stable auth across restarts (secret)
- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned)
- `EMAIL_USER` — Gmail address for password resets (optional)
- `EMAIL_PASS` — Gmail App Password (optional)
- `EMAIL_HOST` — SMTP host, default smtp.gmail.com (optional)

## Database Schema

- `users` — id, email, username, password_hash, theme, reset_token, reset_token_expiry
- `user_stats` — user_id (FK), errors_explained, code_analyses, code_reviews, ai_chats
- `user_history` — id, user_id (FK), type, input_text, output_text, language, created_at

## Running

```bash
node server.js
```

Runs on port 5000 via the "Start application" workflow.
