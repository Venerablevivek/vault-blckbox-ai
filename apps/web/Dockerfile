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
# Next's standalone output ships only the files the server actually needs.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
