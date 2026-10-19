FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
