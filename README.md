# PulseChat

A Messenger-style realtime chat site that works online with a Node.js server, Socket.IO realtime messaging, account login/registration, private chats, group chats, online presence, typing indicators, and persisted chat history.

This project is intentionally original and does not use Meta/Facebook Messenger branding or assets.

## Features

- Register and login with hashed passwords
- JWT authentication
- Realtime messages with Socket.IO
- Direct messages
- Group chats
- Online/offline presence
- Typing indicators
- Responsive mobile/desktop UI
- Message history stored in `data/db.json`
- Docker-ready deployment

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open:

```text
http://localhost:3000
```

Create two accounts in two browser windows/incognito windows to test realtime chat.

## Important production setup

Before deploying publicly, edit `.env`:

```env
PORT=3000
JWT_SECRET=use-a-long-random-secret-here
CORS_ORIGIN=https://your-domain.com
```

If you do not know your domain yet, keep `CORS_ORIGIN=*` while testing, then lock it down later.

## Deploy online

### Option 1: Render / Railway / similar Node hosting

1. Upload this project to GitHub.
2. Create a new Web Service.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables:
   - `JWT_SECRET`: a long random value
   - `CORS_ORIGIN`: your deployed site URL, or `*` for testing
6. Add persistent disk/storage mounted to `/app/data` if the host supports it, so `data/db.json` survives redeploys.

### Option 2: Docker

```bash
docker build -t pulsechat .
docker run -p 3000:3000 \
  -e JWT_SECRET="use-a-long-random-secret" \
  -e CORS_ORIGIN="*" \
  -v pulsechat-data:/app/data \
  pulsechat
```

## Notes

- The included file database is good for small/medium demos and simple deployments.
- For heavy production use, replace `data/db.json` with PostgreSQL, MySQL, MongoDB, or another managed database.
- The preview inside Arena may not keep a long-running server alive automatically; run `npm start` in a terminal to use it.
