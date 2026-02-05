# Stage 1: Build the application
FROM node:18 AS build
WORKDIR /app
COPY package*.json ./
COPY back/sirinium ./back/sirinium
RUN npm install
COPY . .

# Stage 2: Create the production image
FROM node:18-slim
WORKDIR /app

# Устанавливаем корневые сертификаты для HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Переменные окружения для undici/Node
ENV NODE_OPTIONS=--use-openssl-ca
ENV UV_USE_IO_URING=0

# Копируем node_modules и package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Копируем все исходные файлы (включая utils.js, server.js и др.)
COPY --from=build /app/. ./

EXPOSE 3000
CMD ["npm", "start"]
