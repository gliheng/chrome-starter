FROM node:22-alpine3.20 AS base

RUN apk update
RUN apk add --no-cache chromium
RUN apk add --no-cache fontconfig font-wqy-zenhei font-noto-cjk
RUN fc-cache -fv

FROM base

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn

COPY . .

ENV NODE_ENV production
ENV PORT 8080

EXPOSE 8080

ENTRYPOINT ["node", "index.mjs"]
