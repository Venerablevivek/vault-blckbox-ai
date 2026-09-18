# ---- build: compile TypeScript ----------------------------------------------
# Base images are pinned by digest so a build is reproducible and can't silently pick up a
# changed image; Dependabot proposes digest updates.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
WORKDIR /app
# argon2 is a native module; the compilers are needed only while installing it.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- deps: production dependencies, native modules compiled for this platform ----
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ----------------------------------------------------------------
# No compilers, no dev dependencies, no source. Runs as the unprivileged node user.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The running service only needs node. npm, npx and corepack ship in the base image with their own
# dependency trees (and their own vulnerabilities); removing them shrinks what an attacker could use.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Migrations are plain .sql read at runtime by the migration runner.
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
