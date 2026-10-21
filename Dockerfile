# Imagen oficial de Bun. Solo dependencias de producción; la clave del modelo llega por variable de entorno.
FROM oven/bun:1 AS app
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY . .
RUN mkdir -p out && chown -R bun:bun /app/out
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", "src/server.ts"]
