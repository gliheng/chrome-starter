FROM node:22-alpine3.20 AS base

RUN apk update
RUN apk add --no-cache chromium dbus
RUN apk add --no-cache fontconfig font-wqy-zenhei font-noto-cjk
RUN fc-cache -fv


FROM base

WORKDIR /app

RUN addgroup -g 500 appgroup
RUN adduser -u 500 -S appuser -G appgroup

COPY package.json yarn.lock ./

RUN yarn

COPY . .

RUN chmod +x entrypoint.sh


ENV NODE_ENV production
ENV PORT 8080

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
