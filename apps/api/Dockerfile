# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# argon2 ships prebuilt binaries but falls back to node-gyp on some platforms.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migrations are plain .sql read at runtime by the migration runner.
COPY migrations ./migrations
EXPOSE 4000
CMD ["node", "dist/main.js"]
