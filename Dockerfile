# Google Cloud Run: gcloud run deploy apeats --source . --region asia-southeast1 --allow-unauthenticated
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
