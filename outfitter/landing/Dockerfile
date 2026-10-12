# kernal.one landing page: static files behind nginx, for Cloud Run (deploy/landing.sh).
# Pinned by digest (the 1.29-alpine multi-arch index as of 2026-09-22) so a rebuild can't silently
# pick up a different image; bump both together.
FROM nginx:1.31-alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY public/ /usr/share/nginx/html/
# Fail the build, not the deploy, on a bad config.
RUN nginx -t
EXPOSE 8080
