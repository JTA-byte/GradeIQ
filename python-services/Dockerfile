# Standalone container for the GradeIQ Python data jobs -- useful for
# local testing or an alternative host. NOT wired into render.yaml, which
# uses Render's native Python runtime instead of this file; switch
# render.yaml's cron services to `runtime: docker` with
# `dockerfilePath: python-services/Dockerfile` if you'd rather deploy
# this image directly.
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --with-deps installs the OS-level shared libraries Chromium needs to
# run headless (this slim base image doesn't have them), in addition to
# the browser binary itself.
RUN playwright install --with-deps chromium

COPY . .

# Default entrypoint runs the pop-report scrape; override at `docker run`
# time for the other job, e.g.:
#   docker run <image> python -m jobs.nightly_price_scrape
CMD ["python", "-m", "jobs.nightly_pop_scrape"]
