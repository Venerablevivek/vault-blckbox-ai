# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# Next.js evaluates next.config's rewrites() at BUILD time and bakes the result into
# routes-manifest.json, so the API target has to be known here — not only at runtime.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY next.config.mjs server.mjs ./
EXPOSE 3000
# server.mjs replaces any client-supplied X-Forwarded-For with the socket address.
CMD ["node", "server.mjs"]
