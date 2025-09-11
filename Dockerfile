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

RUN chmod +x entrypoint.sh

# Create crontab entry to run cleanup.mjs at 0:00 AM daily
RUN echo "0 0 * * * /usr/local/bin/node /app/scripts/cleanup.mjs >> /app/cleanup-log.txt 2>&1" > /etc/cron.d/cleanup-cron
RUN chmod 0644 /etc/cron.d/cleanup-cron
RUN crontab /etc/cron.d/cleanup-cron

ENV NODE_ENV=production
ENV PORT=8080

# Clue: https://github.com/hardkoded/puppeteer-sharp/issues/2633#issuecomment-2107557005
ENV XDG_CONFIG_HOME=/tmp/.chromium
ENV XDG_CACHE_HOME=/tmp/.chromium

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
