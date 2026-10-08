FROM oven/bun:1.4.2-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/var/data/freeland.sqlite

# There are no third-party runtime dependencies. Never copy the repository
# wholesale: it contains historical databases that are not deployment inputs.
USER root
RUN mkdir -p /var/data && chown bun:bun /var/data && chmod 0700 /var/data
COPY package.json server.js security.js storage.js index.html ./
USER bun

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD bun -e 'fetch(`http://127.0.0.1:${process.env.PORT || 3000}/healthz`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

# Private permissions apply to newly created SQLite database and WAL files.
# exec forwards stop signals to Bun instead of retaining a shell as PID 1.
CMD ["sh", "-c", "umask 077; exec bun server.js"]
