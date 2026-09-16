FROM node:18-alpine

WORKDIR /app

COPY ai-workforce-platform/package.json ./
RUN npm install --omit=dev

COPY ai-workforce-platform/ .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
