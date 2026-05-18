FROM node:22-bookworm-slim
WORKDIR /app
ARG INSTALL_BLENDER=0
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates p7zip-full $(if [ "$INSTALL_BLENDER" = "1" ]; then echo blender python3-numpy; fi) && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
