# ---- build: compile TypeScript ----------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# argon2 is a native module; the compilers are needed only while installing it.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- deps: production dependencies, native modules compiled for this platform ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ----------------------------------------------------------------
# No compilers, no dev dependencies, no source. Runs as the unprivileged node user.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Migrations are plain .sql read at runtime by the migration runner.
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
