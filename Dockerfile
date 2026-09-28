# SkyTrace has no npm dependencies, so there is nothing to install and nothing
# to build - the image is the runtime plus about a megabyte of source.
FROM node:22-alpine

WORKDIR /app
COPY package.json server.js prefetch-tiles.mjs ./
COPY public ./public

# Cached airport layouts and map tiles live here. Mount a volume over it on a
# host with persistent storage; without one the cache simply refills itself.
RUN mkdir -p /app/.cache
VOLUME ["/app/.cache"]

ENV HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production
EXPOSE 8787

# Credentials and the access token are passed in at run time, never baked in:
#   docker run -p 8787:8787 \
#     -e OPENSKY_CLIENT_ID=... -e OPENSKY_CLIENT_SECRET=... \
#     -e ACCESS_TOKEN=some-long-random-string \
#     -v skytrace-cache:/app/.cache skytrace

# Any HTTP answer means the process is alive - a private instance answers 401,
# which is healthy, not broken.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
