# Configure OAuth, HTTPS, and runtime secrets

[Operations index](README.md) · [Full reference](../OPERATIONS.md) · [Back to README](../../README.md)

Create `~/LabGate/.env.local` from `.env.example`, set the required values, and
protect it with mode `600`. Set the exact HTTPS public origin in
`BETTER_AUTH_URL` and register:

```text
https://YOUR_PUBLIC_ORIGIN/api/auth/callback/google
```

Use independent secrets for Better Auth, machine registration, and cron. Set
`GUEST_PASSWORD_LENGTH` explicitly; every endpoint must use the same value.

After placing an institution-approved HTTPS reverse proxy in front of the Pi:

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=200 labgate
curl --fail --head http://127.0.0.1:3000/login
```

See the [configuration reference](../OPERATIONS.md#2-configure-oauth-https-and-runtime-secrets)
for validation rules and the complete environment-variable table.
