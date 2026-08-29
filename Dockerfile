# Molibra node.
#
# Deliberately boring: an official Node base, two dependencies, no build step,
# no compiler. If you are going to be asked to run this and audit what it does,
# the image had better be readable in one screen.
#
#   docker build -t molibra:0.1.0 .
#   docker run -d -p 8545:8545 -v molibra-data:/data molibra:0.1.0 \
#          node src/cli.js node --host 0.0.0.0 --port 8545 --datadir /data
#
# The chain state lives in a volume, never in the image. Nothing secret is
# baked in: mining needs only the miner's ADDRESS, never a private key, so a
# mining node holds no credential at all.

FROM node:22-alpine

# curl is used by the healthcheck below and by anyone poking the audit routes.
RUN apk add --no-cache curl

WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY genesis.json ./

# Run unprivileged. The node image ships a `node` user; give it the datadir.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8545

# The audit surface is the liveness signal: a node that cannot serve its own
# head is not useful to anyone, however alive the process is.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8545/molibra/head > /dev/null || exit 1

# Bind 0.0.0.0 inside the container; publish the port deliberately on the host.
ENTRYPOINT ["node", "src/cli.js"]
CMD ["node", "--host", "0.0.0.0", "--port", "8545", "--datadir", "/data"]
