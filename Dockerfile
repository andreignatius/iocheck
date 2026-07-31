# syntax=docker/dockerfile:1

# ---- builder: full toolchain, compiles TS -> JS, then drops dev deps ----------
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: distroless (no shell, no package manager, minimal CVEs — §S4) ---
# The :nonroot tag runs as uid 65532; entrypoint is the node binary.
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
USER nonroot
EXPOSE 3000 9464
# 3000 = public API, 9464 = /metrics (separate port, monitoring-only via NetworkPolicy, §S8).
# Distroless ENTRYPOINT is node, so CMD is just the script path.
CMD ["dist/index.js"]
