#!/usr/bin/env bash
set -euo pipefail
if [ "$#" != 2 ]; then
  echo 'Usage: bash launch.sh NEW_OUTPUT_DIRECTORY same-host-technical|independent-operator' >&2
  exit 2
fi
kit=$(cd "$(dirname "$0")" && pwd -P)
out=$(python3 -c 'import os,sys;print(os.path.abspath(sys.argv[1]))' "$1")
role=$2
case "$role" in same-host-technical|independent-operator) ;; *) exit 2 ;; esac
engine=${CONTAINER_ENGINE:-docker}
if [ -e "$out" ]; then echo 'Choose a fresh output directory.' >&2; exit 2; fi
mkdir -p "$out/audit" "$out/publication"
python3 - "$kit" "$out" <<'PY'
import hashlib,json,sys,urllib.request as u
from pathlib import Path
kit,out=map(Path,sys.argv[1:]); spec=json.loads((kit/'supplement/selection.json').read_text())
fingerprints=json.loads((kit/'kit-manifest.json').read_text())['files']
for key,expected in fingerprints.items():
    p=(kit/key).resolve()
    if not p.is_relative_to(kit) or hashlib.sha256(p.read_bytes()).hexdigest()!=expected:
        raise SystemExit(f'Kit digest mismatch: {key}')
repo='bioconductor/bioconductor_docker';ref=spec['baseImage'].split('@')[1]
token=json.load(u.urlopen('https://auth.docker.io/token?service=registry.docker.io&scope=repository:'+repo+':pull',timeout=30))['token']
headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'}
def manifest(digest):
    payload=u.urlopen(u.Request('https://registry-1.docker.io/v2/'+repo+'/manifests/'+digest,headers=headers),timeout=30).read()
    if 'sha256:'+hashlib.sha256(payload).hexdigest()!=digest: raise SystemExit('OCI digest mismatch')
    return json.loads(payload)
index=manifest(ref);children={}
for entry in index['manifests']:
    platform='/'.join(entry['platform'].get(k,'') for k in ('os','architecture'))
    if platform in spec['platformDigests']:
        if spec['platformDigests'][platform]!=entry['digest']: raise SystemExit('Architecture digest mismatch')
        detail=manifest(entry['digest']);children[platform]={'digest':entry['digest'],'compressedBytes':sum(x['size'] for x in detail['layers'])}
if set(children)!=set(spec['platformDigests']): raise SystemExit('Missing architecture manifest')
(out/'oci-manifest.json').write_text(json.dumps({'index':ref,'children':children},indent=2)+'\n')
PY
"$engine" version > "$out/container-engine.txt" 2>&1
snapshot=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sourceSnapshot"][:12])' "$kit/supplement/selection.json")
base="pnv-frozen-r:$snapshot"
image="pnv-linux-replay:$snapshot"
date -u +%FT%TZ > "$out/build-started-utc.txt"
"$engine" build --progress=plain -t "$base" "$kit/project" > "$out/build-r.log" 2>&1
"$engine" build --progress=plain -f "$kit/Supplement.Dockerfile" --build-arg "PNV_R_IMAGE=$base" -t "$image" "$kit/project" > "$out/build-tools.log" 2>&1
date -u +%FT%TZ > "$out/build-ended-utc.txt"
image_id=$("$engine" image inspect --format '{{.Id}}' "$image")
echo "$image_id" > "$out/analysis-image-id.txt"
"$engine" run --rm --network=none --cpus="${PNV_LINUX_CPUS:-6}" --memory="${PNV_LINUX_MEMORY:-9g}" \
  -e "PNV_ANALYSIS_IMAGE_ID=$image_id" -e OPENBLAS_NUM_THREADS=1 -e OMP_NUM_THREADS=1 \
  -v "$kit/supplement:/replay:ro" -v "$out/audit:/audit" -v "$out/publication:/opt/pnv/paper/outputs" \
  --entrypoint python3 "$image" /replay/execute.py --role "$role"
bash "$kit/browser_qa.sh" "$kit" "$out"
