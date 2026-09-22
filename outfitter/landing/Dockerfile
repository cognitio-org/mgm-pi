# kernal.one landing page: static files behind nginx, for Cloud Run (deploy/landing.sh).
# Pinned by digest (the 1.29-alpine multi-arch index as of 2026-09-22) so a rebuild can't silently
# pick up a different image; bump both together.
FROM nginx:1.31-alpine@sha256:62ff2089abf5a9ed33bd232895bef5e22f7bb4b200675cec49a5ebc48e3d4ac8
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY public/ /usr/share/nginx/html/
# Fail the build, not the deploy, on a bad config.
RUN nginx -t
EXPOSE 8080
