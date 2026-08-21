# ---- Stage 1: Build ----
FROM node:20-alpine AS builder

WORKDIR /app

# Copy only package files first — Docker caches this layer,
# so dependencies won't reinstall unless package.json actually changes
COPY package*.json ./
RUN npm ci

# Now copy the rest of the source and compile TS -> JS
COPY . .
RUN npm run build

# ---- Stage 2: Production ----
FROM node:20-alpine AS production

WORKDIR /app

# Only install production dependencies (skip devDependencies like ts-node-dev, typescript)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy only the compiled output from the builder stage — no source, no dev tools
COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/server.js"]