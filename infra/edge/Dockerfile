# WheelsAI custom-domain edge: stock Caddy with the Caddyfile next to this file.
# Build from the repository root:
#   flyctl deploy --config infra/edge/fly.staging.toml --dockerfile infra/edge/Dockerfile --remote-only
#
# The tag is pinned so a rebuild cannot change TLS behaviour unnoticed. On-demand
# TLS with an `ask` endpoint needs 2.7 or later; `caddy validate` below fails the
# build if the Caddyfile no longer parses on the pinned version.
FROM caddy:2.10.2-alpine

COPY infra/edge/Caddyfile /etc/caddy/Caddyfile

# Placeholder values only: validation resolves {$VAR} at parse time and none of
# these reach the image's environment.
RUN ACME_EMAIL=build@example.invalid \
    CUSTOM_DOMAIN_ASK_TOKEN=build-time-placeholder-ask-token-000000 \
    CUSTOM_DOMAIN_EDGE_SECRET=build-time-placeholder-edge-secret-0000 \
    WHEELS_API_INTERNAL=http://127.0.0.1:4000 \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# Certificates, their private keys and the ACME account live in /data. Mount a
# volume there (fly.toml [[mounts]]): without one every deploy re-requests every
# certificate, and the certificate authority allows 5 per name per week.
VOLUME /data

EXPOSE 80 443
