FROM node:22-bookworm-slim
WORKDIR /app
ARG INSTALL_BLENDER=0
ARG INSTALL_KN5=0
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates p7zip-full \
    $(if [ "$INSTALL_BLENDER" = "1" ]; then echo blender python3-numpy; fi) \
    $(if [ "$INSTALL_KN5" = "1" ]; then echo git python3-numpy; fi) \
  && if [ "$INSTALL_KN5" = "1" ]; then git clone --depth 1 https://github.com/MarvinSt/kn5-obj-converter.git /opt/kn5-obj-converter; fi \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
