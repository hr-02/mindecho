# Small, fast-building image for Cloud Run
FROM node:20-slim

WORKDIR /app

# Install dependencies first so this layer is cached when only source changes
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Cloud Run injects PORT at runtime; 8080 is the conventional default
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
