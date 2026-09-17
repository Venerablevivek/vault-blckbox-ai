# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# Next.js evaluates next.config's rewrites() at BUILD time and bakes the result into the
# build output, so the API target has to be known here, not only at runtime.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----------------------------------------------------------------
# Only Next's standalone output (the files the server actually needs, traced at build time),
# the static assets and the custom server. No full node_modules, no build tooling.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node server.mjs ./
USER node
EXPOSE 3000
# server.mjs sets the real client address, security headers and share-page status codes.
CMD ["node", "server.mjs"]
