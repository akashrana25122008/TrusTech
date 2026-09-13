FROM node:20-alpine AS extension-build

WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# The build pipeline needs the content-script config, the icons generator
# and the verify script in addition to the app sources.
COPY extension/ extension/
COPY tsconfig.json vite.config.ts vite.content.config.ts ./
COPY build/ build/
COPY tools/ tools/
RUN npm run build

FROM caddy:2.9-alpine AS caddy

WORKDIR /srv
COPY --from=extension-build /srv/dist/ /srv/www/
COPY docker/Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]