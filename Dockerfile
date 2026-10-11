FROM node:22-alpine

ENV NODE_ENV=production PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js storage.js taxi.html driver.html app.css rating.js vehicles.js cities.js ./
COPY migrations ./migrations

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:8080/api/health || exit 1

CMD ["node", "server.js"]
