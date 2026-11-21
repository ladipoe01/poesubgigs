FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /data/profile
ENV NODE_ENV=production
ENV STATE_PATH=/data/session.json
ENV BROWSER_PROFILE_PATH=/data/profile
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
