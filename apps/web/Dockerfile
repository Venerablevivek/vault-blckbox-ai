# ---- build ------------------------------------------------------------------
# Base images are pinned by digest so a build is reproducible and can't silently pick up a
# changed image; Dependabot proposes digest updates.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
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
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The running service only needs node. npm, npx and corepack ship in the base image with their own
# dependency trees (and their own vulnerabilities); removing them shrinks what an attacker could use.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node server.mjs ./
USER node
EXPOSE 3000
# server.mjs sets the real client address, security headers and share-page status codes.
CMD ["node", "server.mjs"]
