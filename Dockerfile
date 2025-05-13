# FROM repo-dev.htsc/public-cncp-image-base-local/node:20 AS builder
FROM node:22-alpine3.20

WORKDIR /app

COPY package.json yarn.lock .npmrc ./

RUN yarn

COPY . .

ENV NODE_ENV production
ENV PORT 8080

EXPOSE 8080

ENTRYPOINT ["node", "index.mjs"]
