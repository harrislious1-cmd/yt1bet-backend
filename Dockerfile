FROM python:3.11-slim
# Install Node.js and ffmpeg
RUN apt-get update && apt-get install -y \
    nodejs \
    npm \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*
# Always install latest yt-dlp on every deploy
RUN pip install -U yt-dlp
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Auto-update yt-dlp on startup then run server
CMD pip install -U yt-dlp && node server.js
