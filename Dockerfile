FROM node:22-alpine3.20 AS base

RUN apk add chromium


FROM base

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn

COPY . .

ENV NODE_ENV production
ENV PORT 8080

EXPOSE 8080

ENTRYPOINT ["node", "index.mjs"]
