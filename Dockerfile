# Resolved from Docker Hub on 2026-11-10. Both platforms match renv.lock's R 4.5.1.
FROM bioconductor/bioconductor_docker:RELEASE_3_22-R-4.5.1@sha256:25e5beb01fe01975c815161f0a2484a4edc8f8585229c3bbc026f46bec10870c

WORKDIR /opt/pnv
COPY renv.lock scripts/restore_analysis_env.R ./
RUN Rscript -e 'stopifnot(as.character(getRversion()) == "4.5.1")' \
    && Rscript restore_analysis_env.R
COPY . .
ENTRYPOINT ["Rscript", "scripts/run_local_analysis.R"]
