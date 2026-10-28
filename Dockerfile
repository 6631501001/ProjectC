FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY api ./api
COPY public ./public
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "api/src/server.js"]
