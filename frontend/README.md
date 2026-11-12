# Attachment Management System frontend

This React/Vite app provides email verification, password reset, invitation acceptance, and sign-in flows. The `/home` route is a signed-in placeholder; the access token stays in application memory only.

## Development

```sh
npm install
npm run dev
```

Set `VITE_API_BASE_URL` in `.env.local` to the backend origin, for example `http://localhost:4000`. Requests include the API prefix (`/api/v1`). The backend development origin allow-list should include `http://localhost:5173`; it is already present in `backend/.env.example`.

## Checks

```sh
npm test
npm run build
npm run lint
```

Email-link tokens are removed from the URL before the router mounts and are kept in memory only. Password reset, email verification, and invitation acceptance send them to the API in POST request bodies. Sign-in includes credentials so the API can set its HttpOnly refresh cookie.
