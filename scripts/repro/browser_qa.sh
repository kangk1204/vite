#!/usr/bin/env bash
set -euo pipefail
if [ "$#" != 2 ]; then echo 'Usage: browser_qa.sh KIT_DIRECTORY COMPLETED_RUN_DIRECTORY' >&2; exit 2; fi
kit=$(cd "$1" && pwd -P); out=$(cd "$2" && pwd -P); script_dir=$(cd "$(dirname "$0")" && pwd -P)
engine=${CONTAINER_ENGINE:-docker}; qa="$out/linux-browser"
if [ -e "$qa" ]; then echo 'Use a fresh browser evidence directory.' >&2; exit 2; fi
snapshot=$(python3 - "$kit" "$out" <<'PY'
from pathlib import Path
import json,sys
kit,out=map(Path,sys.argv[1:]); status=json.loads((out/'audit/status.json').read_text())
if status['status']!='completed':raise SystemExit('Complete the cold/cached replay before browser QA')
print(json.loads((kit/'supplement/selection.json').read_text())['sourceSnapshot'][:12])
PY
)
mkdir -p "$qa/artifacts"
image="pnv-linux-replay:$snapshot"; browser="pnv-offline-browser:$snapshot"
date -u +%FT%TZ > "$qa/build-started-utc.txt"
"$engine" build --progress=plain -f "$script_dir/Browser.Dockerfile" --build-arg "PNV_ANALYSIS_IMAGE=$image" \
  -t "$browser" "$kit/project" > "$qa/build.log" 2>&1
date -u +%FT%TZ > "$qa/build-ended-utc.txt"
"$engine" image inspect --format '{{.Id}}' "$browser" > "$qa/browser-image-id.txt"
"$engine" run --rm --network=none --shm-size=2g --memory="${PNV_LINUX_MEMORY:-9g}" \
  -v "$out/publication:/opt/pnv/paper/outputs:ro" \
  -v "$kit/supplement/linux-replay.json:/opt/pnv/paper/manifests/publication_v2.json:ro" \
  -v "$qa/artifacts:/opt/pnv/.cache/verification/publication-browser" -v "$qa:/linux-proof" \
  --entrypoint bash "$browser" -c 'set -eu; /usr/bin/time -v -o /linux-proof/browser-time.txt timeout 900 node tests/e2e/publication-reports.mjs; node --input-type=module -e "import {chromium} from '\''playwright'\''; const b=await chromium.launch(); console.log(b.version()); await b.close()" > /linux-proof/chromium-version.txt' > "$qa/browser.log" 2>&1
python3 - "$qa" "$kit" <<'PY'
import hashlib,json,struct,sys,xml.etree.ElementTree as ET
from pathlib import Path
qa,kit=map(Path,sys.argv[1:]); primary=json.loads((kit/'supplement/linux-replay.json').read_text())['primaryCohortKey']
directory=qa/'artifacts'; checked=json.loads((directory/'verification.json').read_text()); exports={}
if not checked['passed'] or len(checked['checks'])!=4 or any(c['remoteRequests'] or c['pageErrors'] for c in checked['checks']):raise SystemExit('Offline report checks failed')
for fmt in ['svg','png','pdf']:
    p=directory/f'{primary}.{fmt}';data=p.read_bytes();details={}
    if fmt=='png':
        assert data[:8]==b'\x89PNG\r\n\x1a\n'; details['dimensions']=struct.unpack('>II',data[16:24])
    if fmt=='pdf': assert data[:5]==b'%PDF-' and b'%%EOF' in data[-2048:]
    if fmt=='svg': assert ET.fromstring(data).tag.rsplit('}',1)[-1]=='svg'
    assert len(data)>100
    exports[fmt]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),**details}
result={'status':'pass','platform':'Linux','containerNetwork':'none','chromium':(qa/'chromium-version.txt').read_text().strip(),'imageId':(qa/'browser-image-id.txt').read_text().strip(),'checks':checked['checks'],'exports':exports}
(qa/'browser-verification.json').write_text(json.dumps(result,indent=2)+'\n'); print('Opened four offline reports and verified SVG, PNG and PDF exports.')
PY
