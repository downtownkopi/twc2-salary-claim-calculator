# tsx runs the TypeScript source directly (no compile step), so devDependencies (tsx, typescript)
# are needed at runtime too — a plain `npm ci` (not --omit=dev) is intentional here.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY server.ts ./
COPY lib ./lib
COPY public ./public
COPY calculation.xltx ./

# Cloud Run injects PORT and any configured env vars directly into the process environment —
# no .env file exists in the container, so this runs tsx without --env-file (unlike the local
# `npm run server` script, which loads .env for convenience).
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
