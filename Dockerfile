FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data
ENV NODE_ENV=production
ENV STATE_PATH=/data/session.json
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
