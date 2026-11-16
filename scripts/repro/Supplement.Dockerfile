ARG PNV_R_IMAGE=pnv-frozen-r:9bb30adcf4fe
FROM ${PNV_R_IMAGE}
WORKDIR /opt/pnv
RUN set -eu; \
    case "$(uname -m)" in \
      aarch64) node_arch=arm64; node_sha=024740906d9af0b9c9fe1a2843447c9eae5dc8cb44d2c5391c2bdf2afccb2bf1 ;; \
      x86_64) node_arch=x64; node_sha=f0a38698e3a49105f7323b6bda8f70d864ce853da17c6260a5e1798234d0f87d ;; \
      *) exit 2 ;; \
    esac; \
    curl -fsSL --retry 2 --max-time 300 "https://nodejs.org/dist/v25.8.0/node-v25.8.0-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
    echo "${node_sha}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; rm /tmp/node.tar.xz; \
    if [ ! -x /usr/bin/time ]; then apt-get update && apt-get install -y --no-install-recommends time && rm -rf /var/lib/apt/lists/*; fi; \
    npm ci --no-audit --no-fund; \
    node --version; npm --version; python3 --version

# The PD release session used these optional data.table gzip-reader dependencies.
RUN set -eu; \
    install_gzip_reader() { pkg="$1"; version="$2"; hash="$3"; tarball="${pkg}_${version}.tar.gz"; \
      curl -fsSL --retry 2 --max-time 120 "https://cloud.r-project.org/src/contrib/${tarball}" -o "/tmp/${tarball}" || \
        curl -fsSL --retry 2 --max-time 120 "https://cloud.r-project.org/src/contrib/Archive/${pkg}/${tarball}" -o "/tmp/${tarball}"; \
      echo "${hash}  /tmp/${tarball}" | sha256sum -c -; \
      R CMD INSTALL --library=/opt/pnv/.cache/R/library "/tmp/${tarball}"; rm "/tmp/${tarball}"; }; \
    install_gzip_reader R.methodsS3 1.8.2 822d5e61dad4c91e8883be2b38d7b89f87492046d0fe345704eb5d2658927c2e; \
    install_gzip_reader R.oo 1.27.1 5faf599cc1f027d8b80e1270aa6a43e29dccd6fee8287953f13e7ab3d94270f5; \
    install_gzip_reader R.utils 2.13.0 ab2043c34e129928ff85a037ce7a3f7791f245f49a55ee9a95bd7df0813bcf25
