FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
# Copy the whole source tree, not a flat glob: server.js imports modules in
# subdirectories (backends/, stores/) too, and `COPY *.js` silently omits those —
# which broke the image after the ports refactor (ERR_MODULE_NOT_FOUND on
# backends/backend-factory.js). .dockerignore excludes node_modules and *.test.js,
# so this stays lean while being robust to new subdirectories.
COPY . ./
EXPOSE 3001
CMD ["node", "server.js"]
