FROM rocker/r-base:4.4.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    libpq-dev libcurl4-openssl-dev libssl-dev libxml2-dev \
    && rm -rf /var/lib/apt/lists/*

RUN Rscript -e 'install.packages(c("fitzRoy", "readr"), repos = "https://cloud.r-project.org")'

WORKDIR /app

COPY pyproject.toml .
COPY src/ src/
COPY etl/ etl/

RUN pip install --no-cache-dir --break-system-packages .

CMD ["sh", "-c", "Rscript etl/extract.R $(date +%Y) && afl-mcp db migrate && afl-mcp db load --data-dir data/raw"]
