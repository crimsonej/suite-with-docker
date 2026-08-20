FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm install --legacy-peer-deps --production

COPY . .

RUN chmod +x setup.sh installer.js

ENV NODE_ENV=production
ENV DNS_SERVERS=8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1

CMD ["npm", "start"]