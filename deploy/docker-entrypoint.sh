#!/bin/sh
set -eu
umask 077

node ./deploy/preflight-migration.mjs
./node_modules/.bin/prisma migrate deploy
node ./deploy/postflight-database.mjs
exec ./node_modules/.bin/next start
