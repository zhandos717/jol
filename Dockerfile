# One image recipe for every service: `docker build --build-arg SERVICE=dispatch .`
# SERVICE=all-in-one runs all of them in one process (lite profile).
# The build stage is shared, so building all six services compiles the monorepo once.

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY services services
RUN npm ci --no-audit --no-fund \
 && npx tsc -b \
 && npm prune --omit=dev --no-audit --no-fund \
 && find packages services -name '*.test.*' -delete

FROM node:22-alpine AS runtime
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE} PORT=8080
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services ./services
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["sh", "-c", "exec node services/${SERVICE}/dist/main.js"]
