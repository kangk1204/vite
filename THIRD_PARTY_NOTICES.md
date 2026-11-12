# Third-party software and reference data

The original Pathway Network Viewer source is distributed under the MIT license. The following libraries and reference assets retain their upstream terms.

| Library | Version | Upstream license | Included notice |
|---|---|---|---|
| cytoscape | 3.33.1 | MIT | [Text](vendor/licenses/cytoscape.txt) |
| cytoscape-svg | 0.4.0 | GNU GPLv3 | [Text](vendor/licenses/cytoscape-svg.txt) |
| cytoscape-fcose | 2.2.0 | MIT | [Text](vendor/licenses/cytoscape-fcose.txt) |
| cytoscape-elk | 2.3.0 | MIT | [Text](vendor/licenses/cytoscape-elk.txt) |
| cose-base | 2.2.0 | MIT | [Text](vendor/licenses/cose-base.txt) |
| layout-base | 2.0.1 | MIT | [Text](vendor/licenses/layout-base.txt) |
| elkjs | 0.11.1 | EPL-2.0 | [Text](vendor/licenses/elkjs.txt) |
| jspdf | 4.2.1 | MIT | [Text](vendor/licenses/jspdf.txt) |
| svg2pdf.js | 2.7.0 | MIT | [Text](vendor/licenses/svg2pdf.js.txt) |
| plotly.js-dist-min | 3.4.0 | MIT | [Text](vendor/licenses/plotly.js-dist-min.txt) |
| xlsx | 0.20.3 | Apache-2.0 | [Text](vendor/licenses/xlsx.txt) |

The exact cytoscape-svg and embedded canvas2svg source archives and their SHA-256 digests are included in [corresponding source](vendor/source/README.md).

Source and distribution locations for bundled libraries are recorded by version and integrity in `package-lock.json`. cytoscape-svg source is available at https://github.com/kinimesi/cytoscape-svg and elkjs at https://github.com/kieler/elkjs.

Frozen reference data and their source URLs are documented in `scripts/build_reference.py` and `data/reference/manifest.json`. Consult the [Reactome license](https://reactome.org/license), [HGNC](https://www.genenames.org/), [STRING](https://string-db.org/) and [HuRI](https://www.interactome-atlas.org/) records for the respective datasets. Public GEO files carry their original study attribution.
