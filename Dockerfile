# syntax=docker/dockerfile:1
# Runtime image for the learning backend on Railway.
# Node is pinned to an exact patched 22 LTS release by tag AND immutable digest
# (node:22.23.4-bookworm-slim, the 2026-10-20 security release). Bump both together.
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# Prisma's query engine needs OpenSSL; slim images do not ship it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN chown node:node /app
USER node

# Install from the lockfile. Dev dependencies stay: the start command runs the
# prisma CLI (`prisma db push`, which also regenerates the client), as the
# previous Nixpacks build did.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma ./prisma
RUN npm ci --include=dev --no-audit --no-fund

COPY --chown=node:node . .

EXPOSE 3000

# Same start sequence as before (railway.json used to carry it).
CMD ["sh", "-c", "npx prisma db push && exec npm start"]
