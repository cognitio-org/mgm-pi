# kernal.one landing page: static files behind nginx, for Cloud Run (deploy/landing.sh).
# Pinned by digest (the 1.29-alpine multi-arch index as of 2026-09-22) so a rebuild can't silently
# pick up a different image; bump both together.
FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY public/ /usr/share/nginx/html/
# Fail the build, not the deploy, on a bad config.
RUN nginx -t
EXPOSE 8080
