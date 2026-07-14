FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM node:22-alpine AS builder
WORKDIR /app
ENV BETTER_AUTH_URL=http://localhost:3000 \
    BETTER_AUTH_SECRET=build-only-placeholder-secret-at-least-32-characters \
    GOOGLE_CLIENT_ID=build-only-placeholder.apps.googleusercontent.com \
    GOOGLE_CLIENT_SECRET=build-only-placeholder \
    ALLOWED_EMAIL_DOMAIN=ubu.ac.th
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/.next ./.next
COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/package.json ./package.json
COPY --chown=node:node --from=builder /app/prisma ./prisma
COPY --chown=node:node --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --chown=node:node --from=builder /app/deploy/preflight-migration.mjs ./deploy/preflight-migration.mjs
COPY --chown=node:node --from=builder /app/deploy/postflight-database.mjs ./deploy/postflight-database.mjs
COPY --from=builder /app/deploy/docker-entrypoint.sh /usr/local/bin/labgate-entrypoint
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/labgate-entrypoint"]
