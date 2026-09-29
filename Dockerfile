FROM node:20-slim
ENV TZ=Europe/Helsinki
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
EXPOSE 8080
CMD ["node", "server.js"]
