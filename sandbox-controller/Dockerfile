FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
# Copy all source modules, not just server.js — it imports sibling modules
# (path-safety.js, multipart.js, sandbox-spec.js). *.test.js is excluded via
# .dockerignore so new modules can't silently drop out of the image again.
COPY *.js ./
EXPOSE 3001
CMD ["node", "server.js"]
