FROM node:22-bookworm-slim
WORKDIR /app
ARG INSTALL_BLENDER=0
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates $(if [ "$INSTALL_BLENDER" = "1" ]; then echo blender; fi) && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
