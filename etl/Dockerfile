FROM rocker/r-base:4.4.0

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev libcurl4-openssl-dev libssl-dev libxml2-dev \
    && rm -rf /var/lib/apt/lists/*

RUN Rscript -e 'install.packages(c("fitzRoy", "readr"), repos = "https://cloud.r-project.org")' \
    && Rscript -e 'library(fitzRoy); library(readr)'

WORKDIR /app

COPY pyproject.toml uv.lock ./
COPY src/ src/
COPY etl/ etl/

RUN uv sync --no-cache --frozen

ENV PATH="/app/.venv/bin:$PATH"

CMD ["sh", "-c", "Rscript etl/extract.R $(date +%Y) && afl-mcp db migrate && afl-mcp db load --data-dir data/raw"]
