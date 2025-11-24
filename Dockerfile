# ---- Base Image ----
FROM node:18-alpine

# ---- Create App Directory ----
WORKDIR /app

# ---- Install Dependencies ----
COPY package*.json ./
RUN npm install --production

# ---- Copy Source Code ----
COPY . .

# ---- Expose the Port Railway Will Use ----
EXPOSE 3000

# ---- Start the Backend ----
CMD ["node", "index.js"]
