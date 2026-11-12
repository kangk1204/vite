ARG PNV_ANALYSIS_IMAGE=pnv-linux-replay:9bb30adcf4fe
FROM ${PNV_ANALYSIS_IMAGE}
WORKDIR /opt/pnv
RUN ./node_modules/.bin/playwright install --with-deps --only-shell chromium
