# Public offline reviewer package

The public entry point is `paper/outputs/publication_v2/reviewer/index.html`. `reviewer-package.json` in the same directory identifies the current downloadable ZIP and its SHA-256 digest. A recipient can extract the ZIP and open `index.html` in a browser.

`node scripts/build_reviewer_portal.mjs` builds the pages, focused report and ZIP from the frozen cohort results, current manuscript figures and `release/source-snapshot.json`. After updating source files, refresh the public source snapshot with `python3 scripts/package_source.py`, regenerate the reviewer package and run `node tests/e2e/reviewer-portal.mjs`. The builder checks source and output hashes before replacing the previous generated package.

The walkthrough uses the published Parkinson disease BA9 dataset and pathway R-HSA-449147. Both the selection frequency and adjusted P-values come from the recorded analyses. The focused example retains the original gene ranking and tested family. Its verification panel describes the excerpt. The full Parkinson report includes the original supplied-artifact checks. The reviewer ZIP provides the original public GEO inputs for this cohort, full quantitative result tables for all five contexts and a versioned source snapshot.
