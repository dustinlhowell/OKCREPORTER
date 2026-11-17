FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
RUN mkdir -p /data
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/status || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
