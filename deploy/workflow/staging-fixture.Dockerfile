FROM node:22-bookworm-slim
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY test/fixtures/staging-target.mjs /app/test/fixtures/staging-target.mjs
COPY deploy/workflow/staging-fixture.mjs /app/deploy/workflow/staging-fixture.mjs
USER node
VOLUME /data
CMD ["node", "--no-warnings", "/app/deploy/workflow/staging-fixture.mjs"]
