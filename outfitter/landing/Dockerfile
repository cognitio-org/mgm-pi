# kernal.one landing page: static files behind nginx, for Cloud Run (deploy/landing.sh).
FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY public/ /usr/share/nginx/html/
# Fail the build, not the deploy, on a bad config.
RUN nginx -t
EXPOSE 8080
