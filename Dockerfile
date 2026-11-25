# Node 22 to match .nvmrc and package.json engines (>=22): @simplewebauthn/server
# needs Node 22's WebCrypto globals (globalThis.SubtleCrypto); on 18 every
# passkey request fails with "Cannot read properties of undefined (reading 'supports')"
FROM node:22.12-alpine

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    postgresql-client \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package.json ./

# Install all dependencies (including dev deps for build)
RUN npm install && npm cache clean --force

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Change ownership of the app directory
RUN chown -R nestjs:nodejs /app
USER nestjs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health/simple', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start command - the app applies pending migrations itself on startup
CMD ["npm", "run", "start:prod"]