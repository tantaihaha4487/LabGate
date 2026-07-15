# Configure LabGate

[Docs home](README.md) · [Pi install](install-pi.md) · [Lab machine install](install-lab-machine.md)

Complete this guide on the Raspberry Pi after [Pi installation](install-pi.md).
The application expects an HTTPS public origin, Google OAuth credentials, and
protected runtime secrets before the first production start.

## Environment file

~~~sh
# Pi
cd ~/LabGate
cp .env.example .env.local
chmod 600 .env.local
~~~

Set every value in <code>.env.local</code>; keep placeholders out of a running deployment.

| Variable | Value |
| --- | --- |
| <code>BETTER_AUTH_URL</code> | Exact public <code>https://&lt;PUBLIC_ORIGIN&gt;</code> with no extra path. |
| <code>BETTER_AUTH_SECRET</code> | A strong application signing secret. |
| <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code> | The Google web OAuth client. |
| <code>ALLOWED_EMAIL_DOMAIN</code> | <code>ubu.ac.th</code>, with server-side suffix enforcement. |
| <code>DATABASE_URL</code> | <code>file:./data/labgate.db</code>. |
| <code>PROVISIONER_SSH_KEY_PATH</code> | <code>/run/secrets/provisioner_key</code> in Compose. |
| <code>CREDENTIAL_TTL_HOURS</code> | Pending login deadline: <code>0.0166667</code> through <code>24</code>. |
| <code>GUEST_PASSWORD_LENGTH</code> | Exact generated length: an integer from <code>8</code> through <code>128</code>. |
| <code>MACHINE_REGISTRATION_SECRET</code> | A 20–256 character RFC 6750 <code>b64token</code>. |
| <code>CRON_SECRET</code> | A separate 20–256 character RFC 6750 <code>b64token</code>. |

Standard Base64 <code>+</code>, <code>/</code>, and terminal <code>=</code> padding are valid in the two bearer
secrets. Whitespace and quoting are not. Never put a machine webhook token in
this file; registration generates one per endpoint.

<code>GUEST_PASSWORD_LENGTH</code> is exact on both sides. The application generates that
many unambiguous alphanumeric characters, and machine setup persists the same
value in root-only <code>/etc/labgate/password-length</code>.

## Google OAuth and HTTPS

Configure the Google client for the public origin and add this callback:

~~~text
https://<PUBLIC_ORIGIN>/api/auth/callback/google
~~~

Put an institution-approved HTTPS reverse proxy in front of the Pi and forward
requests to <code>127.0.0.1:3000</code>. Set <code>BETTER_AUTH_URL</code> to the public HTTPS origin,
not the loopback address. Verify the proxy preserves the request host and HTTPS
scheme.

## Start and check the application

~~~sh
# Pi
docker compose up --build -d
docker compose ps
docker compose logs --tail=200 labgate
curl --fail --silent http://127.0.0.1:3000/api/health
~~~

Startup validates runtime configuration, runs migration preflight, applies
Prisma migrations, runs database postflight, and only then starts Next.js. A
non-zero startup or unhealthy health response is a stop condition; use
[deployment](deployment.md) and [recovery](recovery.md) to investigate.

## Install the recovery sweep

Create a root-only curl configuration on the Pi. Edit the placeholder locally in
the protected file; never place the bearer value in crontab, argv, logs, or
shell history.

~~~sh
# Pi
sudo install -o root -g root -m 600 /dev/null /etc/labgate/cron-curl.conf
sudoedit /etc/labgate/cron-curl.conf
~~~

The file must contain the cron secret as a header, for example:

~~~text
header = "Authorization: Bearer <CRON_SECRET>"
header = "Accept: application/json"
~~~

Install the root crontab entry from <code>deploy/labgate-sweep.cron.example</code>, using
the exact loopback URL shown there:

~~~sh
# Pi
sudo crontab -e
~~~

Test the route without printing the secret:

~~~sh
# Pi
sudo curl --config /etc/labgate/cron-curl.conf --fail --silent --show-error \
  --max-time 20 --request POST http://127.0.0.1:3000/api/cron/sweep
~~~

Continue with [physical lab-machine installation](install-lab-machine.md).
