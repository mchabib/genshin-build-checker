FROM node:20-alpine

WORKDIR /app

# deps dulu biar cache layer efektif
COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 4000

CMD ["npm", "run", "dev"]
